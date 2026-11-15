// fork: "Updates only" filter, bulk update, guarded Windows updates (one batch
// request per action) and the last-update-run panel on the device Software tab.
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceSoftwareInventory from './DeviceSoftwareInventory';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const deviceId = '11111111-1111-1111-1111-111111111111';
const FIXTURE = {
  thirdPartyUpdatesManaged: false,
  data: [
    { id: 'sw-acrobat', name: 'Adobe Acrobat', version: '26.002.21931', publisher: 'Adobe', updateAvailable: true, availableVersion: '26.002.22031', updatePackageId: 'Adobe.Acrobat.Reader.64-bit' },
    { id: 'sw-cloudflare', name: 'Cloudflare One Client', version: '26.8.2100.0', publisher: 'Cloudflare, Inc.', updateAvailable: true, availableVersion: '26.8.2115.0', updatePackageId: 'Cloudflare.Warp' },
    { id: 'sw-7zip', name: '7-Zip', version: '26.04', publisher: 'Igor Pavlov' },
  ],
};
// OBS Studio regression: a provider-prefixed id, an id the agent can't take, and no id.
const EXACT_FIXTURE = {
  thirdPartyUpdatesManaged: false,
  data: [
    { id: 'sw-obs', name: 'OBS Studio', version: '32.0.1', publisher: 'OBS Project', updateAvailable: true, availableVersion: '33.0.0', updatePackageId: 'winget:OBSProject.OBSStudio' },
    { id: 'sw-zoom', name: 'Zoom', version: '7.1', publisher: 'Zoom', updateAvailable: true, availableVersion: '7.2', updatePackageId: 'OBSolete+Id' },
    { id: 'sw-mystery', name: 'Mystery App', version: '1.0', publisher: 'Acme', updateAvailable: true, availableVersion: '2.0', updatePackageId: null },
  ],
};

type BatchBody = { items: Array<{ name: string; packageId?: string }>; mode: string };
const batchReply = (body: BatchBody, programs: Record<string, string[]> = {}) => ({
  success: true,
  delivery: 'script',
  packages: body.items.map((i) => ({ name: i.name, packageId: i.packageId ?? i.name, programs: programs[i.name] ?? [] })),
  skipped: [],
  notified: true,
});

function setup(opts: {
  fixture?: unknown;
  osType?: string;
  statuses?: () => unknown[];
  batch?: (body: BatchBody) => { payload: unknown; ok?: boolean };
} = {}) {
  fetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/software/update-status')) return json({ packages: opts.statuses ? opts.statuses() : [] });
    if (u.includes('/commands')) return json({ command: { id: 'refresh-1' } });
    if (u.includes('/software/update-batch')) {
      const body = JSON.parse(String((init as RequestInit).body)) as BatchBody;
      const reply = opts.batch ? opts.batch(body) : { payload: batchReply(body) };
      return json(reply.payload, reply.ok ?? true);
    }
    if (u.includes('/software/update')) return json({ success: true });
    if (u.includes('/software')) return json(opts.fixture ?? FIXTURE);
    return json({});
  });
  render(<DeviceSoftwareInventory deviceId={deviceId} osType={opts.osType ?? 'windows'} />);
}

const batchPosts = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/software/update-batch'));
const bodyOf = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit).body));

