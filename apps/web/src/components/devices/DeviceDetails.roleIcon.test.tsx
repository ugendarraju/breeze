/** The device header icon follows the device's role instead of always a monitor. */
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('@/components/wisp/WispTalkButton', () => ({ default: () => null }));

const base = {
  id: 'device-1',
  hostname: 'SRV-01',
  os: 'windows',
  osVersion: '10.0.20348',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.63.0',
  pendingReboot: false,
} as Device;

function headerIcon() {
  return screen.getByTestId('device-header-role-icon').querySelector('svg');
}

describe('device header role icon', () => {
  it.each([
    ['server', 'lucide-server'],
    ['printer', 'lucide-printer'],
    ['workstation', 'lucide-monitor'],
  ] as const)('shows the %s icon', (role, iconClass) => {
    render(<DeviceDetails device={{ ...base, deviceRole: role }} />);
    expect(headerIcon()?.getAttribute('class')).toContain(iconClass);
  });

  it('keeps the monitor icon when the role is unknown or missing', () => {
    const { unmount } = render(<DeviceDetails device={{ ...base, deviceRole: 'unknown' }} />);
    expect(headerIcon()?.getAttribute('class')).toContain('lucide-monitor');
    unmount();
    render(<DeviceDetails device={base} />);
    expect(headerIcon()?.getAttribute('class')).toContain('lucide-monitor');
  });
});
