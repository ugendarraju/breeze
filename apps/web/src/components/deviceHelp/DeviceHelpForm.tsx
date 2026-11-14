// fork: the account-less "Get help" form opened from a managed computer's
// desktop shortcut. The device token rides in the URL fragment (#<token>), so
// it never reaches a server log; this component reads it and posts it in the
// request body. Unauthenticated by design: credentials are never sent.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { runAction } from '../../lib/runAction';
import ToastContainer from '../shared/Toast';

const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

type Phase = 'checking' | 'invalid' | 'error' | 'ready' | 'sent';

export function readHelpToken(hash: string): string {
  return hash.replace(/^#/, '').trim();
}

const inputClass = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm';

export default function DeviceHelpForm() {
  const { t } = useTranslation('devices');
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('checking');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const value = readHelpToken(window.location.hash);
    setToken(value);
    if (!value) { setPhase('invalid'); return; }
    const abort = new AbortController();
    setPhase('checking');
    void fetch(`${API_BASE}/api/v1/device-help/public/check`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
      signal: abort.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('check_failed');
        const body = (await res.json()) as { valid?: boolean };
        setPhase(body.valid ? 'ready' : 'invalid');
      })
      .catch(() => { if (!abort.signal.aborted) setPhase('error'); });
    return () => abort.abort();
  }, [retry]);

  function onScreenshotChange(file: File | undefined) {
    if (!file) { setScreenshotError(null); return; }
    if (!IMAGE_TYPES.includes(file.type)) setScreenshotError(t('deviceHelp.form.screenshotWrongType'));
    else if (file.size > MAX_SCREENSHOT_BYTES) setScreenshotError(t('deviceHelp.form.screenshotTooLarge'));
    else setScreenshotError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || screenshotError) return;
    const data = new FormData(event.currentTarget);
    data.set('token', token);
    const shot = data.get('screenshot');
    if (shot instanceof File && shot.size === 0) data.delete('screenshot');
    setBusy(true);
    try {
      const result = await runAction<{ ticketNumber?: string | null }>({
        request: () => fetch(`${API_BASE}/api/v1/device-help/public/submit`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          body: data,
        }),
        treatUnauthorizedAsError: true,
        errorFallback: t('deviceHelp.form.failed'),
        successMessage: t('deviceHelp.form.sentPlain'),
      });
      setTicketNumber(result?.ticketNumber ?? null);
      setPhase('sent');
    } catch {
      // runAction already showed the server's message.
    } finally {
      setBusy(false);
    }
  }

  function another() {
    formRef.current?.reset();
    setTicketNumber(null);
    setScreenshotError(null);
    setPhase('ready');
  }

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm" data-testid="device-help-form">
      <ToastContainer />
      <h2 className="text-xl font-semibold">{t('deviceHelp.form.title')}</h2>
      {phase === 'checking' && <p role="status">{t('deviceHelp.form.checking')}</p>}
      {phase === 'invalid' && <p role="alert" data-testid="device-help-invalid">{t('deviceHelp.form.invalid')}</p>}
      {phase === 'error' && (
        <div className="space-y-2">
          <p role="alert">{t('deviceHelp.form.loadFailed')}</p>
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => setRetry((n) => n + 1)}>
            {t('deviceHelp.form.retry')}
          </button>
        </div>
      )}
      {phase === 'sent' && (
        <div className="space-y-3">
          <p role="status" data-testid="device-help-sent">
            {ticketNumber ? t('deviceHelp.form.sentWithNumber', { number: ticketNumber }) : t('deviceHelp.form.sentPlain')}
          </p>
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={another}>
            {t('deviceHelp.form.another')}
          </button>
        </div>
      )}
      {phase === 'ready' && (
        <form ref={formRef} className="space-y-3" onSubmit={(e) => void onSubmit(e)}>
          <p className="text-sm text-muted-foreground">{t('deviceHelp.form.intro')}</p>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.name')}
            <input name="name" required maxLength={120} autoComplete="name" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.phone')}
            <input name="phone" type="tel" required minLength={3} maxLength={40} autoComplete="tel" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.company')}
            <input name="company" required maxLength={160} autoComplete="organization" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.email')}
            <input name="email" type="email" required maxLength={254} autoComplete="email" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.details')}
            <textarea name="details" required minLength={5} maxLength={5000} rows={5} className={inputClass} aria-describedby="device-help-details-hint" />
            <span id="device-help-details-hint" className="mt-1 block text-xs font-normal text-muted-foreground">{t('deviceHelp.form.detailsHint')}</span>
          </label>
          <label className="block text-sm font-medium">
            {t('deviceHelp.form.screenshot')}
            <input
              name="screenshot"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="mt-1 block w-full text-sm"
              aria-describedby="device-help-screenshot-hint"
              onChange={(e) => onScreenshotChange(e.target.files?.[0])}
            />
            <span id="device-help-screenshot-hint" className="mt-1 block text-xs font-normal text-muted-foreground">{t('deviceHelp.form.screenshotHint')}</span>
            {screenshotError && <span role="alert" className="mt-1 block text-xs text-destructive">{screenshotError}</span>}
          </label>
          <button
            type="submit"
            disabled={busy || Boolean(screenshotError)}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            data-testid="device-help-submit"
          >
            {busy ? t('deviceHelp.form.sending') : t('deviceHelp.form.submit')}
          </button>
        </form>
      )}
    </div>
  );
}
