// fork: device page panel for the per-device "Get help" link: see, copy,
// rotate or turn off the link, and install the desktop shortcut on the device.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

type ShortcutOs = 'windows' | 'macos' | 'linux';

interface HelpLinkView {
  enabled: boolean;
  url: string | null;
  osType?: string | null;
  shortcutScriptIds?: Partial<Record<ShortcutOs, string>>;
}

function handleError(err: unknown, fallback: string) {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

export default function DeviceHelpLinkPanel({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [view, setView] = useState<HelpLinkView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'disable' | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetchWithAuth(`/device-help/devices/${deviceId}`);
      if (!res.ok) { setLoadFailed(true); return; }
      setView((await res.json()) as HelpLinkView);
    } catch {
      setLoadFailed(true);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  async function change(action: 'rotate' | 'disable') {
    const fallback = action === 'rotate' ? t('deviceHelp.panel.rotateFailed') : t('deviceHelp.panel.disableFailed');
    setBusy(true);
    try {
      const next = await runAction<HelpLinkView>({
        request: () => fetchWithAuth(`/device-help/devices/${deviceId}/${action}`, { method: 'POST' }),
        errorFallback: fallback,
        successMessage: action === 'rotate' ? t('deviceHelp.panel.rotated') : t('deviceHelp.panel.disabledToast'),
      });
      setView((prev) => ({ ...(prev ?? {}), ...next }));
    } catch (err) {
      handleError(err, fallback);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function copy() {
    if (!view?.url) return;
    try {
      await navigator.clipboard.writeText(view.url);
      showToast({ type: 'success', message: t('deviceHelp.panel.copied') });
    } catch {
      showToast({ type: 'error', message: t('deviceHelp.panel.copyFailed') });
    }
  }

  const os = (view?.osType ?? '') as ShortcutOs;
  const scriptId = view?.shortcutScriptIds?.[os];

  async function installShortcut() {
    if (!view?.url || !scriptId) return;
    const url = view.url;
    setBusy(true);
    try {
      // A 201 can still refuse the device (offline policy, OS, site access...):
      // only an `admitted` target means the install was really queued.
      const result = await runAction<{ targets?: Array<{ admission: string; reasonCode?: string }> }>({
        request: () => fetchWithAuth(`/scripts/${scriptId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceIds: [deviceId], parameters: { help_url: url, action: 'install' } }),
        }),
        errorFallback: t('deviceHelp.panel.installFailed'),
      });
      const refused = (result?.targets ?? []).filter((target) => target.admission !== 'admitted');
      if (refused.length > 0 || !result?.targets?.length) {
        const reasons = [...new Set(refused.map((target) => target.reasonCode ?? target.admission))].join(', ');
        showToast({ type: 'error', message: reasons ? `${t('deviceHelp.panel.installFailed')} (${reasons})` : t('deviceHelp.panel.installFailed') });
      } else {
        showToast({ type: 'success', message: t('deviceHelp.panel.installed') });
      }
    } catch (err) {
      handleError(err, t('deviceHelp.panel.installFailed'));
    } finally {
      setBusy(false);
    }
  }

  const button = 'rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60';

  return (
    <section className="space-y-3 border-b p-4" data-testid="device-help-link-panel">
      <div>
        <h3 className="text-sm font-semibold">{t('deviceHelp.panel.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('deviceHelp.panel.description')}</p>
      </div>
      {!view && !loadFailed && <p className="text-sm text-muted-foreground">{t('deviceHelp.panel.loading')}</p>}
      {loadFailed && <p className="text-sm text-muted-foreground" role="alert">{t('deviceHelp.panel.loadFailed')}</p>}
      {view && view.enabled && view.url && (
        <>
          <input
            readOnly
            value={view.url}
            aria-label={t('deviceHelp.panel.title')}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
            data-testid="device-help-link-url"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => void copy()} disabled={busy}>{t('deviceHelp.panel.copy')}</button>
            <button
              type="button"
              className={button}
              onClick={() => void installShortcut()}
              disabled={busy || !scriptId}
              title={scriptId ? undefined : t('deviceHelp.panel.installUnsupported')}
              data-testid="device-help-install"
            >
              {t('deviceHelp.panel.install')}
            </button>
            <button type="button" className={button} onClick={() => setConfirm('rotate')} disabled={busy}>{t('deviceHelp.panel.rotate')}</button>
            <button type="button" className={button} onClick={() => setConfirm('disable')} disabled={busy}>{t('deviceHelp.panel.disable')}</button>
          </div>
        </>
      )}
      {view && !view.enabled && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{t('deviceHelp.panel.disabled')}</p>
          <button type="button" className={button} onClick={() => void change('rotate')} disabled={busy}>{t('deviceHelp.panel.enable')}</button>
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void change(confirm); }}
        title={confirm === 'disable' ? t('deviceHelp.panel.disable') : t('deviceHelp.panel.rotate')}
        message={confirm === 'disable' ? t('deviceHelp.panel.disableConfirm') : t('deviceHelp.panel.rotateConfirm')}
        confirmLabel={confirm === 'disable' ? t('deviceHelp.panel.disable') : t('deviceHelp.panel.rotate')}
        variant={confirm === 'disable' ? 'destructive' : 'warning'}
        isLoading={busy}
      />
    </section>
  );
}