describe('DeviceSoftwareInventory bulk updates (fork)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('"Updates only" shows just the rows with an update', async () => {
    setup();
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-updates-only'));
    expect(screen.queryByText('7-Zip')).toBeNull();
    expect(screen.getByText('Adobe Acrobat')).toBeTruthy();
    expect(screen.getByText('Cloudflare One Client')).toBeTruthy();
  });

  it('only rows that can be updated get a checkbox', async () => {
    setup();
    await screen.findByText('7-Zip');
    expect(screen.getByTestId('software-select-sw-acrobat')).toBeTruthy();
    expect(screen.queryByTestId('software-select-sw-7zip')).toBeNull();
  });

  it('Windows: select all + update selected sends ONE batch request and one summary', async () => {
    setup();
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(bodyOf(batchPosts()[0])).toEqual({
      items: [
        { name: 'Adobe Acrobat', packageId: 'Adobe.Acrobat.Reader.64-bit' },
        { name: 'Cloudflare One Client', packageId: 'Cloudflare.Warp' },
      ],
      mode: 'wait',
    });
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('Updating Adobe Acrobat, Cloudflare One Client.') }),
      ),
    );
    expect(screen.queryByTestId('software-update-selected')).toBeNull(); // selection cleared
  });

  it('Windows: the summary names the programs the user is asked to close', async () => {
    setup({ batch: (body) => ({ payload: batchReply(body, { 'Cloudflare One Client': ['Google Chrome', 'Opera'] }) }) });
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-sw-cloudflare'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(bodyOf(batchPosts()[0]).items).toEqual([{ name: 'Cloudflare One Client', packageId: 'Cloudflare.Warp' }]);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/Waiting for the user to close Google Chrome, Opera so Cloudflare One Client can update\. A notice was sent/),
        }),
      ),
    );
  });

  it('Windows: a refused batch shows an error toast', async () => {
    setup({ batch: () => ({ payload: { error: 'Device is offline' }, ok: false }) });
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('Device is offline') })),
    );
  });

  it('non-Windows bulk update still queues one plain update per row', async () => {
    setup({ osType: 'linux' });
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/software/update'))).toHaveLength(2),
    );
    expect(batchPosts()).toHaveLength(0);
  });

  it('sends the bare winget id even when the list carries the provider-prefixed form', async () => {
    setup({ fixture: EXACT_FIXTURE });
    await screen.findByText('OBS Studio');
    fireEvent.click(screen.getByTestId('software-update-sw-obs'));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(bodyOf(batchPosts()[0])).toEqual({ items: [{ name: 'OBS Studio', packageId: 'OBSProject.OBSStudio' }], mode: 'wait' });
  });

  it('disables Update with a reason when the exact package is unknown, and bulk reports them as skipped', async () => {
    setup({ fixture: EXACT_FIXTURE });
    await screen.findByText('Mystery App');
    expect(screen.queryByTestId('software-select-sw-mystery')).toBeNull();
    expect(screen.queryByTestId('software-select-sw-zoom')).toBeNull();
    const disabled = screen.getAllByTitle(/exact winget package for this update isn't known/);
    expect(disabled).toHaveLength(2);
    disabled.forEach((button) => expect((button as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(bodyOf(batchPosts()[0]).items).toEqual([{ name: 'OBS Studio', packageId: 'OBSProject.OBSStudio' }]);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/2 skipped: exact package unknown/) }),
      ),
    );
  });

  it('Close & update asks for confirmation, then sends a force batch for the exact id', async () => {
    setup({ fixture: EXACT_FIXTURE });
    await screen.findByText('OBS Studio');
    expect(screen.queryByTestId('software-close-update-sw-mystery')).toBeNull();

    fireEvent.click(screen.getByTestId('software-close-update-sw-obs'));
    expect(screen.getByText(/Unsaved work in those programs will be lost/)).toBeTruthy();
    expect(batchPosts()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('confirm-close-update'));
    await waitFor(() => expect(batchPosts()).toHaveLength(1));
    expect(bodyOf(batchPosts()[0])).toEqual({ items: [{ name: 'OBS Studio', packageId: 'OBSProject.OBSStudio' }], mode: 'force' });
  });

  it('Close & update is not offered off Windows', async () => {
    setup({ fixture: EXACT_FIXTURE, osType: 'linux' });
    await screen.findByText('OBS Studio');
    expect(screen.queryByTestId('software-close-update-sw-obs')).toBeNull();
  });

  // fork: live per-row update status.
  const status = (packageId: string, state: string, extra: Record<string, unknown> = {}) => ({
    packageId, name: packageId, state, message: null, programs: [], commandId: `cmd-${packageId}`, updatedAt: '2026-11-15T06:00:00Z', ...extra,
  });

  it('shows each row\'s update status, including a one-line failure reason', async () => {
    setup({
      fixture: EXACT_FIXTURE,
      statuses: () => [
        status('OBSProject.OBSStudio', 'failed', { message: 'Files are in use by another program, installer exit code 6' }),
      ],
    });
    const line = await screen.findByTestId('software-update-status-OBSProject.OBSStudio');
    expect(line.textContent).toBe('Update failed: Files are in use by another program, installer exit code 6');
  });

  it('shows a running update, blocks a second click, and polls until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let state = 'running';
      setup({ fixture: FIXTURE, statuses: () => [status('Cloudflare.Warp', state)] });
      const line = await screen.findByTestId('software-update-status-Cloudflare.Warp');
      expect(line.textContent).toBe('Updating…');
      const button = screen.getByTestId('software-update-sw-cloudflare') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe('An update for this app is already in progress.');

      state = 'succeeded';
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => expect(screen.getByTestId('software-update-status-Cloudflare.Warp').textContent).toBe('Updated'));
      // A finished update asks the agent for a fresh software list.
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([u, init]) =>
          String(u).includes('/commands') && String((init as RequestInit | undefined)?.body ?? '').includes('refresh_inventory'))).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
