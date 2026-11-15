import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  getDevice: vi.fn(),
  queue: vi.fn(),
  waitForResult: vi.fn(),
  resolve: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbTransaction: (fn: () => unknown) => fn(),
}));

vi.mock('../../db/schema', () => ({
  softwareInventory: { deviceId: 'deviceId', name: 'name', installLocation: 'installLocation', uninstallString: 'uninstallString' },
  deviceCommands: { id: 'id', deviceId: 'deviceId', type: 'type', status: 'status', createdAt: 'createdAt', completedAt: 'completedAt', result: 'result', payload: 'payload' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-123' }, scope: 'organization', orgId: 'org-123', token: { mfa: true } });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const permissions = [{ resource: 'devices', action: 'execute' }, { resource: 'devices', action: 'read' }];
    if (c.req.header('x-no-scripts') !== 'true') permissions.push({ resource: 'scripts', action: 'execute' });
    c.set('permissions', { permissions, partnerId: null, orgId: 'org-123', roleId: 'role', scope: 'organization' });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: h.getDevice,
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SOFTWARE_UPDATE: 'software_update', NOTIFY_USER: 'notify_user' },
  queueCommandForExecution: h.queue,
  waitForCommandResult: h.waitForResult,
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: h.audit }));

vi.mock('../../services/softwareUpdateTarget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/softwareUpdateTarget')>()),
  resolveWindowsUpdatePackageId: h.resolve,
}));

vi.mock('../../services/scriptDispatch', () => ({ dispatchScriptToDevice: h.dispatch }));
vi.mock('../../services/scriptDeferredDelivery', () => ({ deliverDeferredDispatch: vi.fn(async (d: unknown) => d) }));

import { softwareUpdateBatchRoutes } from './softwareUpdateBatch';

const DEVICE = { id: 'device-1', orgId: 'org-123', siteId: null, hostname: 'ROG', status: 'online', osType: 'windows' };
const IDS: Record<string, string> = { 'OBS Studio': 'OBSProject.OBSStudio', Zoom: 'Zoom.Zoom' };
const FOLDERS: Record<string, unknown[]> = {
  'OBS Studio': [{ installLocation: null, uninstallString: '"C:\\Program Files\\obs-studio\\uninstall.exe"' }],
  Zoom: [{ installLocation: 'C:\\Program Files\\Zoom', uninstallString: null }],
};

/** db.select(...).from(...).where(...).limit(n) resolving to rows chosen per call. */
function inventory(rowsFor: (call: number) => unknown[]) {
  let call = 0;
  h.select.mockImplementation(() => {
    const rows = rowsFor(call++);
    const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows) };
    return chain;
  });
}

const detectOutput = (programs: Record<string, string[]>) => ({
  status: 'completed',
  result: {
    stdout: Object.entries(programs)
      .map(([id, list]) => `BREEZE_SOFTWARE_UPDATE ${JSON.stringify({ phase: 'detect', packageId: id, programs: list })}`)
      .join('\r\n'),
  },
});

let app: Hono;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request('/devices/device-1/software/update-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  app = new Hono();
  app.route('/devices', softwareUpdateBatchRoutes);
  h.getDevice.mockResolvedValue(DEVICE);
  h.resolve.mockImplementation(async (_d: string, name: string) => (IDS[name] ? { packageId: IDS[name], via: 'detected_update' } : null));
  const names = ['OBS Studio', 'Zoom'];
  inventory((call) => FOLDERS[names[call] ?? ''] ?? []);
  let n = 0;
  h.dispatch.mockImplementation(async () => ({ ok: true, commandId: `cmd-${++n}`, executionId: null }));
  h.queue.mockResolvedValue({ command: { id: 'notify-1' } });
});

