import { describe, expect, it } from 'vitest';
import { batteryHealthFromCustomFields } from './batteryHealth';

describe('batteryHealthFromCustomFields', () => {
  it('computes health as full-charge over design capacity', () => {
    expect(
      batteryHealthFromCustomFields({
        battery_design_capacity_mwh: 66000,
        battery_full_charge_capacity_mwh: 52800,
        battery_cycle_count: 312,
      }),
    ).toEqual({ designMwh: 66000, fullMwh: 52800, cycles: 312, healthPercent: 80 });
  });

  it('returns null for a device without battery-health fields (desktop, or script not run yet)', () => {
    expect(batteryHealthFromCustomFields({ asset_tag: 'X1' })).toBeNull();
    expect(batteryHealthFromCustomFields(undefined)).toBeNull();
  });

  it('has no health % when one capacity is missing, but still shows what it has', () => {
    expect(batteryHealthFromCustomFields({ battery_design_capacity_mwh: 66000 })).toEqual({
      designMwh: 66000, fullMwh: null, cycles: null, healthPercent: null,
    });
  });

  it('caps a new battery that reports above its design capacity at 100%', () => {
    expect(
      batteryHealthFromCustomFields({ battery_design_capacity_mwh: 50000, battery_full_charge_capacity_mwh: 51000 })
        ?.healthPercent,
    ).toBe(100);
  });

  it('ignores zero, negative and non-numeric values', () => {
    expect(
      batteryHealthFromCustomFields({ battery_design_capacity_mwh: 0, battery_full_charge_capacity_mwh: 'abc', battery_cycle_count: -1 }),
    ).toBeNull();
    expect(batteryHealthFromCustomFields({ battery_design_capacity_mwh: '48000' })?.designMwh).toBe(48000);
  });
});
