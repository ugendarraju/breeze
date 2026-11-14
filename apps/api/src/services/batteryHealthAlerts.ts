// fork: alert the technician when a laptop's battery health drops below 50%.
//
// Breeze alert rules cannot watch custom fields (conditions are metric /
// offline / event_log), so this runs where the battery script's values land:
// customFields/scriptWriteBack.ts calls it right after persisting a write-back
// that carries both capacities. Pattern follows warrantyAlertEvaluator.ts:
// a rule-less alert through createSourcedAlert (so notifications, escalation
// and automations see it), deduped on configItemName per device, auto-resolved
// when health recovers (e.g. after a battery replacement), and a dismissal is
// respected - the technician said "I know".
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { alerts } from '../db/schema';
import { createSourcedAlert, resolveAlert } from './alertService';
import { BATTERY_FIELD_KEYS } from './batteryHealthScript';

export const BATTERY_HEALTH_ALERT_THRESHOLD = 50;
export const BATTERY_ALERT_CONFIG_ITEM = 'battery_health';

type FieldWrite = { fieldKey: string; value: string | number | boolean | null };

/** Full-charge capacity as a share of design capacity, capped at 100; null when unknown. */
export function batteryHealthPercent(designMwh: unknown, fullMwh: unknown): number | null {
  if (typeof designMwh !== 'number' || typeof fullMwh !== 'number' || designMwh <= 0 || fullMwh <= 0) return null;
  return Math.min(100, Math.round((fullMwh / designMwh) * 100));
}

export function batteryAlertSeverity(healthPercent: number): 'high' | 'medium' {
  return healthPercent < 30 ? 'high' : 'medium';
}

/**
 * The write-back hook (customFields/scriptWriteBack.ts). Does nothing unless a
 * battery field was written. Runs in its own savepoint with the catch OUTSIDE
 * it, so an alert failure can never cost the custom-field write itself
 * (docs/agents/tenancy-rls.md, "A catch around a query needs withDbTransaction").
 */
export async function evaluateBatteryHealthAlertSafely(
  device: { id: string; orgId: string; hostname?: string | null; displayName?: string | null },
  writes: readonly FieldWrite[],
): Promise<void> {
  const batteryKeys: readonly string[] = [BATTERY_FIELD_KEYS.design, BATTERY_FIELD_KEYS.full];
  if (!writes.some((w) => batteryKeys.includes(w.fieldKey))) return;
  await withDbTransaction(() => evaluateBatteryHealthAlert(device, writes)).catch((err) => {
    console.error('[battery-health] alert evaluation failed (custom fields were still saved):', err instanceof Error ? err.message : err);
  });
}

export async function evaluateBatteryHealthAlert(
  device: { id: string; orgId: string; hostname?: string | null; displayName?: string | null },
  writes: readonly FieldWrite[],
): Promise<void> {
  const valueOf = (key: string) => writes.find((w) => w.fieldKey === key)?.value;
  const designMwh = valueOf(BATTERY_FIELD_KEYS.design);
  const fullMwh = valueOf(BATTERY_FIELD_KEYS.full);
  const health = batteryHealthPercent(designMwh, fullMwh);
  if (health === null) return;

  const existing = await db
    .select({ id: alerts.id, status: alerts.status })
    .from(alerts)
    .where(and(
      eq(alerts.deviceId, device.id),
      eq(alerts.configItemName, BATTERY_ALERT_CONFIG_ITEM),
      inArray(alerts.status, ['active', 'acknowledged', 'suppressed', 'dismissed']),
    ));

  if (health >= BATTERY_HEALTH_ALERT_THRESHOLD) {
    for (const alert of existing) {
      if (alert.status === 'active' || alert.status === 'acknowledged') {
        await resolveAlert(alert.id, `Battery health is back to ${health}%`, undefined, false, 'condition_cleared');
      }
    }
    return;
  }

  // Already alerted (open, muted, or dismissed by the technician): nothing new to say.
  if (existing.length > 0) return;

  const name = device.displayName ?? device.hostname ?? 'This device';
  await createSourcedAlert({
    deviceId: device.id,
    orgId: device.orgId,
    severity: batteryAlertSeverity(health),
    title: `Battery health low (${health}%)`,
    message:
      `${name}'s battery holds ${health}% of its original capacity ` +
      `(${fullMwh} of ${designMwh} mWh). Consider replacing the battery.`,
    context: {
      source: 'battery_health',
      healthPercent: health,
      designCapacityMwh: designMwh,
      fullChargeCapacityMwh: fullMwh,
      thresholdPercent: BATTERY_HEALTH_ALERT_THRESHOLD,
    },
    configItemName: BATTERY_ALERT_CONFIG_ITEM,
    publisher: 'battery-health',
  });
}
