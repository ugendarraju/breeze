import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircuitBoard, Download, RefreshCw, RotateCcw, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import '../../lib/i18n';

/**
 * fork: device page → Drivers tab. Reads GET /devices/:id/drivers (the latest
 * Driver Scan / Driver Install script runs) and starts scans, installs of
 * chosen Windows Update drivers, the maker's own tool, and installs of that
 * tool. Nothing here restarts the device.
 */
type RunStatus = 'pending' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'timeout' | 'cancelled';
type Run = {
  executionId: string;
  status: RunStatus;
  createdAt: string;
  completedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
};
type Vendor = 'dell' | 'hp' | 'lenovo';
type InstalledDriver = {
  deviceName: string;
  deviceClass: string | null;
  deviceId: string;
  hardwareId: string | null;
  version: string | null;
  date: string | null;
  provider: string | null;
};
type WuDriver = {
  updateId: string;
  title: string;
  driverClass: string | null;
  provider: string | null;
  date: string | null;
  sizeBytes: number | null;
  mayRequireReboot: boolean;
  deviceIds: string[];
};
type OemUpdate = { id: string | null; name: string; version: string | null; installedVersion: string | null; category: string | null };
export type DriversResponse = {
  supported: boolean;
  scriptsReady: boolean;
  scan: Run | null;
  result: {
    scannedAt: string | null;
    manufacturer: string | null;
    model: string | null;
    drivers: InstalledDriver[];
    windowsUpdate: { ok: boolean; source: string | null; error: string | null; updates: WuDriver[] };
    oem: { vendor: Vendor; tool: string | null; ok: boolean; listSupported: boolean; error: string | null; updates: OemUpdate[] } | null;
  } | null;
  install: (Run & {
    result: {
      restorePoint: boolean;
      rebootRequired: boolean;
      windowsUpdate: { updateId: string | null; title: string | null; result: string; hresult: string | null }[];
      oem: { vendor: string; tool: string | null; result: string | null; exitCode: string | null } | null;
      before: { deviceName: string; version: string | null; date: string | null }[];
    } | null;
    output: string | null;
  }) | null;
  toolInstall: (Run & { output: string | null }) | null;
  suggestedVendor: Vendor | null;
  suggestedTool: { id: string; tool: string } | null;
};

const ACTIVE = new Set<RunStatus>(['pending', 'queued', 'running', 'cancelling']);
const isActive = (run: Run | null | undefined) => !!run && ACTIVE.has(run.status);
const MICROSOFT = /^microsoft/i;
const NO_UPDATES: WuDriver[] = [];

