// Fork addition (see CUSTOMIZATIONS.md): manual warranty dates for vendors
// without a usable lookup API (ASUS, Acer, Microsoft, ...). "Check on vendor
// site" opens the manufacturer's own warranty page in the technician's browser
// (serial copied to the clipboard); "Edit dates" saves what they read there via
// PUT /devices/:id/warranty/manual (stored like a CSV-imported warranty).
import { useState } from 'react';
import { ExternalLink, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

/** The manufacturer's public warranty page for a serial, or null when unrecognized. */
export function vendorWarrantyUrl(manufacturer: string | null | undefined, serial: string | null | undefined): string | null {
  const m = (manufacturer ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!m) return null;
  if (m.includes('asus')) return 'https://www.asus.com/global/support/warranty-status-inquiry/';
  if (m.includes('acer')) return 'https://www.acer.com/us-en/support/warranty';
  if (m.includes('microsoft')) return 'https://mybusinessservice.surface.com/';
  if (m.includes('dell')) {
    return serial
      ? `https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(serial)}/overview`
      : 'https://www.dell.com/support/home/en-us';
  }
  if (m.includes('lenovo')) return 'https://pcsupport.lenovo.com/us/en/warrantylookup';
  if (m === 'hp' || m.startsWith('hp') || m.includes('hewlett')) return 'https://support.hp.com/us-en/check-warranty';
  return null;
}

type Props<W> = {
  deviceId: string;
  manufacturer: string | null;
  serialNumber: string | null;
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  onSaved: (warranty: W) => void;
};

export default function WarrantyManualControls<W>({
  deviceId,
  manufacturer,
  serialNumber,
  warrantyStartDate,
  warrantyEndDate,
  onSaved,
}: Props<W>) {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(warrantyStartDate ?? '');
  const [end, setEnd] = useState(warrantyEndDate ?? '');
  const [saving, setSaving] = useState(false);
  const vendorUrl = vendorWarrantyUrl(manufacturer, serialNumber);

  const openVendor = async () => {
    if (!vendorUrl) return;
    if (serialNumber) {
      try {
        await navigator.clipboard.writeText(serialNumber);
        showToast({ type: 'success', message: t('deviceWarrantyCard.manual.serialCopied') });
      } catch {
        /* clipboard blocked: the serial is still shown on the card */
      }
    }
    window.open(vendorUrl, '_blank', 'noopener,noreferrer');
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!end) return;
    setSaving(true);
    try {
      const body = await runAction<{ warranty: W }>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/warranty/manual`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ warrantyStartDate: start || null, warrantyEndDate: end }),
          }),
        errorFallback: t('deviceWarrantyCard.manual.saveFailed'),
        successMessage: t('deviceWarrantyCard.manual.saved'),
      });
      onSaved(body.warranty);
      setEditing(false);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('deviceWarrantyCard.manual.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {vendorUrl && (
        <button
          type="button"
          onClick={() => void openVendor()}
          data-testid="warranty-check-vendor"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted"
        >
          <ExternalLink className="h-4 w-4" />
          {t('deviceWarrantyCard.manual.checkVendor')}
        </button>
      )}
      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="warranty-edit-dates"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted"
        >
          <Pencil className="h-4 w-4" />
          {t('deviceWarrantyCard.manual.editDates')}
        </button>
      ) : (
        <form onSubmit={save} className="flex w-full flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3" data-testid="warranty-edit-form">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t('deviceWarrantyCard.startDate')}</span>
            <input
              type="date"
              value={start}
              max={end || undefined}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="warranty-start-input"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t('deviceWarrantyCard.endDate')}</span>
            <input
              type="date"
              value={end}
              min={start || undefined}
              required
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="warranty-end-input"
            />
          </label>
          <button
            type="submit"
            disabled={saving || !end}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            data-testid="warranty-save-dates"
          >
            {saving ? t('deviceWarrantyCard.manual.saving') : t('common:actions.save')}
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setStart(warrantyStartDate ?? ''); setEnd(warrantyEndDate ?? ''); }}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {t('common:actions.cancel')}
          </button>
        </form>
      )}
    </>
  );
}
