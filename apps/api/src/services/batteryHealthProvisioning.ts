// fork: give every partner (technician) the battery-health custom fields and a
// daily partner-wide automation that runs the "Battery Health (Windows)" system
// script on its Windows devices. Runs at API boot and hourly so new signups are
// covered within the hour. Each partner is provisioned ONCE (remembered in the
// Redis set below), so a technician who deletes the automation or a field keeps
// it deleted. A transaction-scoped advisory lock keeps two API replicas from
// provisioning concurrently (there is no unique key to lean on).
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { automations, customFieldDefinitions, partners, scripts } from '../db/schema';
import { BATTERY_FIELD_KEYS, BATTERY_HEALTH_SCRIPTS_BY_OS } from './batteryHealthScript';
import { getRedis } from './redis';
import { BATTERY_HEALTH_ALERT_THRESHOLD } from './batteryHealthAlerts';

type BatteryOs = (typeof BATTERY_HEALTH_SCRIPTS_BY_OS)[number]['osType'];
const OS_LABEL: Record<BatteryOs, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
export const batteryAutomationName = (osType: BatteryOs) => `Battery health (monthly, ${OS_LABEL[osType]})`;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const PROVISIONED_SET_KEY = 'fork:battery-health:provisioned-partners';

export const BATTERY_FIELD_DEFINITIONS = [
  { fieldKey: BATTERY_FIELD_KEYS.design, name: 'Battery design capacity (mWh)' },
  { fieldKey: BATTERY_FIELD_KEYS.full, name: 'Battery full charge capacity (mWh)' },
  { fieldKey: BATTERY_FIELD_KEYS.cycles, name: 'Battery charge cycles' },
] as const;

export function batteryAutomationValues(partnerId: string, scriptId: string, osType: BatteryOs) {
  return {
    partnerId,
    orgId: null,
    name: batteryAutomationName(osType),
    description: `Reads laptop battery health once a month on ${OS_LABEL[osType]} devices (shown in the device Power section; alerts below ${BATTERY_HEALTH_ALERT_THRESHOLD}%). Devices without a battery are skipped by the script.`,
    enabled: true,
    // 1st of each month, 12:00 UTC: during working hours in most of the world.
    trigger: { type: 'schedule', cron: '0 12 1 * *', timezone: 'UTC' },
    // Each OS's script runs only on that OS: the OS check happens at targeting.
    conditions: {
      type: 'filter',
      filter: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: osType }] },
    },
    // Monthly: a laptop that is off at 12:00 on the 1st gets it when it next checks in.
    actions: [{ type: 'run_script', scriptId, runAs: 'system', whenOffline: 'queue' }],
  };
}

export async function provisionBatteryHealthForAllPartners(): Promise<{ partners: number; fields: number; automations: number }> {
  const result = { partners: 0, fields: 0, automations: 0 };
  const redis = getRedis();
  if (!redis) return result; // without the memory of who is done, do nothing
  const done = new Set(await redis.smembers(PROVISIONED_SET_KEY));

  const { scriptIdByOs, live } = await withSystemDbAccessContext(async () => {
    const systemScripts = await db
      .select({ id: scripts.id, name: scripts.name })
      .from(scripts)
      .where(and(
        inArray(scripts.name, BATTERY_HEALTH_SCRIPTS_BY_OS.map((s) => s.script.name)),
        eq(scripts.isSystem, true),
        isNull(scripts.deletedAt),
      ));
    const live = await db
      .select({ id: partners.id })
      .from(partners)
      .where(and(isNull(partners.deletedAt), inArray(partners.status, ['pending', 'active'])));
    return {
      live,
      scriptIdByOs: BATTERY_HEALTH_SCRIPTS_BY_OS.flatMap(({ osType, script }) => {
        const row = systemScripts.find((s) => s.name === script.name);
        return row ? [{ osType, scriptId: row.id }] : [];
      }),
    };
  });
  // System library not ensured yet; the next tick retries.
  if (scriptIdByOs.length !== BATTERY_HEALTH_SCRIPTS_BY_OS.length) return result;

  // One transaction per partner: Breeze's export lock hierarchy forbids taking
  // a partner lock after an organization lock in the same transaction, and a
  // partner-wide automation insert takes organization locks.
  for (const { id: partnerId } of live) {
    if (done.has(partnerId)) continue;
    const provisioned = await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [{ locked }] = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`fork:battery-health:${partnerId}`})) AS locked`,
      )) as unknown as Array<{ locked: boolean }>;
      if (!locked) return false; // another API replica is on this partner right now
      {
        const existingKeys = new Set(
          (
            await tx
              .select({ fieldKey: customFieldDefinitions.fieldKey })
              .from(customFieldDefinitions)
              .where(and(eq(customFieldDefinitions.partnerId, partnerId), isNull(customFieldDefinitions.orgId)))
          ).map((row) => row.fieldKey),
        );
        const missing = BATTERY_FIELD_DEFINITIONS.filter((def) => !existingKeys.has(def.fieldKey));
        if (missing.length > 0) {
          await tx.insert(customFieldDefinitions).values(
            missing.map((def) => ({
              partnerId,
              orgId: null,
              name: def.name,
              fieldKey: def.fieldKey,
              type: 'number' as const,
              deviceTypes: ['windows', 'macos', 'linux'],
              scriptWrite: true,
            })),
          );
          result.fields += missing.length;
        }

        for (const { osType, scriptId } of scriptIdByOs) {
          const [automation] = await tx
            .select({ id: automations.id })
            .from(automations)
            .where(and(eq(automations.partnerId, partnerId), isNull(automations.orgId), eq(automations.name, batteryAutomationName(osType))))
            .limit(1);
          if (!automation) {
            await tx.insert(automations).values(batteryAutomationValues(partnerId, scriptId, osType));
            result.automations += 1;
          }
        }
      }
      return true;
    }));
    if (provisioned) {
      result.partners += 1;
      // Recorded only after this partner's transaction committed.
      await redis.sadd(PROVISIONED_SET_KEY, partnerId);
    }
  }
  return result;
}

async function reconcileOnce(): Promise<void> {
  try {
    const r = await provisionBatteryHealthForAllPartners();
    if (r.fields > 0 || r.automations > 0) {
      console.log(`[battery-health] provisioned ${r.fields} field(s) and ${r.automations} automation(s) across ${r.partners} partner(s)`);
    }
  } catch (err) {
    console.error('[battery-health] provisioning failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/** Call once at API boot, after the system script library is ensured. */
export function startBatteryHealthProvisioning(): void {
  void reconcileOnce();
  setInterval(() => void reconcileOnce(), RECONCILE_INTERVAL_MS).unref();
}
