import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: () => null }));

import {
  automationActionSchema,
  automationTriggerSchema,
  deploymentTargetConfigSchema,
} from '@breeze/shared';
import { BATTERY_FIELD_KEYS, BATTERY_HEALTH_SCRIPTS_BY_OS, FORK_SYSTEM_LIBRARY_SCRIPTS } from './batteryHealthScript';
import {
  BATTERY_FIELD_DEFINITIONS,
  batteryAutomationName,
  batteryAutomationValues,
  provisionBatteryHealthForAllPartners,
} from './batteryHealthProvisioning';
import { SYSTEM_LIBRARY_SCRIPTS } from './systemScriptLibrary';

const PARTNER = '11111111-1111-1111-1111-111111111111';
const SCRIPT = '22222222-2222-2222-2222-222222222222';

describe('battery health scripts (fork)', () => {
  it('ships one script per OS in the system script library, each limited to its OS', () => {
    expect(FORK_SYSTEM_LIBRARY_SCRIPTS.filter((s) => s.name.startsWith('Battery Health'))).toHaveLength(3);
    for (const { osType, script } of BATTERY_HEALTH_SCRIPTS_BY_OS) {
      expect(SYSTEM_LIBRARY_SCRIPTS).toContain(script);
      expect(script.osTypes).toEqual([osType]);
    }
    expect(new Set(FORK_SYSTEM_LIBRARY_SCRIPTS.map((s) => s.name)).size).toBe(FORK_SYSTEM_LIBRARY_SCRIPTS.length);
  });

  it('every script writes exactly the provisioned field keys through the write-back marker', () => {
    for (const { script } of BATTERY_HEALTH_SCRIPTS_BY_OS) {
      expect(script.content).toContain('::breeze:custom-fields::');
      for (const key of Object.values(BATTERY_FIELD_KEYS)) expect(script.content).toContain(key);
      // Every script ends cleanly when there is no battery.
      expect(script.content).toMatch(/no battery/i);
    }
    expect(BATTERY_FIELD_DEFINITIONS.map((d) => d.fieldKey).sort()).toEqual(Object.values(BATTERY_FIELD_KEYS).sort());
  });

  it('matches the web Power section keys', async () => {
    const web = await import('../../../web/src/components/devices/batteryHealth');
    expect(web.BATTERY_FIELD_KEYS).toEqual(BATTERY_FIELD_KEYS);
  });

  it('keeps the output sanitizer away from the marker (no secret-looking keys)', () => {
    for (const key of Object.values(BATTERY_FIELD_KEYS)) {
      expect(key).not.toMatch(/api_key|token|secret|password|credential/i);
    }
  });

  it.each(BATTERY_HEALTH_SCRIPTS_BY_OS.map((s) => s.osType))(
    'the %s automation targets only that OS and passes the shared validators',
    (osType) => {
      const values = batteryAutomationValues(PARTNER, SCRIPT, osType);
      expect(values.orgId).toBeNull();
      expect(values.name).toBe(batteryAutomationName(osType));
      expect(automationTriggerSchema.parse(values.trigger)).toMatchObject({ type: 'schedule', cron: '0 12 1 * *' });
      expect(values.actions[0]).toMatchObject({ whenOffline: 'queue' });
      for (const action of values.actions) expect(() => automationActionSchema.parse(action)).not.toThrow();
      const target = deploymentTargetConfigSchema.parse(values.conditions);
      expect(target.type).toBe('filter');
      expect(values.conditions.filter.conditions).toEqual([{ field: 'osType', operator: 'equals', value: osType }]);
    },
  );

  it('does nothing without Redis (it could not remember who is already provisioned)', async () => {
    expect(await provisionBatteryHealthForAllPartners()).toEqual({ partners: 0, fields: 0, automations: 0 });
  });
});
