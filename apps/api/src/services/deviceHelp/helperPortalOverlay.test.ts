// fork: tray "Open Breeze Portal" opens the device's Get help form.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./helpLinkToken', () => ({
  getHelpLinkState: vi.fn(),
  mintHelpToken: vi.fn((id: string, v: number) => `tok-${id.slice(0, 4)}-${v}`),
  helpLinkUrl: vi.fn((t: string) => `https://breeze.example/help#${t}`),
}));

import { withDeviceHelpPortal } from './helperPortalOverlay';
import { getHelpLinkState } from './helpLinkToken';
import type { HelperSettings } from '../helperSettings';

const stateMock = vi.mocked(getHelpLinkState);
const DEVICE = '11111111-1111-4111-8111-111111111111';
const BASE: HelperSettings = {
  enabled: true,
  showOpenPortal: true,
  showDeviceInfo: true,
  showRequestSupport: true,
  portalUrl: 'https://portal.example',
};

describe('withDeviceHelpPortal (fork)', () => {
  beforeEach(() => stateMock.mockReset());

  it('points the portal item at the current Get help link', async () => {
    stateMock.mockResolvedValue({ version: 3, enabled: true });
    const out = await withDeviceHelpPortal(DEVICE, BASE);
    expect(out.portalUrl).toBe('https://breeze.example/help#tok-1111-3');
    expect(out.enabled).toBe(true);
    expect(BASE.portalUrl).toBe('https://portal.example'); // input not mutated
  });

  it('keeps the policy portal URL when the help link is turned off', async () => {
    stateMock.mockResolvedValue({ version: 2, enabled: false });
    expect(await withDeviceHelpPortal(DEVICE, BASE)).toBe(BASE);
  });

});
