import { beforeEach, describe, expect, it, vi } from 'vitest';

const existingAlerts: Array<{ id: string; status: string }> = [];
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: async () => existingAlerts }) })),
  },
}));
vi.mock('../db/schema', () => ({
  alerts: { id: 'id', status: 'status', deviceId: 'device_id', configItemName: 'config_item_name' },
}));
vi.mock('./alertService', () => ({
  createSourcedAlert: vi.fn(async () => 'new-alert'),
  resolveAlert: vi.fn(async () => true),
}));

import { createSourcedAlert, resolveAlert } from './alertService';
import {
  BATTERY_ALERT_CONFIG_ITEM,
  batteryAlertSeverity,
  batteryHealthPercent,
  evaluateBatteryHealthAlert,
} from './batteryHealthAlerts';

const DEVICE = { id: 'dev-1', orgId: 'org-1', hostname: 'ASUS-ROG-STRIX-III', displayName: null };
const writes = (design: number, full: number) => [
  { fieldKey: 'battery_design_capacity_mwh', value: design },
  { fieldKey: 'battery_full_charge_capacity_mwh', value: full },
];

describe('battery health alerts (fork)', () => {
  beforeEach(() => {
    existingAlerts.length = 0;
    vi.clearAllMocks();
  });

  it('computes health and severity', () => {
    expect(batteryHealthPercent(66000, 52800)).toBe(80);
    expect(batteryHealthPercent(50000, 51000)).toBe(100);
    expect(batteryHealthPercent(0, 100)).toBeNull();
    expect(batteryHealthPercent('66000', 52800)).toBeNull();
    expect(batteryAlertSeverity(45)).toBe('medium');
    expect(batteryAlertSeverity(29)).toBe('high');
  });

  it('raises one alert on the device when health is below 50%', async () => {
    await evaluateBatteryHealthAlert(DEVICE, writes(66000, 29700)); // 45%
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSourcedAlert).mock.calls[0]?.[0]).toMatchObject({
      deviceId: 'dev-1',
      orgId: 'org-1',
      severity: 'medium',
      title: 'Battery health low (45%)',
      configItemName: BATTERY_ALERT_CONFIG_ITEM,
      context: { source: 'battery_health', healthPercent: 45 },
    });
  });

  it('marks a badly worn battery high severity', async () => {
    await evaluateBatteryHealthAlert(DEVICE, writes(66000, 13200)); // 20%
    expect(vi.mocked(createSourcedAlert).mock.calls[0]?.[0]).toMatchObject({ severity: 'high' });
  });

  it.each(['active', 'acknowledged', 'suppressed', 'dismissed'])(
    'does not duplicate when a %s battery alert already exists',
    async (status) => {
      existingAlerts.push({ id: 'a1', status });
      await evaluateBatteryHealthAlert(DEVICE, writes(66000, 29700));
      expect(createSourcedAlert).not.toHaveBeenCalled();
    },
  );

  it('auto-resolves open alerts once health is back to 50% or more (battery replaced)', async () => {
    existingAlerts.push({ id: 'open', status: 'active' }, { id: 'ack', status: 'acknowledged' }, { id: 'gone', status: 'dismissed' });
    await evaluateBatteryHealthAlert(DEVICE, writes(66000, 64000));
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(vi.mocked(resolveAlert).mock.calls.map((c) => c[0])).toEqual(['open', 'ack']);
    expect(vi.mocked(resolveAlert).mock.calls[0]?.[4]).toBe('condition_cleared');
  });

  it('ignores write-backs without both capacities', async () => {
    await evaluateBatteryHealthAlert(DEVICE, [{ fieldKey: 'battery_cycle_count', value: 300 }]);
    await evaluateBatteryHealthAlert(DEVICE, [{ fieldKey: 'asset_tag', value: 'X1' }]);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});
