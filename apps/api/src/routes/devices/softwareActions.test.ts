import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: { id: 'id', deviceId: 'deviceId', type: 'type', status: 'status' },
  devices: { id: 'id' },
  softwareInventory: { deviceId: 'deviceId', name: 'name', installLocation: 'installLocation', uninstallString: 'uninstallString' },
}));

const dispatchScriptToDeviceMock = vi.fn();
vi.mock('../../services/scriptDispatch', () => ({
  dispatchScriptToDevice: (...args: unknown[]) => dispatchScriptToDeviceMock(...args),
}));
vi.mock('../../services/scriptDeferredDelivery', () => ({
  deliverDeferredDispatch: vi.fn(async (d: unknown) => d),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(
    (resource: string, action: string) => async (c: any, next: any) => {
      if (c.req.header('x-deny-devices-execute') === 'true' && resource === 'devices' && action === 'execute') {
        return c.json({ error: 'Permission denied' }, 403);
      }
      // Production `requirePermission` ALWAYS populates `permissions`; the
      // canAccessDeviceSite helper fails closed when it is absent (T10), so the
      // mock must mirror that — set an unrestricted context by default, and add
      // a site restriction only when the test asks for one.
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true'
          ? { allowedSiteIds: ['site-allowed'] }
          : {}),
      });
      return next();
    }
  ),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-mfa') === 'true') {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  }),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
}));

const queueCommandForExecutionMock = vi.fn();

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    SOFTWARE_UPDATE: 'software_update',
    SOFTWARE_UNINSTALL: 'software_uninstall',
  },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...args),
}));

const resolveWindowsUpdatePackageIdMock = vi.fn();

vi.mock('../../services/softwareUpdateTarget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/softwareUpdateTarget')>()),
  resolveWindowsUpdatePackageId: (...args: unknown[]) => resolveWindowsUpdatePackageIdMock(...args),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandAudit', () => ({
  commandAuditDetails: vi.fn((id: string, type: string) => ({ commandId: id, commandType: type })),
}));

import { softwareActionsRoutes } from './softwareActions';
import { getDeviceWithOrgCheck } from './helpers';
import { db } from '../../db';

