// fork: PUT /devices/:id/warranty/manual — technician-entered warranty dates.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied, storedRow } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
  storedRow: { current: null as Record<string, unknown> | null },
}));

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => (storedRow.current ? [storedRow.current] : []) }) }) })),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-123', email: 'tech@example.test' }, scope: 'organization', orgId: 'org-123' });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/warrantyWorker', () => ({ queueWarrantySyncForDevice: vi.fn() }));
vi.mock('../../services/customFields/import/warrantyTarget', () => ({ applyWarrantyImport: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { applyWarrantyImport } from '../../services/customFields/import/warrantyTarget';
import { writeRouteAudit } from '../../services/auditEvents';
import { warrantyRoutes } from './warranty';

const DEVICE = { id: 'device-1', orgId: 'org-123' };

function put(app: Hono, body: unknown) {
  return app.request('/devices/device-1/warranty/manual', {
    method: 'PUT',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /devices/:id/warranty/manual (fork)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    storedRow.current = null;
    app = new Hono();
    app.route('/devices', warrantyRoutes);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    vi.mocked(applyWarrantyImport).mockResolvedValue('applied' as never);
  });

  it('saves the dates through the import writer, overriding an empty vendor lookup', async () => {
    storedRow.current = { deviceId: 'device-1', warrantyStartDate: '2019-07-28', warrantyEndDate: '2020-07-28', status: 'expired', dataSource: 'import' };
    const res = await put(app, { warrantyStartDate: '2019-07-28', warrantyEndDate: '2020-07-28' });
    expect(res.status).toBe(200);
    expect(applyWarrantyImport).toHaveBeenCalledWith(
      expect.anything(),
      { deviceId: 'device-1', orgId: 'org-123', warrantyStartDate: '2019-07-28', warrantyEndDate: '2020-07-28' },
      { overrideProvider: true },
    );
    expect((await res.json()).warranty).toMatchObject({ status: 'expired', dataSource: 'import' });
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'device.warranty.manual_update', resourceId: 'device-1', orgId: 'org-123' }),
    );
  });

  it('leaves the start date alone when only the end date is sent', async () => {
    await put(app, { warrantyEndDate: '2027-01-31' });
    expect(vi.mocked(applyWarrantyImport).mock.calls[0]?.[1]).toEqual({
      deviceId: 'device-1', orgId: 'org-123', warrantyEndDate: '2027-01-31',
    });
  });

  it('can clear the dates', async () => {
    const res = await put(app, { warrantyStartDate: null, warrantyEndDate: null });
    expect(res.status).toBe(200);
    expect(vi.mocked(applyWarrantyImport).mock.calls[0]?.[1]).toMatchObject({ warrantyStartDate: null, warrantyEndDate: null });
  });

  it.each([
    [{ warrantyEndDate: '28/07/2020' }, 'non-ISO date'],
    [{ warrantyStartDate: '2020-07-28' }, 'missing end date'],
    [{ warrantyStartDate: '2021-01-01', warrantyEndDate: '2020-07-28' }, 'end before start'],
  ] as Array<[Record<string, string>, string]>)('rejects %j (%s) with 400 and writes nothing', async (body) => {
    const res = await put(app, body);
    expect(res.status).toBe(400);
    expect(applyWarrantyImport).not.toHaveBeenCalled();
  });

  it('404 for an unknown device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    const res = await put(app, { warrantyEndDate: '2027-01-31' });
    expect(res.status).toBe(404);
    expect(applyWarrantyImport).not.toHaveBeenCalled();
  });

  it('403 when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    const res = await put(app, { warrantyEndDate: '2027-01-31' });
    expect(res.status).toBe(403);
    expect(applyWarrantyImport).not.toHaveBeenCalled();
  });

  it('409 when the device reports its own warranty (agent-owned)', async () => {
    vi.mocked(applyWarrantyImport).mockResolvedValue('skipped-provider-owned' as never);
    const res = await put(app, { warrantyEndDate: '2027-01-31' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WARRANTY_AGENT_OWNED');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
