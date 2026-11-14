// fork: "Updates only" filter and bulk update on the device Software tab.
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

function setup(updateOk: (body: { name: string }) => boolean = () => true, fixture: unknown = FIXTURE) {
  fetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/software/update')) {
      const body = JSON.parse(String((init as RequestInit).body)) as { name: string };
      return json(updateOk(body) ? { success: true } : { error: 'boom' }, updateOk(body));
    }
    if (u.includes('/software')) return json(fixture);
    return json({});
  });
  render(<DeviceSoftwareInventory deviceId={deviceId} osType="windows" />);
}

const updatePosts = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/software/update'));
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

  it('select all + update selected queues each update once and shows one summary', async () => {
    setup();
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(updatePosts()).toHaveLength(2));
    expect(updatePosts().map(bodyOf)).toEqual([
      { name: 'Adobe Acrobat', packageId: 'Adobe.Acrobat.Reader.64-bit' },
      { name: 'Cloudflare One Client', packageId: 'Cloudflare.Warp' },
    ]);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    expect(toastMock.mock.calls.filter(([a]) => (a as { type: string }).type === 'success')).toHaveLength(1);
    expect(screen.queryByTestId('software-update-selected')).toBeNull(); // selection cleared
  });

  it('updates only the rows the technician ticked', async () => {
    setup();
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-sw-cloudflare'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(updatePosts()).toHaveLength(1));
    expect(bodyOf(updatePosts()[0]).name).toBe('Cloudflare One Client');
  });

  it('reports a partial failure in the summary', async () => {
    setup((body) => body.name !== 'Adobe Acrobat');
    await screen.findByText('7-Zip');
    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(updatePosts()).toHaveLength(2));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/1 of 2/) })),
    );
  });

  // fork: OBS Studio regression — a Windows update must carry the exact winget
  // id; rows without one are disabled and skipped by bulk update.
  const EXACT_FIXTURE = {
    thirdPartyUpdatesManaged: false,
    data: [
      { id: 'sw-obs', name: 'OBS Studio', version: '32.0.1', publisher: 'OBS Project', updateAvailable: true, availableVersion: '33.0.0', updatePackageId: 'winget:OBSProject.OBSStudio' },
      { id: 'sw-zoom', name: 'Zoom', version: '7.1', publisher: 'Zoom', updateAvailable: true, availableVersion: '7.2', updatePackageId: 'OBSolete+Id' },
      { id: 'sw-mystery', name: 'Mystery App', version: '1.0', publisher: 'Acme', updateAvailable: true, availableVersion: '2.0', updatePackageId: null },
    ],
  };

  it('sends the bare winget id even when the list carries the provider-prefixed form', async () => {
    setup(() => true, EXACT_FIXTURE);
    await screen.findByText('OBS Studio');
    fireEvent.click(screen.getByTestId('software-select-sw-obs'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(updatePosts()).toHaveLength(1));
    expect(bodyOf(updatePosts()[0])).toEqual({ name: 'OBS Studio', packageId: 'OBSProject.OBSStudio' });
  });

  it('disables Update with a reason when the exact package is unknown, and bulk skips it with a count', async () => {
    setup(() => true, EXACT_FIXTURE);
    await screen.findByText('Mystery App');
    expect(screen.queryByTestId('software-select-sw-mystery')).toBeNull();
    expect(screen.queryByTestId('software-select-sw-zoom')).toBeNull();
    const reason = /exact winget package for this update isn't known/;
    const disabled = screen.getAllByTitle(reason);
    expect(disabled).toHaveLength(2);
    disabled.forEach((button) => expect((button as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(screen.getByTestId('software-select-all-updates'));
    fireEvent.click(screen.getByTestId('software-update-selected'));
    await waitFor(() => expect(updatePosts()).toHaveLength(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/2 skipped: exact package unknown/) }),
      ),
    );
  });

  // fork: "Close & update" — force-close what uses the app's files, then update.
  it('Close & update asks for confirmation, then posts the exact id to close-and-update', async () => {
    setup(() => true, EXACT_FIXTURE);
    await screen.findByText('OBS Studio');
    // Only rows that can be updated get the button.
    expect(screen.queryByTestId('software-close-update-sw-mystery')).toBeNull();

    fireEvent.click(screen.getByTestId('software-close-update-sw-obs'));
    expect(screen.getByText(/Unsaved work in those programs will be lost/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('close-and-update'))).toBe(false);

    fireEvent.click(screen.getByTestId('confirm-close-update'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/devices/${deviceId}/software/close-and-update`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'OBS Studio', packageId: 'OBSProject.OBSStudio' }) }),
      ),
    );
  });

  it('Close & update is not offered off Windows', async () => {
    fetchMock.mockImplementation(async () => json(EXACT_FIXTURE));
    render(<DeviceSoftwareInventory deviceId={deviceId} osType="linux" />);
    await screen.findByText('OBS Studio');
    expect(screen.queryByTestId('software-close-update-sw-obs')).toBeNull();
  });
});
