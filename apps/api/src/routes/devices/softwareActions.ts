import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails } from '../../services/commandAudit';
import { softwareActionPayloadSchema } from '../../services/softwareActionPayload';
import {
  applyWindowsUpdateTarget,
  resolveWindowsUpdatePackageId,
  windowsUpdateUnresolvedMessage,
} from '../../services/softwareUpdateTarget';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { softwareInventory } from '../../db/schema';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import { deliverDeferredDispatch } from '../../services/scriptDeferredDelivery';
import {
  CLOSE_AND_UPDATE_PROVENANCE,
  CLOSE_AND_UPDATE_TIMEOUT_SECONDS,
  buildCloseAndUpdateScript,
  resolveAppFolder,
} from '../../services/softwareCloseAndUpdate';

export const softwareActionsRoutes = new Hono();

softwareActionsRoutes.use('*', authMiddleware);


// POST /devices/:id/software/update — queue a software upgrade for the named package
softwareActionsRoutes.post(
  '/:id/software/update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', softwareActionPayloadSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }
    // Version pinning is only honored by the agent's Windows update path
    // (winget --version). updateSoftwareMacOS/updateSoftwareLinux ignore the
    // version and always upgrade to the latest, so accepting a pin here would
    // silently violate the intended hold. Reject it up front instead. See #993.
    if (data.version && device.osType !== 'windows') {
      return c.json(
        {
          error: `Version pinning is only supported on Windows endpoints; this device runs ${device.osType}. Resubmit without a version to upgrade to the latest available.`,
        },
        422
      );
    }

    const payload: Record<string, unknown> = { name: data.name, source: 'device_software_tab' };
    if (data.version) payload.version = data.version;
    // packageId drives winget's `--id` upgrade and is meaningless to the macOS /
    // Linux agent paths (which upgrade by name). Forward it only on Windows so a
    // stray id can never reach a non-winget package manager — consistent with the
    // Windows-only version-pin gate above.
    // fork: on Windows an update is only dispatched for an exact winget id (see
    // services/softwareUpdateTarget.ts) — never a name-based guess.
    if (device.osType === 'windows') {
      const resolved = await resolveWindowsUpdatePackageId(deviceId, data.name, data.packageId);
      if (!resolved) {
        return c.json({ error: windowsUpdateUnresolvedMessage(data.name), code: 'PACKAGE_UNRESOLVED' }, 422);
      }
      applyWindowsUpdateTarget(payload, data.name, resolved.packageId);
    }

    const queued = await queueCommandForExecution(deviceId, CommandTypes.SOFTWARE_UPDATE, payload, {
      userId: auth.user.id,
      preferHeartbeat: false,
    });

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue software_update command' }, 503);
    }

    const command = queued.command;
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.software.update.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        ...commandAuditDetails(command.id, CommandTypes.SOFTWARE_UPDATE, payload),
        softwareName: data.name,
        softwareVersion: data.version ?? null,
      },
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      name: data.name,
      version: data.version ?? null,
      action: 'update',
    });
  }
);

// fork: POST /devices/:id/software/close-and-update — force-stop whatever is
// using the app's install folder, then upgrade by exact winget id (Windows).
// One server-generated script (services/softwareCloseAndUpdate.ts), run as
// SYSTEM; only sent to a device that is online now.
softwareActionsRoutes.post(
  '/:id/software/close-and-update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  // Runs as a script: delivery-time revalidation checks scripts.execute too.
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  zValidator('json', softwareActionPayloadSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }
    if (device.osType !== 'windows') {
      return c.json({ error: 'Close app and update is only available on Windows devices.' }, 422);
    }
    if (data.version) {
      return c.json({ error: 'Close app and update always installs the latest version; resubmit without a version.' }, 422);
    }

    const resolved = await resolveWindowsUpdatePackageId(deviceId, data.name, data.packageId);
    if (!resolved) {
      return c.json({ error: windowsUpdateUnresolvedMessage(data.name), code: 'PACKAGE_UNRESOLVED' }, 422);
    }
    const [row] = await db
      .select({ installLocation: softwareInventory.installLocation, uninstallString: softwareInventory.uninstallString })
      .from(softwareInventory)
      .where(and(eq(softwareInventory.deviceId, deviceId), eq(softwareInventory.name, data.name)))
      .limit(1);
    const folder = row ? resolveAppFolder(row) : null;
    if (!folder) {
      return c.json(
        {
          error: `The install folder for "${data.name}" is unknown or too broad to close safely. Close the app on the device and use Update instead.`,
          code: 'APP_FOLDER_UNKNOWN',
        },
        422
      );
    }

    const created = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        dispatchScriptToDevice({
          device,
          source: {
            kind: 'raw',
            content: buildCloseAndUpdateScript(folder, resolved.packageId),
            language: 'powershell',
            provenance: CLOSE_AND_UPDATE_PROVENANCE,
          },
          runAs: 'system',
          timeoutSeconds: CLOSE_AND_UPDATE_TIMEOUT_SECONDS,
          triggerType: 'manual',
          triggeredBy: auth.user.id,
          createdBy: auth.user.id,
          // Stopping apps must never fire hours later on someone mid-call.
          offlinePolicy: { kind: 'reject' },
          deferDelivery: true,
        })
      )
    );
    const dispatch = await deliverDeferredDispatch(created, { deviceId, caller: 'softwareCloseAndUpdate' });
    if (!dispatch.ok) {
      const status = dispatch.code === 'device_offline' || dispatch.code === 'maintenance_suppressed' ? 409 : 400;
      return c.json({ error: dispatch.error, code: dispatch.code }, status);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.software.close_and_update.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        softwareName: data.name,
        packageId: resolved.packageId,
        appFolder: folder,
      },
    });

    return c.json({
      success: true,
      commandId: dispatch.commandId,
      executionId: dispatch.executionId,
      name: data.name,
      packageId: resolved.packageId,
      appFolder: folder,
      action: 'close_and_update',
    });
  }
);

// POST /devices/:id/software/uninstall — queue a software uninstall for the named package
softwareActionsRoutes.post(
  '/:id/software/uninstall',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', softwareActionPayloadSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    const payload: Record<string, unknown> = { name: data.name, source: 'device_software_tab' };
    if (data.version) payload.version = data.version;

    const queued = await queueCommandForExecution(deviceId, CommandTypes.SOFTWARE_UNINSTALL, payload, {
      userId: auth.user.id,
      preferHeartbeat: false,
    });

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue software_uninstall command' }, 503);
    }

    const command = queued.command;
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.software.uninstall.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        ...commandAuditDetails(command.id, CommandTypes.SOFTWARE_UNINSTALL, payload),
        softwareName: data.name,
        softwareVersion: data.version ?? null,
      },
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      name: data.name,
      version: data.version ?? null,
      action: 'uninstall',
    });
  }
);
