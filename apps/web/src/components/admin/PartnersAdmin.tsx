// Fork addition (see CUSTOMIZATIONS.md): platform-operator directory of every
// partner (MSP / technician) with lifecycle actions.
//
// Reuses the system-scope partner API in apps/api/src/routes/orgs.ts:
//   GET   /orgs/partners      — all partners (requireScope('system'))
//   PATCH /orgs/partners/:id  — { status } transitions. `suspended` runs
//         revokePartnerTenantAccess (reversible token suspension, NOT the
//         fleet-uninstalling /admin/partners/:id/suspend-for-abuse path) and
//         `active` runs restorePartnerTenantAccess.
// Plan and maxDevices are read-only here on purpose: the API keeps them out of
// its write schema so they stay billing-managed.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';

type PartnerStatus = 'pending' | 'active' | 'suspended' | 'churned' | 'offboarding';

type PartnerRow = {
  id: string;
  name: string;
  slug: string;
  type: string | null;
  plan: string;
  status: PartnerStatus;
  maxOrganizations: number | null;
  maxDevices: number | null;
  billingEmail: string | null;
};

type PartnersResponse = {
  data: PartnerRow[];
  pagination: { page: number; limit: number; total: number };
};

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';
type StatusFilter = 'all' | PartnerStatus;
type LifecycleAction = 'activate' | 'suspend' | 'reactivate';

const PAGE_SIZE = 100;
const STATUS_FILTERS: StatusFilter[] = ['all', 'pending', 'active', 'suspended', 'churned', 'offboarding'];

const STATUS_BADGE: Record<PartnerStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  churned: 'bg-muted text-muted-foreground',
  offboarding: 'bg-muted text-muted-foreground',
};

const ACTION_TARGET: Record<LifecycleAction, PartnerStatus> = {
  activate: 'active',
  suspend: 'suspended',
  reactivate: 'active',
};

const ACTION_CONFIRM: Record<LifecycleAction, (name: string) => string> = {
  activate: (name) => `Activate ${name}? They will be able to use the platform without a payment on file.`,
  suspend: (name) => `Suspend ${name}? Their users are signed out and their agents' tokens are suspended until you reactivate them. Devices are not uninstalled.`,
  reactivate: (name) => `Reactivate ${name}? Their users can sign in again and suspended agent tokens are restored.`,
};

const ACTION_SUCCESS: Record<LifecycleAction, string> = {
  activate: 'Partner activated',
  suspend: 'Partner suspended',
  reactivate: 'Partner reactivated',
};

function actionsFor(status: PartnerStatus): LifecycleAction[] {
  if (status === 'pending') return ['activate'];
  if (status === 'active') return ['suspend'];
  if (status === 'suspended') return ['reactivate'];
  return [];
}

const limitLabel = (value: number | null) => (value === null ? 'Unlimited' : String(value));

