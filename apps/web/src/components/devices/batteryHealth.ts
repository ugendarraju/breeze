// fork: battery health for the device Power section, read from the custom
// fields the "Battery Health (Windows)" system script writes (field keys must
// match apps/api/src/services/batteryHealthScript.ts BATTERY_FIELD_KEYS).

export const BATTERY_FIELD_KEYS = {
  design: 'battery_design_capacity_mwh',
  full: 'battery_full_charge_capacity_mwh',
  cycles: 'battery_cycle_count',
} as const;

export type BatteryHealth = {
  designMwh: number | null;
  fullMwh: number | null;
  cycles: number | null;
  /** Full-charge capacity as a share of design capacity, rounded; null when either is missing. */
  healthPercent: number | null;
};

function positive(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** null when the device has none of the battery-health fields. */
export function batteryHealthFromCustomFields(customFields: Record<string, unknown> | null | undefined): BatteryHealth | null {
  if (!customFields) return null;
  const designMwh = positive(customFields[BATTERY_FIELD_KEYS.design]);
  const fullMwh = positive(customFields[BATTERY_FIELD_KEYS.full]);
  const cycles = positive(customFields[BATTERY_FIELD_KEYS.cycles]);
  if (designMwh === null && fullMwh === null && cycles === null) return null;
  // A battery can briefly report slightly more than its design capacity when new; cap at 100%.
  const healthPercent =
    designMwh !== null && fullMwh !== null ? Math.min(100, Math.round((fullMwh / designMwh) * 100)) : null;
  return { designMwh, fullMwh, cycles, healthPercent };
}
