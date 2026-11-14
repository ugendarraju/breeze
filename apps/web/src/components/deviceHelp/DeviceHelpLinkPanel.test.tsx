import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));

import DeviceHelpLinkPanel from './DeviceHelpLinkPanel';

const DEVICE = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const URL1 = `https://rmm.example.com/help#${'A'.repeat(48)}`;
const URL2 = `https://rmm.example.com/help#${'B'.repeat(48)}`;

function json(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchWithAuth.mockReset().mockImplementation(async (url: string) => {
    if (url === `/device-help/devices/${DEVICE}`) {
      return json({ enabled: true, url: URL1, osType: 'windows', shortcutScriptIds: { windows: 'script-win' } });
    }
    if (url.endsWith('/rotate')) return json({ enabled: true, url: URL2 });
    if (url.endsWith('/disable')) return json({ enabled: false, url: null });
    if (url === '/scripts/script-win/execute') return json({ success: true });
    return json({ error: 'unexpected' }, 500);
  });
});

describe('DeviceHelpLinkPanel', () => {
  it('shows the device link', async () => {
    render(<DeviceHelpLinkPanel deviceId={DEVICE} />);
    expect(await screen.findByTestId('device-help-link-url')).toHaveValue(URL1);
  });

  it('installs the shortcut by running the OS script with this device link', async () => {
    const user = userEvent.setup();
    render(<DeviceHelpLinkPanel deviceId={DEVICE} />);
    await user.click(await screen.findByTestId('device-help-install'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/script-win/execute', expect.anything()));
    const init = fetchWithAuth.mock.calls.find(([u]) => u === '/scripts/script-win/execute')![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ deviceIds: [DEVICE], parameters: { help_url: URL1, action: 'install' } });
  });

  it('disables install when there is no script for the device OS', async () => {
    fetchWithAuth.mockImplementationOnce(async () => json({ enabled: true, url: URL1, osType: 'linux', shortcutScriptIds: { windows: 'x' } }));
    render(<DeviceHelpLinkPanel deviceId={DEVICE} />);
    expect(await screen.findByTestId('device-help-install')).toBeDisabled();
  });

  it('rotates after confirming and shows the new link', async () => {
    const user = userEvent.setup();
    render(<DeviceHelpLinkPanel deviceId={DEVICE} />);
    await screen.findByTestId('device-help-link-url');
    await user.click(screen.getByRole('button', { name: 'New link' }));
    const buttons = await screen.findAllByRole('button', { name: 'New link' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('device-help-link-url')).toHaveValue(URL2));
    expect(fetchWithAuth).toHaveBeenCalledWith(`/device-help/devices/${DEVICE}/rotate`, { method: 'POST' });
  });

  it('turning off hides the link and offers to turn it back on', async () => {
    const user = userEvent.setup();
    render(<DeviceHelpLinkPanel deviceId={DEVICE} />);
    await screen.findByTestId('device-help-link-url');
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    const buttons = await screen.findAllByRole('button', { name: 'Turn off' });
    await user.click(buttons[buttons.length - 1]!);
    expect(await screen.findByText('The help link for this device is turned off.')).toBeInTheDocument();
    expect(screen.queryByTestId('device-help-link-url')).not.toBeInTheDocument();
  });
});
