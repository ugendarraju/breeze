// fork: device Drivers tab.
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDriversTab, { type DriversResponse } from './DeviceDriversTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const UPDATE_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const run = { executionId: 'e1', status: 'completed' as const, createdAt: '2026-11-15T10:00:00Z', completedAt: '2026-11-15T10:02:00Z', exitCode: 0, errorMessage: null };

const base = (over: Partial<DriversResponse> = {}): DriversResponse => ({
  supported: true,
  scriptsReady: true,
  scan: run,
  result: {
    scannedAt: '2026-11-15T10:02:00Z',
    manufacturer: 'ASUSTeK COMPUTER INC.',
    model: 'ROG Strix',
    drivers: [
      { deviceName: 'Realtek Audio', deviceClass: 'MEDIA', deviceId: 'HDAUDIO\\FUNC_01', hardwareId: 'HDAUDIO\\FUNC_01', version: '6.0.9', date: '2024-01-02', provider: 'Realtek' },
      { deviceName: 'WAN Miniport', deviceClass: 'NET', deviceId: 'SWD\\MSRRAS', hardwareId: 'ms_ndiswan', version: '10.0', date: '2006-06-21', provider: 'Microsoft' },
    ],
    windowsUpdate: {
      ok: true,
      source: 'Windows Update',
      error: null,
      updates: [{ updateId: UPDATE_ID, title: 'Realtek - MEDIA - 6.0.10', driverClass: 'MEDIA', provider: 'Realtek', date: '2025-05-01', sizeBytes: 2048, mayRequireReboot: true, deviceIds: ['HDAUDIO\\FUNC_01'] }],
    },
    oem: null,
  },
  install: null,
  toolInstall: null,
  suggestedVendor: null,
  suggestedTool: null,
  ...over,
});

describe('DeviceDriversTab', () => {
  beforeEach(() => fetchMock.mockReset());

  it('lists Windows Update drivers and hides Microsoft inbox drivers by default', async () => {
    fetchMock.mockResolvedValue(json(base()));
    render(<DeviceDriversTab deviceId="dev-1" />);
    expect(await screen.findByText('Realtek - MEDIA - 6.0.10')).toBeTruthy();
    expect(screen.getByText('Realtek Audio')).toBeTruthy();
    expect(screen.queryByText('WAN Miniport')).toBeNull();
    expect(screen.getByText(/no command-line update tool/i)).toBeTruthy();
  });

  it('installs the selected updates only after confirming', async () => {
    fetchMock.mockResolvedValueOnce(json(base()));
    render(<DeviceDriversTab deviceId="dev-1" />);
    fireEvent.click(await screen.findByLabelText('Realtek - MEDIA - 6.0.10'));
    fireEvent.click(screen.getByTestId('drivers-install-selected'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json({ executionId: 'e2' }, true, 202));
    fetchMock.mockResolvedValue(json(base()));
    fireEvent.click(await screen.findByTestId('drivers-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/devices/dev-1/drivers/install', expect.anything()));
    const call = fetchMock.mock.calls.find(([url]) => url === '/devices/dev-1/drivers/install')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ updateIds: [UPDATE_ID], confirm: true });
  });

  it('offers the maker tool on a recognised maker without it', async () => {
    fetchMock.mockResolvedValueOnce(json(base({ suggestedVendor: 'lenovo', suggestedTool: { id: 'Lenovo.SystemUpdate', tool: 'Lenovo System Update' } })));
    render(<DeviceDriversTab deviceId="dev-1" />);
    fireEvent.click(await screen.findByTestId('drivers-install-tool'));
    fetchMock.mockResolvedValueOnce(json({ executionId: 'e3' }, true, 202));
    fetchMock.mockResolvedValue(json(base()));
    fireEvent.click(await screen.findByTestId('drivers-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/devices/dev-1/drivers/install-tool', expect.anything()));
    const call = fetchMock.mock.calls.find(([url]) => url === '/devices/dev-1/drivers/install-tool')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ oemVendor: 'lenovo', confirm: true });
  });

  it('shows the restart notice after an install that needs one', async () => {
    fetchMock.mockResolvedValue(json(base({
      install: {
        ...run,
        output: null,
        result: { restorePoint: false, rebootRequired: true, windowsUpdate: [{ updateId: UPDATE_ID, title: 'Realtek', result: 'succeeded', hresult: '0x00000000' }], oem: null, before: [] },
      },
    })));
    render(<DeviceDriversTab deviceId="dev-1" />);
    expect(await screen.findByTestId('drivers-reboot-needed')).toBeTruthy();
    expect(screen.getByText('Installed')).toBeTruthy();
  });

  it('explains that non-Windows devices are not covered', async () => {
    fetchMock.mockResolvedValue(json({ ...base(), supported: false, result: null }));
    render(<DeviceDriversTab deviceId="dev-1" />);
    expect(await screen.findByText(/Windows devices only/)).toBeTruthy();
  });
});