export default function PartnersAdmin() {
  const [rows, setRows] = useState<PartnerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const setPartner = useOrgStore((s) => s.setPartner);

  const loadPage = useCallback(async (nextPage: number) => {
    if (nextPage > 1) setLoadingMore(true);
    else setLoadState('loading');

    try {
      const response = await fetchWithAuth(`/orgs/partners?page=${nextPage}&limit=${PAGE_SIZE}`);
      if (response.status === 401 || response.status === 403) {
        setLoadState('unauthorized');
        return;
      }
      if (!response.ok) {
        setLoadState('error');
        return;
      }
      const body = await response.json() as PartnersResponse;
      setRows((current) => (nextPage > 1 ? [...current, ...body.data] : body.data));
      setTotal(body.pagination.total);
      setPage(nextPage);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(1);
  }, [loadPage]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [row.name, row.slug, row.billingEmail ?? ''].some((value) => value.toLowerCase().includes(needle));
    });
  }, [rows, query, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<PartnerStatus, number>> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, [rows]);

  const act = async (row: PartnerRow, action: LifecycleAction) => {
    if (!window.confirm(ACTION_CONFIRM[action](row.name))) return;

    const status = ACTION_TARGET[action];
    setActingOn(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/partners/${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
        errorFallback: `Unable to ${action} partner`,
        successMessage: ACTION_SUCCESS[action],
      });
      setRows((current) => current.map((candidate) => (
        candidate.id === row.id ? { ...candidate, status } : candidate
      )));
    } catch (error) {
      // An MFA_REQUIRED 403 is already toasted by runAction and is fixable by
      // the operator; any other 403 means the session lost system scope.
      if (error instanceof ActionError && error.status === 403 && error.code !== 'MFA_REQUIRED') {
        setLoadState('unauthorized');
        return;
      }
      handleActionError(error, `Unable to ${action} partner`);
    } finally {
      setActingOn(null);
    }
  };

  const openWorkspace = (row: PartnerRow) => {
    setPartner(row.id);
    window.location.href = '/';
  };

  if (loadState === 'loading') {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading partners…</p>;
  }
  if (loadState === 'unauthorized') {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="partners-admin-requires-operator">
        <p className="font-medium">Sign in with the platform operator account</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The partner directory needs a system-scope platform admin: an account with no partner or organization membership.
        </p>
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center" role="alert">
        <p className="text-sm text-destructive">Unable to load partners</p>
        <button type="button" onClick={() => void loadPage(1)} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Partners</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every MSP on the platform. {total} total
          {statusCounts.pending ? `, ${statusCounts.pending} pending activation` : ''}
          {statusCounts.suspended ? `, ${statusCounts.suspended} suspended` : ''}.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, slug or billing email"
          aria-label="Search partners"
          data-testid="partners-admin-search"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm sm:max-w-sm"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          aria-label="Filter by status"
          data-testid="partners-admin-status-filter"
          className="rounded-md border bg-background px-3 py-2 text-sm"
        >
          {STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>{value === 'all' ? 'All statuses' : value}</option>
          ))}
        </select>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center" data-testid="partners-admin-empty">
          <Building2 className="mx-auto h-12 w-12 text-muted-foreground/40" />
          <h2 className="mt-4 text-lg font-semibold">No partners match</h2>
          <p className="mt-2 text-sm text-muted-foreground">Change the search or status filter.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-3">Partner</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Plan</th>
                <th className="px-3 py-3">Device limit</th>
                <th className="px-3 py-3">Org limit</th>
                <th className="px-3 py-3">Billing email</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const isActing = actingOn === row.id;
                return (
                  <tr key={row.id} className="border-t" data-testid={`partners-admin-row-${row.id}`}>
                    <td className="px-3 py-3 align-top">
                      <span className="font-medium">{row.name}</span>
                      <div className="text-xs text-muted-foreground">{row.slug}{row.type ? ` · ${row.type}` : ''}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[row.status] ?? STATUS_BADGE.churned}`}>{row.status}</span>
                    </td>
                    <td className="px-3 py-3 align-top">{row.plan}</td>
                    <td className="px-3 py-3 align-top">{limitLabel(row.maxDevices)}</td>
                    <td className="px-3 py-3 align-top">{limitLabel(row.maxOrganizations)}</td>
                    <td className="px-3 py-3 align-top text-muted-foreground">{row.billingEmail ?? 'Not set'}</td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex justify-end gap-2">
                        {actionsFor(row.status).map((action) => (
                          <button
                            key={action}
                            type="button"
                            disabled={isActing}
                            onClick={() => void act(row, action)}
                            data-testid={`partners-admin-${action}-${row.id}`}
                            className={action === 'suspend'
                              ? 'rounded-md bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground disabled:opacity-60'
                              : 'rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-60'}
                          >
                            {action === 'activate' ? 'Activate' : action === 'suspend' ? 'Suspend' : 'Reactivate'}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => openWorkspace(row)}
                          data-testid={`partners-admin-open-${row.id}`}
                          className="rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted"
                        >
                          Open workspace
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length < total && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => void loadPage(page + 1)}
            disabled={loadingMore}
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
