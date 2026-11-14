import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  perms: ['devices:read', 'devices:write'] as string[],
  device: null as null | Record<string, unknown>,
  siteAllowed: true,
  state: { version: 1, enabled: true },
  redisDown: false,
  audit: vi.fn(),
  rotate: vi.fn(),
  disable: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { scope: 'organization', orgId: 'org-1', user: { id: 'user-1', email: 'tech@example.com' } });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!h.perms.includes(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' }, DEVICES_WRITE: { resource: 'devices', action: 'write' } },
}));
vi.mock('./devices/helpers', () => ({ getDeviceWithOrgCheck: vi.fn(async () => h.device) }));
vi.mock('../services/deviceSiteAccess', () => ({
  canAccessDeviceSite: () => h.siteAllowed,
  resolvePrincipalSitePermissions: () => undefined,
}));
vi.mock('../services/auditService', () => ({ createAuditLog: h.audit }));
vi.mock('../db', () => {
  const q: Record<string, unknown> = {};
  q.from = () => q;
  q.where = async () => [{ id: 'script-win', name: 'Get Help Desktop Shortcut (Windows)' }];
  return { db: { select: () => q } };
});
vi.mock('../services/deviceHelp/helpLinkToken', async (orig) => {
  const real = await orig<typeof import('../services/deviceHelp/helpLinkToken')>();
  const guard = () => { if (h.redisDown) throw new real.HelpLinkUnavailableError(); };
  return {
    ...real,
    mintHelpToken: (deviceId: string, version: number) => `tok-${deviceId.slice(0, 4)}-v${version}`,
    getHelpLinkState: vi.fn(async () => { guard(); return h.state; }),
    rotateHelpLink: h.rotate.mockImplementation(async () => { guard(); return { version: h.state.version + 1, enabled: true }; }),
    disableHelpLink: h.disable.mockImplementation(async () => { guard(); return { version: h.state.version, enabled: false }; }),
  };
});

import { deviceHelpRoutes } from './deviceHelp';

const DEVICE = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const app = new Hono().route('/device-help', deviceHelpRoutes);

beforeEach(() => {
  process.env.DASHBOARD_URL = 'https://rmm.example.com';
  h.perms = ['devices:read', 'devices:write'];
  h.device = { id: DEVICE, orgId: 'org-1', siteId: 'site-1', hostname: 'ASUS-ROG', osType: 'windows' };
  h.siteAllowed = true;
  h.state = { version: 1, enabled: true };
  h.redisDown = false;
  h.audit.mockReset();
  h.rotate.mockClear();
  h.disable.mockClear();
});

describe('technician help-link routes', () => {
  it('GET shows the current link, the device OS and the shortcut script ids', async () => {
    const res = await app.request(`/device-help/devices/${DEVICE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      url: 'https://rmm.example.com/help#tok-3f2a-v1',
      osType: 'windows',
      shortcutScriptIds: { windows: 'script-win' },
    });
  });

  it('a disabled link shows no URL', async () => {
    h.state = { version: 3, enabled: false };
    const body = await (await app.request(`/device-help/devices/${DEVICE}`)).json();
    expect(body).toMatchObject({ enabled: false, url: null });
  });

  it('a device in another org, or behind a denied site, is a 404', async () => {
    h.device = null; // getDeviceWithOrgCheck: not found or not this tenant
    expect((await app.request(`/device-help/devices/${DEVICE}`)).status).toBe(404);
    h.device = { id: DEVICE, orgId: 'org-1', siteId: 'site-9', hostname: 'X', osType: 'windows' };
    h.siteAllowed = false;
    expect((await app.request(`/device-help/devices/${DEVICE}`)).status).toBe(404);
    expect((await app.request(`/device-help/devices/${DEVICE}/rotate`, { method: 'POST' })).status).toBe(404);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('reading needs devices.read; rotate and disable need devices.write', async () => {
    h.perms = ['devices:read'];
    expect((await app.request(`/device-help/devices/${DEVICE}`)).status).toBe(200);
    expect((await app.request(`/device-help/devices/${DEVICE}/rotate`, { method: 'POST' })).status).toBe(403);
    expect((await app.request(`/device-help/devices/${DEVICE}/disable`, { method: 'POST' })).status).toBe(403);
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.disable).not.toHaveBeenCalled();
    h.perms = [];
    expect((await app.request(`/device-help/devices/${DEVICE}`)).status).toBe(403);
  });

  it('rotate returns the new link and writes an audit row on the device org', async () => {
    const res = await app.request(`/device-help/devices/${DEVICE}/rotate`, { method: 'POST' });
    expect(await res.json()).toEqual({ enabled: true, url: 'https://rmm.example.com/help#tok-3f2a-v2' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', actorId: 'user-1', action: 'device.help_link.rotate', resourceId: DEVICE, details: { version: 2 },
    }));
  });

  it('disable returns no link and is audited', async () => {
    const res = await app.request(`/device-help/devices/${DEVICE}/disable`, { method: 'POST' });
    expect(await res.json()).toEqual({ enabled: false, url: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'device.help_link.disable' }));
  });

  it('a malformed device id is rejected before any lookup', async () => {
    expect((await app.request('/device-help/devices/not-a-uuid')).status).toBe(400);
  });

  it('503 when the state store is down, and nothing is audited', async () => {
    h.redisDown = true;
    expect((await app.request(`/device-help/devices/${DEVICE}`)).status).toBe(503);
    expect((await app.request(`/device-help/devices/${DEVICE}/rotate`, { method: 'POST' })).status).toBe(503);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
