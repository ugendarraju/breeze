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

// The real runAction wrapper runs, so mutations also verify their toasts.
import PartnerInvitesPanel, { inviteLink } from './PartnerInvitesPanel';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const open = {
  id: 'inv-open',
  label: 'Ravi - RK Computers',
  status: 'open',
  createdAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-11-21T10:00:00.000Z',
};
const used = {
  ...open,
  id: 'inv-used',
  label: 'Kiran',
  status: 'used',
  usedEmail: 'kiran@star.example',
  usedCompanyName: 'Star Computers',
  partnerId: 'p-star',
};

describe('PartnerInvitesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists invites with who used them', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [open, used], inviteOnly: true }));
    render(<PartnerInvitesPanel />);
    const usedRow = await screen.findByTestId('partner-invite-row-inv-used');
    expect(within(usedRow).getByText('Star Computers')).toBeTruthy();
    expect(within(usedRow).getByText('kiran@star.example')).toBeTruthy();
    expect(within(usedRow).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(within(screen.getByTestId('partner-invite-row-inv-open')).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.queryByTestId('partner-invites-open-signup-warning')).toBeNull();
  });

  it('warns when open signup is still on', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [], inviteOnly: false }));
    render(<PartnerInvitesPanel />);
    expect(await screen.findByTestId('partner-invites-open-signup-warning')).toBeTruthy();
  });

  it('creates an invite and shows its one-time link', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ data: [], inviteOnly: true }))
      .mockResolvedValueOnce(jsonResponse({ invite: { ...open, id: 'inv-new', label: 'Ravi' }, token: 'tok_123' }, 201));
    render(<PartnerInvitesPanel />);
    await screen.findByTestId('partner-invites-empty');

    fireEvent.change(screen.getByTestId('partner-invites-label'), { target: { value: '  Ravi  ' } });
    fireEvent.change(screen.getByTestId('partner-invites-ttl'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('partner-invites-create'));

    const url = (await screen.findByTestId('partner-invites-new-link-url')) as HTMLInputElement;
    expect(url.value).toBe(inviteLink('tok_123'));
    expect(url.value).toContain('/register-partner#invite=tok_123');
    const [path, init] = fetchWithAuth.mock.calls[1];
    expect(path).toBe('/admin/partner-invites');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ label: 'Ravi', ttlDays: 3 });
    expect(screen.getByTestId('partner-invite-row-inv-new')).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('revokes an open invite after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ data: [open], inviteOnly: true }))
      .mockResolvedValueOnce(jsonResponse({ invite: { ...open, status: 'revoked' } }));
    render(<PartnerInvitesPanel />);
    fireEvent.click(await screen.findByTestId('partner-invite-revoke-inv-open'));
    await waitFor(() => expect(within(screen.getByTestId('partner-invite-row-inv-open')).getByText('Revoked')).toBeTruthy());
    expect(fetchWithAuth.mock.calls[1][0]).toBe('/admin/partner-invites/inv-open');
    expect((fetchWithAuth.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [open], inviteOnly: true }));
    render(<PartnerInvitesPanel />);
    fireEvent.click(await screen.findByTestId('partner-invite-revoke-inv-open'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a user who is not a platform admin', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: 'platform admin access required' }, 403));
    const { container } = render(<PartnerInvitesPanel />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
