// Fork addition (see CUSTOMIZATIONS.md): one-time technician signup invites.
//
// API (apps/api/src/routes/admin/partnerSignupInvites.ts, platform admin only):
//   GET    /admin/partner-invites       list + whether signup is invite-only
//   POST   /admin/partner-invites       { label, ttlDays } -> { invite, token }
//   DELETE /admin/partner-invites/:id   revoke an unused invite
//
// The raw token is returned once, at creation; the panel turns it into the
// signup link and shows it until the admin dismisses it. It lives in the URL
// fragment (#invite=…) so it never reaches server or proxy logs.
import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

type InviteStatus = 'open' | 'used' | 'revoked' | 'expired';

export type InviteRow = {
  id: string;
  label: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  createdByEmail?: string;
  usedAt?: string;
  usedEmail?: string;
  usedCompanyName?: string;
  partnerId?: string;
  revokedAt?: string;
};

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';

const TTL_OPTIONS = [1, 3, 7, 14, 30];

const STATUS_BADGE: Record<InviteStatus, string> = {
  open: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  used: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  revoked: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

const STATUS_LABEL: Record<InviteStatus, string> = {
  open: 'Not used yet',
  used: 'Used',
  revoked: 'Revoked',
  expired: 'Expired',
};

export function inviteLink(token: string, origin = window.location.origin): string {
  return `${origin}/register-partner#invite=${encodeURIComponent(token)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function PartnerInvitesPanel() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [inviteOnly, setInviteOnly] = useState(true);
  const [label, setLabel] = useState('');
  const [ttlDays, setTtlDays] = useState(7);
  const [creating, setCreating] = useState(false);
  const [newLink, setNewLink] = useState<{ label: string; url: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/admin/partner-invites');
      if (response.status === 401 || response.status === 403) {
        setLoadState('unauthorized');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data: InviteRow[]; inviteOnly: boolean };
      setInvites(body.data);
      setInviteOnly(body.inviteOnly);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const body = await runAction<{ invite: InviteRow; token: string }>({
        request: () => fetchWithAuth('/admin/partner-invites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: trimmed, ttlDays }),
        }),
        errorFallback: 'Unable to create invite',
        successMessage: 'Invite link created',
      });
      setNewLink({ label: body.invite.label, url: inviteLink(body.token) });
      setInvites((current) => [body.invite, ...current]);
      setLabel('');
    } catch (error) {
      if (error instanceof ActionError && error.status === 401) return;
      handleActionError(error, 'Unable to create invite');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (row: InviteRow) => {
    if (!window.confirm(`Revoke the invite for "${row.label}"? The link stops working immediately.`)) return;
    setRevoking(row.id);
    try {
      const body = await runAction<{ invite: InviteRow }>({
        request: () => fetchWithAuth(`/admin/partner-invites/${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
        errorFallback: 'Unable to revoke invite',
        successMessage: 'Invite revoked',
      });
      setInvites((current) => current.map((candidate) => (candidate.id === row.id ? body.invite : candidate)));
    } catch (error) {
      if (error instanceof ActionError && error.status === 401) return;
      handleActionError(error, 'Unable to revoke invite');
    } finally {
      setRevoking(null);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast({ type: 'success', message: 'Link copied' });
    } catch {
      showToast({ type: 'error', message: 'Could not copy. Select the link and copy it manually.' });
    }
  };

  if (loadState === 'unauthorized') return null;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-6" data-testid="partner-invites-panel">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Technician invites</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a one-time signup link and send it to the technician. Each link works once: after someone signs up
          with it, it stops working. New signups wait for you to activate them in the list above.
        </p>
      </div>

      {loadState === 'ready' && !inviteOnly && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          data-testid="partner-invites-open-signup-warning"
        >
          Open signup is on: anyone can register without an invite. Set PARTNER_SIGNUP_INVITE_ONLY=true on the server to
          require one.
        </p>
      )}

      <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm">
          <span className="mb-1 block font-medium">Who is it for?</span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Ravi - RK Computers"
            maxLength={120}
            required
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="partner-invites-label"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Expires after</span>
          <select
            value={ttlDays}
            onChange={(event) => setTtlDays(Number(event.target.value))}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="partner-invites-ttl"
          >
            {TTL_OPTIONS.map((days) => (
              <option key={days} value={days}>{days === 1 ? '1 day' : `${days} days`}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={creating || !label.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          data-testid="partner-invites-create"
        >
          <Link2 className="h-4 w-4" aria-hidden />
          {creating ? 'Creating…' : 'Create invite link'}
        </button>
      </form>

      {newLink && (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-4" data-testid="partner-invites-new-link">
          <p className="text-sm font-medium">Invite link for {newLink.label}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={newLink.url}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
              aria-label="Invite link"
              data-testid="partner-invites-new-link-url"
            />
            <button
              type="button"
              onClick={() => void copyLink(newLink.url)}
              className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <Copy className="h-4 w-4" aria-hidden />
              Copy
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Copy it now and send it to the technician (WhatsApp, email…). For security it is not shown again; if it is
            lost, revoke it and create a new one.
          </p>
          <button type="button" onClick={() => setNewLink(null)} className="text-xs font-medium underline">
            Done
          </button>
        </div>
      )}

      {loadState === 'loading' && <p className="text-sm text-muted-foreground">Loading invites…</p>}
      {loadState === 'error' && (
        <p className="text-sm text-destructive" role="alert">
          Could not load invites.{' '}
          <button type="button" onClick={() => void load()} className="underline">Retry</button>
        </p>
      )}
      {loadState === 'ready' && invites.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="partner-invites-empty">No invites yet.</p>
      )}
      {loadState === 'ready' && invites.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm" data-testid="partner-invites-table">
            <thead>
              <tr className="border-b text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 font-medium">For</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Used by</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Expires</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {invites.map((row) => (
                <tr key={row.id} className="border-b last:border-0" data-testid={`partner-invite-row-${row.id}`}>
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[row.status]}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {row.usedCompanyName ? (
                      <>
                        <span className="font-medium">{row.usedCompanyName}</span>
                        <span className="block text-xs text-muted-foreground">{row.usedEmail}</span>
                        {!row.partnerId && (
                          <span className="block text-xs text-muted-foreground">Email not verified yet</span>
                        )}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(row.createdAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(row.expiresAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {row.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => void revoke(row)}
                        disabled={revoking === row.id}
                        className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                        data-testid={`partner-invite-revoke-${row.id}`}
                      >
                        {revoking === row.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
