import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

const setPartner = vi.fn();
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (state: { setPartner: typeof setPartner }) => unknown) => selector({ setPartner }),
}));

// Exercise the real runAction wrapper so the action tests also verify the
// operator-visible toast.
import PartnersAdmin from './PartnersAdmin';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const pending = {
  id: 'p-pending',
  name: 'Tech A Services',
  slug: 'tech-a',
  type: 'msp',
  plan: 'free',
  status: 'pending',
  maxOrganizations: null,
  maxDevices: 25,
  billingEmail: 'tech-a@example.com',
};
const active = { ...pending, id: 'p-active', name: 'Star Computers', slug: 'star', status: 'active', maxDevices: null, billingEmail: null };
const suspended = { ...pending, id: 'p-suspended', name: 'Late Payer IT', slug: 'late-payer', status: 'suspended' };

function listResponse(rows: unknown[], total = rows.length) {
  return jsonResponse({ data: rows, pagination: { page: 1, limit: 100, total } });
}

describe('PartnersAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every partner from the system-scope partner API', async () => {
    fetchWithAuth.mockResolvedValueOnce(listResponse([pending, active, suspended]));
    render(<PartnersAdmin />);

    expect(await screen.findByText('Tech A Services')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners?page=1&limit=100');
    expect(screen.getByText('Star Computers')).toBeTruthy();
    expect(screen.getByText(/3 total, 1 pending activation, 1 suspended/)).toBeTruthy();

    const pendingRow = screen.getByTestId('partners-admin-row-p-pending');
    expect(within(pendingRow).getByText('25')).toBeTruthy();
    expect(within(pendingRow).getByText('tech-a@example.com')).toBeTruthy();
    expect(within(screen.getByTestId('partners-admin-row-p-active')).getByText('Not set')).toBeTruthy();
  });

  it('offers exactly one lifecycle action per status', async () => {
    fetchWithAuth.mockResolvedValueOnce(listResponse([pending, active, suspended, { ...pending, id: 'p-churned', name: 'Closed MSP', slug: 'closed', status: 'churned' }]));
    render(<PartnersAdmin />);
    await screen.findByText('Tech A Services');

    expect(screen.getByTestId('partners-admin-activate-p-pending')).toBeTruthy();
    expect(screen.getByTestId('partners-admin-suspend-p-active')).toBeTruthy();
    expect(screen.getByTestId('partners-admin-reactivate-p-suspended')).toBeTruthy();
    expect(screen.queryByTestId('partners-admin-activate-p-churned')).toBeNull();
    expect(screen.queryByTestId('partners-admin-suspend-p-churned')).toBeNull();
    expect(screen.queryByTestId('partners-admin-reactivate-p-churned')).toBeNull();
  });

  it.each([
    ['activate', 'p-pending', 'active', 'Partner activated'],
    ['suspend', 'p-active', 'suspended', 'Partner suspended'],
    ['reactivate', 'p-suspended', 'active', 'Partner reactivated'],
  ] as const)('%s PATCHes the partner status and updates the row', async (action, id, status, toast) => {
    fetchWithAuth
      .mockResolvedValueOnce(listResponse([pending, active, suspended]))
      .mockResolvedValueOnce(jsonResponse({ id, status }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PartnersAdmin />);
    await screen.findByText('Tech A Services');

    fireEvent.click(screen.getByTestId(`partners-admin-${action}-${id}`));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ message: toast, type: 'success' }));
    expect(fetchWithAuth).toHaveBeenLastCalledWith(`/orgs/partners/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    expect(within(screen.getByTestId(`partners-admin-row-${id}`)).getByText(status)).toBeTruthy();
  });

  it('never uses the fleet-uninstalling suspend-for-abuse endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(listResponse([active]))
      .mockResolvedValueOnce(jsonResponse({ id: active.id, status: 'suspended' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PartnersAdmin />);
    await screen.findByText('Star Computers');

    fireEvent.click(screen.getByTestId('partners-admin-suspend-p-active'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));

    const urls = fetchWithAuth.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('suspend-for-abuse'))).toBe(false);
  });

  it('does nothing when the operator cancels the confirmation', async () => {
    fetchWithAuth.mockResolvedValueOnce(listResponse([active]));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PartnersAdmin />);
    await screen.findByText('Star Computers');

    fireEvent.click(screen.getByTestId('partners-admin-suspend-p-active'));

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('partners-admin-row-p-active')).getByText('active')).toBeTruthy();
  });

  it('keeps the row unchanged and stays on the page when MFA is required', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(listResponse([pending]))
      .mockResolvedValueOnce(jsonResponse({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PartnersAdmin />);
    await screen.findByText('Tech A Services');

    fireEvent.click(screen.getByTestId('partners-admin-activate-p-pending'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.queryByTestId('partners-admin-requires-operator')).toBeNull();
    expect(within(screen.getByTestId('partners-admin-row-p-pending')).getByText('pending')).toBeTruthy();
  });

  it('explains the system-scope requirement when the list is forbidden', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: 'Forbidden' }, 403));
    render(<PartnersAdmin />);

    expect(await screen.findByTestId('partners-admin-requires-operator')).toBeTruthy();
  });

  it('shows a retry on a server error', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(listResponse([pending]));
    render(<PartnersAdmin />);

    fireEvent.click(await screen.findByText('Retry'));

    expect(await screen.findByText('Tech A Services')).toBeTruthy();
  });

  it('filters by search text and status', async () => {
    fetchWithAuth.mockResolvedValueOnce(listResponse([pending, active, suspended]));
    render(<PartnersAdmin />);
    await screen.findByText('Tech A Services');

    fireEvent.change(screen.getByTestId('partners-admin-search'), { target: { value: 'star' } });
    expect(screen.queryByText('Tech A Services')).toBeNull();
    expect(screen.getByText('Star Computers')).toBeTruthy();

    fireEvent.change(screen.getByTestId('partners-admin-search'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('partners-admin-status-filter'), { target: { value: 'suspended' } });
    expect(screen.getByText('Late Payer IT')).toBeTruthy();
    expect(screen.queryByText('Star Computers')).toBeNull();

    fireEvent.change(screen.getByTestId('partners-admin-search'), { target: { value: 'nobody' } });
    expect(screen.getByTestId('partners-admin-empty')).toBeTruthy();
  });

  it('loads further pages until every partner is shown', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(listResponse([pending], 2))
      .mockResolvedValueOnce(jsonResponse({ data: [active], pagination: { page: 2, limit: 100, total: 2 } }));
    render(<PartnersAdmin />);
    await screen.findByText('Tech A Services');

    fireEvent.click(screen.getByText('Load more'));

    expect(await screen.findByText('Star Computers')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/orgs/partners?page=2&limit=100');
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('opens the partner workspace through the partner switcher', async () => {
    fetchWithAuth.mockResolvedValueOnce(listResponse([active]));
    render(<PartnersAdmin />);
    await screen.findByText('Star Computers');

    fireEvent.click(screen.getByTestId('partners-admin-open-p-active'));

    expect(setPartner).toHaveBeenCalledWith('p-active');
  });
});
