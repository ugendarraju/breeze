// fork: manual warranty dates + vendor warranty page on the device Warranty card.
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WarrantyManualControls, { vendorWarrantyUrl } from './WarrantyManualControls';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('vendorWarrantyUrl', () => {
  it.each([
    ['ASUSTEK COMPUTER INC.', 'https://www.asus.com/global/support/warranty-status-inquiry/'],
    ['ASUSTEKCOMPUTERINC', 'https://www.asus.com/global/support/warranty-status-inquiry/'],
    ['Acer', 'https://www.acer.com/us-en/support/warranty'],
    ['Microsoft Corporation', 'https://mybusinessservice.surface.com/'],
    ['LENOVO', 'https://pcsupport.lenovo.com/us/en/warrantylookup'],
    ['HP', 'https://support.hp.com/us-en/check-warranty'],
    ['Hewlett-Packard', 'https://support.hp.com/us-en/check-warranty'],
  ])('%s -> its warranty page', (maker, url) => {
    expect(vendorWarrantyUrl(maker, 'SN1')).toBe(url);
  });

  it('puts the Dell service tag in the link', () => {
    expect(vendorWarrantyUrl('Dell Inc.', 'ABC1234')).toBe(
      'https://www.dell.com/support/home/en-us/product-support/servicetag/ABC1234/overview',
    );
  });

  it('returns null for unknown or missing makers', () => {
    expect(vendorWarrantyUrl('Innotek GmbH', 'X')).toBeNull();
    expect(vendorWarrantyUrl(null, 'X')).toBeNull();
  });
});

describe('WarrantyManualControls', () => {
  beforeEach(() => fetchMock.mockReset());

  const renderControls = (onSaved = vi.fn(), manufacturer: string | null = 'ASUSTEKCOMPUTERINC') => {
    render(
      <WarrantyManualControls
        deviceId="dev-1"
        manufacturer={manufacturer}
        serialNumber="K6NRCV02H73524G"
        warrantyStartDate={null}
        warrantyEndDate={null}
        onSaved={onSaved}
      />,
    );
    return onSaved;
  };

  it('shows the vendor link only for a recognized maker', () => {
    renderControls(vi.fn(), 'Innotek GmbH');
    expect(screen.queryByTestId('warranty-check-vendor')).toBeNull();
    expect(screen.getByTestId('warranty-edit-dates')).toBeTruthy();
  });

  it('opens the vendor page in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderControls();
    fireEvent.click(screen.getByTestId('warranty-check-vendor'));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://www.asus.com/global/support/warranty-status-inquiry/', '_blank', 'noopener,noreferrer'),
    );
  });

  it('saves the dates and hands the saved row back to the card', async () => {
    const saved = { warrantyStartDate: '2019-07-28', warrantyEndDate: '2020-07-28', status: 'expired' };
    fetchMock.mockResolvedValue(json({ warranty: saved }));
    const onSaved = renderControls();
    fireEvent.click(screen.getByTestId('warranty-edit-dates'));
    fireEvent.change(screen.getByTestId('warranty-start-input'), { target: { value: '2019-07-28' } });
    fireEvent.change(screen.getByTestId('warranty-end-input'), { target: { value: '2020-07-28' } });
    fireEvent.click(screen.getByTestId('warranty-save-dates'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/devices/dev-1/warranty/manual');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ warrantyStartDate: '2019-07-28', warrantyEndDate: '2020-07-28' });
    expect(screen.queryByTestId('warranty-edit-form')).toBeNull();
  });

  it('keeps the form open when saving fails', async () => {
    fetchMock.mockResolvedValue(json({ error: 'bad' }, false, 400));
    const onSaved = renderControls();
    fireEvent.click(screen.getByTestId('warranty-edit-dates'));
    fireEvent.change(screen.getByTestId('warranty-end-input'), { target: { value: '2020-07-28' } });
    fireEvent.click(screen.getByTestId('warranty-save-dates'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('warranty-edit-form')).toBeTruthy();
  });
});