type Pending =
  | { kind: 'wu'; ids: string[] }
  | { kind: 'oem'; vendor: Vendor; tool: string }
  | { kind: 'tool'; vendor: Vendor; tool: string };

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function DeviceDriversTab({ deviceId, timezone }: { deviceId: string; timezone?: string }) {
  const { t } = useTranslation(['devices', 'common']);
  const [data, setData] = useState<DriversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [showInbox, setShowInbox] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/drivers`);
      if (!response.ok) throw new Error('read_failed');
      const body = (await response.json()) as DriversResponse;
      if (request === generation.current) {
        setData(body);
        setError(false);
      }
    } catch {
      if (request === generation.current && !quiet) setError(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setData(null);
    setSelected(new Set());
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const running = isActive(data?.scan) || isActive(data?.install) || isActive(data?.toolInstall);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const updates = data?.result?.windowsUpdate.updates ?? NO_UPDATES;
  // A new scan replaces the offer list: drop selections it no longer contains.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => updates.some((u) => u.updateId === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [updates]);

  const driverByDevice = useMemo(() => {
    const map = new Map<string, InstalledDriver>();
    for (const d of data?.result?.drivers ?? []) map.set(d.deviceId.toUpperCase(), d);
    return map;
  }, [data?.result?.drivers]);

  const updatedDevices = useMemo(() => {
    const map = new Map<string, WuDriver>();
    for (const u of updates) for (const id of u.deviceIds) map.set(id.toUpperCase(), u);
    return map;
  }, [updates]);

  const visibleDrivers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.result?.drivers ?? [])
      .filter((d) => showInbox || !MICROSOFT.test(d.provider ?? '') || updatedDevices.has(d.deviceId.toUpperCase()))
      .filter((d) => !q || [d.deviceName, d.deviceClass, d.provider, d.hardwareId, d.version].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => (a.deviceClass ?? '').localeCompare(b.deviceClass ?? '') || a.deviceName.localeCompare(b.deviceName));
  }, [data?.result?.drivers, query, showInbox, updatedDevices]);

  const post = async (path: string, body: unknown, successMessage: string) => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/drivers/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        successMessage,
        errorFallback: t('devices:deviceDrivers.actionFailed'),
      });
      await load(true);
      return true;
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return false;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('devices:deviceDrivers.actionFailed') });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const scan = () => void post('scan', {}, t('devices:deviceDrivers.scanStarted'));

  const confirmPending = async () => {
    if (!pending) return;
    let ok = false;
    if (pending.kind === 'wu') {
      ok = await post('install', { updateIds: pending.ids, confirm: true }, t('devices:deviceDrivers.installStarted'));
      if (ok) setSelected(new Set());
    } else if (pending.kind === 'oem') {
      ok = await post('install', { oemVendor: pending.vendor, confirm: true }, t('devices:deviceDrivers.installStarted'));
    } else {
      ok = await post('install-tool', { oemVendor: pending.vendor, confirm: true }, t('devices:deviceDrivers.toolInstallStarted', { tool: pending.tool }));
    }
    if (ok) setPending(null);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading && !data) {
    return <p className="text-sm text-muted-foreground">{t('common:states.loading')}</p>;
  }
  if (error || !data) {
    return <p className="text-sm text-destructive">{t('devices:deviceDrivers.loadFailed')}</p>;
  }
  if (!data.supported) {
    return (
      <section className="rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {t('devices:deviceDrivers.windowsOnly')}
      </section>
    );
  }

  const result = data.result;
  const install = data.install;
  const scanRunning = isActive(data.scan);
  const installRunning = isActive(install) || isActive(data.toolInstall);
  const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso, timezone) : '');
  const oemFailed = (r: string | null | undefined) => r === 'failed' || r === 'error' || r === 'tool_not_found';

  return (
    <div className="space-y-4" data-testid="device-drivers-tab">
      <section className="space-y-3 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CircuitBoard className="h-5 w-5 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold">{t('devices:deviceDrivers.title')}</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {result?.scannedAt
                ? t('devices:deviceDrivers.lastScan', { when: when(result.scannedAt), count: result.drivers.length })
                : t('devices:deviceDrivers.neverScanned')}
              {result?.manufacturer ? ` · ${result.manufacturer}${result.model ? ` ${result.model}` : ''}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={scan}
            disabled={busy || scanRunning || !data.scriptsReady}
            data-testid="drivers-scan"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${scanRunning ? 'animate-spin' : ''}`} aria-hidden />
            {scanRunning ? t('devices:deviceDrivers.scanning') : t('devices:deviceDrivers.scanNow')}
          </button>
        </div>
        {!data.scriptsReady && <p className="text-sm text-warning">{t('devices:deviceDrivers.scriptsMissing')}</p>}
        {data.scan && !scanRunning && data.scan.status !== 'completed' && (
          <p className="text-sm text-destructive">
            {t('devices:deviceDrivers.scanFailed', { status: data.scan.status })}
            {data.scan.errorMessage ? `: ${data.scan.errorMessage}` : ''}
          </p>
        )}
        {scanRunning && <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.scanHint')}</p>}
      </section>

      {install && (
        <section className="space-y-2 rounded-lg border bg-card p-6 shadow-sm" data-testid="drivers-install-status">
          <h3 className="font-semibold">{t('devices:deviceDrivers.lastInstall')}</h3>
          {isActive(install) ? (
            <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.installing')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {when(install.completedAt ?? install.createdAt)} · {install.status}
                {install.errorMessage ? ` · ${install.errorMessage}` : ''}
              </p>
              {install.result?.rebootRequired && (
                <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm" data-testid="drivers-reboot-needed">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                  {t('devices:deviceDrivers.rebootNeeded')}
                </p>
              )}
              <ul className="space-y-1 text-sm">
                {install.result?.windowsUpdate.map((r, i) => (
                  <li key={`${r.updateId ?? 'x'}-${i}`}>
                    <span className={r.result === 'succeeded' ? 'text-success' : 'text-destructive'}>
                      {t(`devices:deviceDrivers.result.${r.result}`, { defaultValue: r.result })}
                    </span>
                    {' · '}
                    {r.title ?? r.updateId ?? ''}
                    {r.result !== 'succeeded' && r.hresult ? ` (${r.hresult})` : ''}
                  </li>
                ))}
                {install.result?.oem && (
                  <li>
                    <span className={oemFailed(install.result.oem.result) ? 'text-destructive' : 'text-success'}>
                      {t(`devices:deviceDrivers.result.${install.result.oem.result ?? 'unknown'}`, { defaultValue: install.result.oem.result ?? '' })}
                    </span>
                    {' · '}
                    {install.result.oem.tool ?? install.result.oem.vendor}
                    {install.result.oem.exitCode ? ` (exit ${install.result.oem.exitCode})` : ''}
                  </li>
                )}
              </ul>
              {!install.result && install.output && (
                <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{install.output}</pre>
              )}
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  {install.result?.restorePoint ? t('devices:deviceDrivers.restorePointMade') : t('devices:deviceDrivers.noRestorePoint')}{' '}
                  {t('devices:deviceDrivers.rollbackHint')}
                  {install.result?.before.length
                    ? ` ${t('devices:deviceDrivers.previousVersions')} ${install.result.before.map((b) => `${b.deviceName} ${b.version ?? ''}`).join('; ')}`
                    : ''}
                </span>
              </div>
            </>
          )}
        </section>
      )}

      {result && (
        <section className="space-y-3 rounded-lg border bg-card p-6 shadow-sm" data-testid="drivers-wu">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">{t('devices:deviceDrivers.wuTitle', { count: updates.length })}</h3>
              <p className="text-xs text-muted-foreground">{t('devices:deviceDrivers.wuSubtitle')}</p>
            </div>
            <button
              type="button"
              disabled={busy || installRunning || selected.size === 0}
              onClick={() => setPending({ kind: 'wu', ids: [...selected] })}
              data-testid="drivers-install-selected"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Download className="h-4 w-4" aria-hidden />
              {t('devices:deviceDrivers.installSelected', { count: selected.size })}
            </button>
          </div>
          {!result.windowsUpdate.ok ? (
            <p className="text-sm text-destructive">
              {t('devices:deviceDrivers.wuFailed')}
              {result.windowsUpdate.error ? `: ${result.windowsUpdate.error}` : ''}
            </p>
          ) : updates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.wuNone')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-8 py-1">
                      <input
                        type="checkbox"
                        aria-label={t('devices:deviceDrivers.selectAll')}
                        data-testid="drivers-select-all"
                        checked={selected.size === updates.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(updates.map((u) => u.updateId)) : new Set())}
                      />
                    </th>
                    <th className="py-1">{t('devices:deviceDrivers.col.update')}</th>
                    <th className="py-1">{t('devices:deviceDrivers.col.current')}</th>
                    <th className="py-1">{t('devices:deviceDrivers.col.newDate')}</th>
                    <th className="py-1">{t('devices:deviceDrivers.col.size')}</th>
                  </tr>
                </thead>
                <tbody>
                  {updates.map((u) => {
                    const current = u.deviceIds.map((id) => driverByDevice.get(id.toUpperCase())).find(Boolean);
                    return (
                      <tr key={u.updateId} className="border-t align-top">
                        <td className="py-1.5">
                          <input type="checkbox" aria-label={u.title} checked={selected.has(u.updateId)} onChange={() => toggle(u.updateId)} />
                        </td>
                        <td className="py-1.5">
                          <div>{u.title}</div>
                          {u.mayRequireReboot && <div className="text-xs text-warning">{t('devices:deviceDrivers.mayRestart')}</div>}
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {current ? `${current.deviceName} · ${current.version ?? ''}${current.date ? ` (${current.date})` : ''}` : '—'}
                        </td>
                        <td className="py-1.5 text-muted-foreground">{u.date ?? '—'}</td>
                        <td className="py-1.5 text-muted-foreground">{formatSize(u.sizeBytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {result && (
        <section className="space-y-3 rounded-lg border bg-card p-6 shadow-sm" data-testid="drivers-oem">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h3 className="font-semibold">{t('devices:deviceDrivers.oemTitle')}</h3>
          </div>
          {result.oem ? (
            <>
              <p className="text-sm text-muted-foreground">
                {result.oem.tool}
                {!result.oem.ok && result.oem.error ? ` · ${t('devices:deviceDrivers.oemFailed')}: ${result.oem.error}` : ''}
              </p>
              {result.oem.ok && !result.oem.listSupported && (
                <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.oemNoList')}</p>
              )}
              {result.oem.ok && result.oem.listSupported && result.oem.updates.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.oemNone')}</p>
              )}
              {result.oem.updates.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {result.oem.updates.map((u, i) => (
                    <li key={`${u.id ?? u.name}-${i}`}>
                      {u.name}
                      <span className="text-muted-foreground">
                        {u.installedVersion ? ` · ${u.installedVersion} →` : ' ·'} {u.version ?? ''}
                        {u.category ? ` · ${u.category}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {(!result.oem.listSupported || result.oem.updates.length > 0) && (
                <button
                  type="button"
                  disabled={busy || installRunning}
                  onClick={() => setPending({ kind: 'oem', vendor: result.oem!.vendor, tool: result.oem!.tool ?? result.oem!.vendor })}
                  data-testid="drivers-install-oem"
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  {t('devices:deviceDrivers.installAllOem', { tool: result.oem.tool ?? result.oem.vendor })}
                </button>
              )}
              <p className="text-xs text-muted-foreground">{t('devices:deviceDrivers.oemAllNote')}</p>
            </>
          ) : data.suggestedVendor && data.suggestedTool ? (
            <>
              <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.toolMissing', { tool: data.suggestedTool.tool })}</p>
              <button
                type="button"
                disabled={busy || installRunning}
                onClick={() => setPending({ kind: 'tool', vendor: data.suggestedVendor!, tool: data.suggestedTool!.tool })}
                data-testid="drivers-install-tool"
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden />
                {t('devices:deviceDrivers.installTool', { tool: data.suggestedTool.tool })}
              </button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('devices:deviceDrivers.noOemTool')}</p>
          )}
          {data.toolInstall && (
            <div className="text-xs text-muted-foreground" data-testid="drivers-tool-status">
              {isActive(data.toolInstall)
                ? t('devices:deviceDrivers.toolInstalling')
                : `${t('devices:deviceDrivers.toolInstallLast')}: ${data.toolInstall.status} · ${when(data.toolInstall.completedAt ?? data.toolInstall.createdAt)}`}
              {!isActive(data.toolInstall) && data.toolInstall.output && (
                <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2">{data.toolInstall.output}</pre>
              )}
            </div>
          )}
        </section>
      )}

      {result && (
        <section className="space-y-3 rounded-lg border bg-card p-6 shadow-sm" data-testid="drivers-installed">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">{t('devices:deviceDrivers.installedTitle', { count: result.drivers.length })}</h3>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={showInbox} onChange={(e) => setShowInbox(e.target.checked)} />
                {t('devices:deviceDrivers.showInbox')}
              </label>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('devices:deviceDrivers.search')}
                aria-label={t('devices:deviceDrivers.search')}
                className="h-8 w-56 max-w-full rounded-md border bg-background px-2 text-sm"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">{t('devices:deviceDrivers.col.device')}</th>
                  <th className="py-1">{t('devices:deviceDrivers.col.class')}</th>
                  <th className="py-1">{t('devices:deviceDrivers.col.version')}</th>
                  <th className="py-1">{t('devices:deviceDrivers.col.date')}</th>
                  <th className="py-1">{t('devices:deviceDrivers.col.provider')}</th>
                  <th className="py-1">{t('devices:deviceDrivers.col.hardwareId')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleDrivers.map((d) => (
                  <tr key={d.deviceId} className="border-t align-top">
                    <td className="py-1.5">
                      {d.deviceName}
                      {updatedDevices.has(d.deviceId.toUpperCase()) && (
                        <span className="ml-2 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {t('devices:deviceDrivers.updateAvailable')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-muted-foreground">{d.deviceClass ?? '—'}</td>
                    <td className="py-1.5 font-mono text-xs">{d.version ?? '—'}</td>
                    <td className="py-1.5 text-muted-foreground">{d.date ?? '—'}</td>
                    <td className="py-1.5 text-muted-foreground">{d.provider ?? '—'}</td>
                    <td className="max-w-[18rem] truncate py-1.5 font-mono text-xs text-muted-foreground" title={d.hardwareId ?? ''}>
                      {d.hardwareId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleDrivers.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t('devices:deviceDrivers.noMatches')}</p>}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        variant="warning"
        isLoading={busy}
        confirmTestId="drivers-confirm"
        title={
          pending?.kind === 'tool'
            ? t('devices:deviceDrivers.confirmToolTitle', { tool: pending.tool })
            : t('devices:deviceDrivers.confirmInstallTitle')
        }
        confirmLabel={pending?.kind === 'tool' ? t('devices:deviceDrivers.confirmToolLabel') : t('devices:deviceDrivers.confirmInstallLabel')}
        message={
          pending?.kind === 'tool' ? (
            <p>{t('devices:deviceDrivers.confirmToolBody', { tool: pending.tool })}</p>
          ) : (
            <div className="space-y-2">
              <p>
                {pending?.kind === 'wu'
                  ? t('devices:deviceDrivers.confirmWuBody', { count: pending.ids.length })
                  : t('devices:deviceDrivers.confirmOemBody', { tool: pending?.kind === 'oem' ? pending.tool : '' })}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>{t('devices:deviceDrivers.confirmNoRestart')}</li>
                <li>{t('devices:deviceDrivers.confirmFlicker')}</li>
                <li>{t('devices:deviceDrivers.confirmRollback')}</li>
              </ul>
            </div>
          )
        }
      />
    </div>
  );
}