describe('POST /devices/:id/software/update-batch', () => {
  it('detects blockers, sends ONE combined notice, then ONE update script for the batch', async () => {
    h.waitForResult.mockResolvedValue(detectOutput({ 'OBSProject.OBSStudio': ['Google Chrome', 'Opera'], 'Zoom.Zoom': ['Google Chrome'] }));

    const res = await post({ items: [{ name: 'OBS Studio' }, { name: 'Zoom' }] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      delivery: 'script',
      commandId: 'cmd-2',
      detection: 'done',
      notified: true,
      packages: [
        { name: 'OBS Studio', packageId: 'OBSProject.OBSStudio', programs: ['Google Chrome', 'Opera'] },
        { name: 'Zoom', packageId: 'Zoom.Zoom', programs: ['Google Chrome'] },
      ],
    });

    // detect, then update — both SYSTEM scripts owned by the requester
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    const [detect, update] = h.dispatch.mock.calls.map((c) => c[0]);
    expect(detect.source.provenance).toBe('software_update_detect');
    expect(detect.source.content).not.toContain('Stop-Process');
    expect(update.source.provenance).toBe('software_update_guarded');
    expect(update.source.content).toContain("Dir = 'C:\\Program Files\\obs-studio'");
    expect(update.source.content).toContain("Dir = 'C:\\Program Files\\Zoom'");
    expect(update.source.content).not.toContain('Stop-Process');
    expect(update).toMatchObject({ runAs: 'system', createdBy: 'user-123', offlinePolicy: { kind: 'reject' } });

    // one notification naming every blocking program once
    const notices = h.queue.mock.calls.filter((c) => c[1] === 'notify_user');
    expect(notices).toHaveLength(1);
    expect(notices[0]![2].body).toContain('close Google Chrome, Opera so OBS Studio, Zoom can update');
    expect(h.queue.mock.calls.some((c) => c[1] === 'software_update')).toBe(false);
  });

  it('just announces the updates when nothing blocks them', async () => {
    h.waitForResult.mockResolvedValue(detectOutput({ 'OBSProject.OBSStudio': [] }));
    const res = await post({ items: [{ name: 'OBS Studio' }] });
    expect(res.status).toBe(200);
    expect(h.queue.mock.calls[0]![2]).toMatchObject({ body: 'Your IT team is updating OBS Studio.', urgency: 'normal' });
  });

  it('force mode ships the stop-and-update script', async () => {
    h.waitForResult.mockResolvedValue(detectOutput({ 'OBSProject.OBSStudio': ['Google Chrome'] }));
    await post({ items: [{ name: 'OBS Studio' }], mode: 'force' });
    expect(h.dispatch.mock.calls[1]![0].source.content).toContain('Stop-Process');
    expect(h.queue.mock.calls[0]![2].body).toContain('These programs will be closed');
  });

  it('skips packages it cannot pin to an exact id, and refuses when none are left', async () => {
    h.waitForResult.mockResolvedValue(detectOutput({}));
    const mixed = await (await post({ items: [{ name: 'OBS Studio' }, { name: 'Mystery App' }] })).json();
    expect(mixed.skipped).toEqual([{ name: 'Mystery App', reason: 'package_unresolved' }]);

    h.dispatch.mockClear();
    h.resolve.mockResolvedValue(null);
    const res = await post({ items: [{ name: 'Mystery App' }] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PACKAGE_UNRESOLVED');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to queued software_update per package when the device is offline', async () => {
    h.dispatch.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline' });
    h.queue.mockImplementation(async () => ({ command: { id: `q-${h.queue.mock.calls.length}` } }));

    const body = await (await post({ items: [{ name: 'OBS Studio' }, { name: 'Zoom' }] })).json();

    expect(body).toMatchObject({ delivery: 'queued', reason: 'offline', notified: false });
    const updates = h.queue.mock.calls.filter((c) => c[1] === 'software_update');
    expect(updates.map((c) => c[2])).toEqual([
      { name: 'OBSProject.OBSStudio', packageId: 'OBSProject.OBSStudio', displayName: 'OBS Studio', source: 'device_software_tab' },
      { name: 'Zoom.Zoom', packageId: 'Zoom.Zoom', displayName: 'Zoom', source: 'device_software_tab' },
    ]);
  });

  it('falls back to queued software_update without scripts.execute; Close & update needs it', async () => {
    const plain = await (await post({ items: [{ name: 'OBS Studio' }] }, { 'x-no-scripts': 'true' })).json();
    expect(plain).toMatchObject({ delivery: 'queued', reason: 'no_script_permission' });
    expect(h.dispatch).not.toHaveBeenCalled();

    const force = await post({ items: [{ name: 'OBS Studio' }], mode: 'force' }, { 'x-no-scripts': 'true' });
    expect(force.status).toBe(403);
  });

  it('still updates when detection times out', async () => {
    h.waitForResult.mockResolvedValue({ status: 'timeout', result: null });
    const body = await (await post({ items: [{ name: 'OBS Studio' }] })).json();
    expect(body).toMatchObject({ delivery: 'script', detection: 'timeout' });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('is Windows-only', async () => {
    h.getDevice.mockResolvedValue({ ...DEVICE, osType: 'macos' });
    expect((await post({ items: [{ name: 'Firefox' }] })).status).toBe(422);
  });
});

describe('GET /devices/:id/software/update-status', () => {
  it('returns the latest state per package from recent update commands', async () => {
    inventory(() => [
      {
        id: 'cmd-2', type: 'software_update', status: 'failed',
        createdAt: '2026-11-15T05:32:55Z', completedAt: '2026-11-15T05:33:02Z',
        payload: { name: 'OBSProject.OBSStudio', packageId: 'OBSProject.OBSStudio', displayName: 'OBS Studio' },
        result: { error: 'Files modified by the installer are currently in use by a different application.\nInstaller failed with exit code: 6' },
      },
      {
        id: 'cmd-1', type: 'software_update', status: 'completed',
        createdAt: '2026-11-15T05:02:18Z', completedAt: '2026-11-15T05:02:35Z',
        payload: { packageId: 'CodecGuide.K-LiteCodecPack.Standard', displayName: 'K-Lite Codec Pack 20.1.0 Standard' },
        result: { status: 'completed', exitCode: 0 },
      },
    ]);
    const res = await app.request('/devices/device-1/software/update-status');
    expect(res.status).toBe(200);
    const { packages } = await res.json();
    expect(packages).toEqual([
      expect.objectContaining({
        packageId: 'OBSProject.OBSStudio', name: 'OBS Studio', state: 'failed',
        message: 'Files are in use by another program, installer exit code 6', commandId: 'cmd-2',
      }),
      expect.objectContaining({ packageId: 'CodecGuide.K-LiteCodecPack.Standard', state: 'succeeded', message: null }),
    ]);
  });

  it('returns an empty list when nothing was updated recently', async () => {
    inventory(() => []);
    expect(await (await app.request('/devices/device-1/software/update-status')).json()).toEqual({ packages: [] });
  });
});
