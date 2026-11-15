// fork: technician side of the per-device "Get help" link.
//
//   GET  /device-help/devices/:deviceId          -> link, state, shortcut script ids
//   POST /device-help/devices/:deviceId/rotate   -> new link (old one stops working)
//   POST /device-help/devices/:deviceId/disable  -> no link works until the next rotate
//
// Session auth + device permission + the device's org and site access, like
// the other single-device routes. The link is derived on demand
// (services/deviceHelp/helpLinkToken.ts), so GET can always show it again.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { scripts } from '../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { getDeviceWithOrgCheck } from './devices/helpers';
import { PERMISSIONS } from '../services/permissions';
import { canAccessDeviceSite, resolvePrincipalSitePermissions } from '../services/deviceSiteAccess';
import { createAuditLog } from '../services/auditService';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import {
  HelpLinkUnavailableError,
  disableHelpLink,
  getHelpLinkState,
  helpLinkUrl,
  mintHelpToken,
  rotateHelpLink,
  type HelpLinkState,
} from '../services/deviceHelp/helpLinkToken';
import { HELP_SHORTCUT_SCRIPT_NAMES } from '../services/deviceHelp/helpShortcutScripts';

export const deviceHelpRoutes = new Hono();

const deviceParam = z.object({ deviceId: z.string().uuid() });
type ShortcutOs = keyof typeof HELP_SHORTCUT_SCRIPT_NAMES;

deviceHelpRoutes.use('*', authMiddleware);
deviceHelpRoutes.use('*', requireScope('organization', 'partner', 'system'));

async function loadDevice(c: Context, deviceId: string) {
  const auth = c.get('auth') as AuthContext;
  const device = await getDeviceWithOrgCheck(deviceId, auth);
  if (!device) return null;
  if (!canAccessDeviceSite(resolvePrincipalSitePermissions(c), device.siteId)) return null;
  return device;
}

async function shortcutScriptIds(): Promise<Partial<Record<ShortcutOs, string>>> {
  const names = Object.values(HELP_SHORTCUT_SCRIPT_NAMES);
  const rows = await db
    .select({ id: scripts.id, name: scripts.name })
    .from(scripts)
    .where(and(inArray(scripts.name, names), eq(scripts.isSystem, true), isNull(scripts.deletedAt)));
  const out: Partial<Record<ShortcutOs, string>> = {};
  for (const os of Object.keys(HELP_SHORTCUT_SCRIPT_NAMES) as ShortcutOs[]) {
    const row = rows.find((r) => r.name === HELP_SHORTCUT_SCRIPT_NAMES[os]);
    if (row) out[os] = row.id;
  }
  return out;
}

function view(deviceId: string, state: HelpLinkState) {
  return { enabled: state.enabled, url: state.enabled ? helpLinkUrl(mintHelpToken(deviceId, state.version)) : null };
}

function unavailable(c: Context) {
  return c.json({ error: 'Help links are unavailable right now (state store offline). Try again shortly.' }, 503);
}

deviceHelpRoutes.get(
  '/devices/:deviceId',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceParam),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const device = await loadDevice(c, deviceId);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    try {
      const state = await getHelpLinkState(device.id);
      return c.json({ ...view(device.id, state), osType: device.osType, shortcutScriptIds: await shortcutScriptIds() });
    } catch (err) {
      if (err instanceof HelpLinkUnavailableError) return unavailable(c);
      throw err;
    }
  },
);

for (const action of ['rotate', 'disable'] as const) {
  deviceHelpRoutes.post(
    `/devices/:deviceId/${action}`,
    requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
    zValidator('param', deviceParam),
    async (c) => {
      const { deviceId } = c.req.valid('param');
      const device = await loadDevice(c, deviceId);
      if (!device) return c.json({ error: 'Device not found' }, 404);
      let state: HelpLinkState;
      try {
        state = action === 'rotate' ? await rotateHelpLink(device.id) : await disableHelpLink(device.id);
      } catch (err) {
        if (err instanceof HelpLinkUnavailableError) return unavailable(c);
        throw err;
      }
      const auth = c.get('auth') as AuthContext;
      await createAuditLog({
        orgId: device.orgId,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: `device.help_link.${action}`,
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        details: { version: state.version },
        ipAddress: getTrustedClientIpOrUndefined(c),
        result: 'success',
      });
      return c.json(view(device.id, state));
    },
  );
}