describe('device software actions routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    queueCommandForExecutionMock.mockReset();
    resolveWindowsUpdatePackageIdMock.mockReset();
    resolveWindowsUpdatePackageIdMock.mockResolvedValue(null);
    app = new Hono();
    app.route('/devices', softwareActionsRoutes);
  });

  describe('POST /devices/:id/software/update', () => {
    it('queues a software_update command for a valid device + payload', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-1', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        commandId: 'cmd-1',
        commandStatus: 'sent',
        action: 'update',
        name: 'Google Chrome',
      });
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Google Chrome', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('passes version through to the agent payload on a Windows device', async () => {
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'Google.Chrome', via: 'detected_update' });
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'windows',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-2', status: 'pending' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        {
          name: 'Google.Chrome',
          displayName: 'Google Chrome',
          packageId: 'Google.Chrome',
          version: '125.0.6422.142',
          source: 'device_software_tab',
        },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('passes a winget packageId through to the agent payload on Windows', async () => {
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'Mozilla.Firefox', via: 'request' });
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'windows',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-pkg', status: 'pending' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mozilla Firefox', packageId: 'Mozilla.Firefox' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        {
          name: 'Mozilla.Firefox',
          displayName: 'Mozilla Firefox',
          packageId: 'Mozilla.Firefox',
          source: 'device_software_tab',
        },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    // fork: the OBS Studio regression — a name-only Windows update must be
    // pinned to the winget id the agent reported, never sent by name.
    it('resolves the exact winget id server-side when the client sends a name only', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1', orgId: 'org-123', siteId: null, hostname: 'host-1', status: 'online', osType: 'windows',
      });
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'OBSProject.OBSStudio', via: 'detected_update' });
      queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-obs', status: 'pending' } });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'OBS Studio' }),
      });

      expect(res.status).toBe(200);
      expect(resolveWindowsUpdatePackageIdMock).toHaveBeenCalledWith('device-1', 'OBS Studio', undefined);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        {
          name: 'OBSProject.OBSStudio',
          displayName: 'OBS Studio',
          packageId: 'OBSProject.OBSStudio',
          source: 'device_software_tab',
        },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('refuses a Windows update when no exact winget package can be determined', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1', orgId: 'org-123', siteId: null, hostname: 'host-1', status: 'online', osType: 'windows',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'OBS Studio' }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('PACKAGE_UNRESOLVED');
      expect(body.error).toContain('exact winget package');
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('does not forward packageId on a non-Windows device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'macos',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-pkg2', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mozilla Firefox', packageId: 'Mozilla.Firefox' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Mozilla Firefox', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('rejects a malformed packageId before queueing', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Firefox', packageId: 'Mozilla.Firefox;rm -rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it.each(['macos', 'linux'])(
      'rejects a version pin with 422 on a %s device (agent ignores it)',
      async (osType) => {
        (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'device-1',
          orgId: 'org-123',
          siteId: null,
          hostname: 'host-1',
          status: 'online',
          osType,
        });

        const res = await app.request('/devices/device-1/software/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
        });

        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error).toContain(osType);
        expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
      }
    );

    it('allows a version-less update on a non-Windows device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'macos',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-3', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Google Chrome', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('returns 404 when the device cannot be found by org', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.request('/devices/missing/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(404);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 400 for decommissioned devices', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'decommissioned',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('rejects payload with shell metacharacters in name', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome;rm -rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('rejects payload with leading dash in name', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '-rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 403 when MFA gate denies the request', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deny-mfa': 'true' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 503 when the command could not be queued', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        error: 'Device is offline, cannot execute command',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('offline');
    });

    it('returns 403 when permission check denies devices.execute', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deny-devices-execute': 'true' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /devices/:id/software/uninstall', () => {
    it('queues a software_uninstall command for a valid device + payload', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-3', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        commandId: 'cmd-3',
        action: 'uninstall',
        name: 'Slack',
      });
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_uninstall',
        { name: 'Slack', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('returns 403 when site permission denies the device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: 'site-other',
        hostname: 'host-1',
        status: 'online',
      });

      const res = await app.request('/devices/device-1/software/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-site-restricted': 'true' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });
  });

  // fork: "Close app and update"
  describe('POST /devices/:id/software/close-and-update', () => {
    const windowsDevice = { id: 'device-1', orgId: 'org-123', siteId: null, hostname: 'host-1', status: 'online', osType: 'windows' };
    const inventory = (rows: unknown[]) => {
      const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    };
    const post = (body: unknown) =>
      app.request('/devices/device-1/software/close-and-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      dispatchScriptToDeviceMock.mockReset();
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(windowsDevice);
    });

    it('dispatches one SYSTEM script that closes the app folder and upgrades the exact id', async () => {
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'OBSProject.OBSStudio', via: 'detected_update' });
      inventory([{ installLocation: null, uninstallString: '"C:\\Program Files\\obs-studio\\uninstall.exe"' }]);
      dispatchScriptToDeviceMock.mockResolvedValue({ ok: true, commandId: 'cmd-close', executionId: 'exec-1' });

      const res = await post({ name: 'OBS Studio' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        commandId: 'cmd-close',
        packageId: 'OBSProject.OBSStudio',
        appFolder: 'C:\\Program Files\\obs-studio',
      });
      const input = dispatchScriptToDeviceMock.mock.calls[0]![0];
      expect(input).toMatchObject({
        runAs: 'system',
        createdBy: 'user-123',
        offlinePolicy: { kind: 'reject' },
        deferDelivery: true,
        source: { kind: 'raw', language: 'powershell', provenance: 'software_close_and_update' },
      });
      expect(input.source.content).toContain("$packageId = 'OBSProject.OBSStudio'");
      expect(input.source.content).toContain("$appDir = 'C:\\Program Files\\obs-studio'");
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('refuses when the install folder is unknown or too broad', async () => {
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'Some.App', via: 'request' });
      inventory([{ installLocation: 'C:\\Program Files', uninstallString: 'MsiExec.exe /X{1}' }]);
      const res = await post({ name: 'Some App', packageId: 'Some.App' });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('APP_FOLDER_UNKNOWN');
      expect(dispatchScriptToDeviceMock).not.toHaveBeenCalled();
    });

    it('refuses when the exact package is unknown', async () => {
      const res = await post({ name: 'OBS Studio' });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('PACKAGE_UNRESOLVED');
      expect(dispatchScriptToDeviceMock).not.toHaveBeenCalled();
    });

    it('is Windows-only', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ ...windowsDevice, osType: 'macos' });
      const res = await post({ name: 'Firefox' });
      expect(res.status).toBe(422);
      expect(dispatchScriptToDeviceMock).not.toHaveBeenCalled();
    });

    it('reports an offline device as 409 instead of queueing', async () => {
      resolveWindowsUpdatePackageIdMock.mockResolvedValue({ packageId: 'OBSProject.OBSStudio', via: 'detected_update' });
      inventory([{ installLocation: 'C:\\Program Files\\obs-studio', uninstallString: null }]);
      dispatchScriptToDeviceMock.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline' });
      const res = await post({ name: 'OBS Studio' });
      expect(res.status).toBe(409);
    });
  });
});
