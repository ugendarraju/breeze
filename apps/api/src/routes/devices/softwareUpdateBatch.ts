/**
 * fork: guarded Windows software updates (single, bulk and "Close & update").
 *
 * POST /devices/:id/software/update-batch
 *   1. resolves each requested package to its exact winget id and install folder;
 *   2. runs a short read-only detect script to find the programs holding each
 *      package's files (online devices, ~45 s at most);
 *   3. sends ONE notification to the person signed in to the device naming the
 *      updates and, if any, the programs to close (via the user helper);
 *   4. dispatches ONE update script for the whole batch that updates unblocked
 *      packages first and then waits for (or, mode 'force', stops) the blockers.
 * An offline device, or a caller without scripts.execute, falls back to the
 * plain queued `software_update` command per package (no detection/notice).
 *
 * GET /devices/:id/software/update-runs/latest — the last guarded run's
 * per-package outcome and the programs that blocked it (for the technician).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { deviceCommands, softwareInventory } from '../../db/schema';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { CommandTypes, queueCommandForExecution, waitForCommandResult } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { softwareActionPayloadSchema } from '../../services/softwareActionPayload';
import { applyWindowsUpdateTarget, resolveWindowsUpdatePackageId } from '../../services/softwareUpdateTarget';
import { dispatchScriptToDevice, type DispatchScriptResult } from '../../services/scriptDispatch';
import { deliverDeferredDispatch } from '../../services/scriptDeferredDelivery';
import {
  DETECT_PROVENANCE,
  DETECT_TIMEOUT_SECONDS,
  UPDATE_PROVENANCE,
  buildDetectScript,
  buildGuardedUpdateScript,
  buildUserNotification,
  parseMarkers,
  resolveAppFolder,
  updateTimeoutSeconds,
  type GuardedPackage,
  type UpdateMode,
} from '../../services/softwareGuardedUpdate';

export const softwareUpdateBatchRoutes = new Hono();

softwareUpdateBatchRoutes.use('*', authMiddleware);

const DETECT_WAIT_MS = 45_000;
const NOTIFY_DELIVER_WITHIN_MS = 15 * 60_000;

const updateBatchSchema = z
  .object({
    items: z.array(softwareActionPayloadSchema.omit({ version: true })).min(1).max(50),
    mode: z.enum(['wait', 'force']).default('wait'),
  })
  .strict();

type Skipped = { name: string; reason: 'package_unresolved' };

softwareUpdateBatchRoutes.post(
  '/:id/software/update-batch',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', updateBatchSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { items, mode } = c.req.valid('json') as { items: Array<{ name: string; packageId?: string }>; mode: UpdateMode };
    const permissions = c.get('permissions') as UserPermissions | undefined;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, permissions)) return c.json({ error: 'Access to this site denied' }, 403);
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }
    if (device.osType !== 'windows') {
      return c.json({ error: 'Batch software updates are only available on Windows devices.' }, 422);
    }

    // 1. Exact winget id + install folder per package.
    const targets: GuardedPackage[] = [];
    const skipped: Skipped[] = [];
    for (const item of items) {
      const resolved = await resolveWindowsUpdatePackageId(deviceId, item.name, item.packageId);
      if (!resolved) {
        skipped.push({ name: item.name, reason: 'package_unresolved' });
        continue;
      }
      if (targets.some((t) => t.packageId.toLowerCase() === resolved.packageId.toLowerCase())) continue;
      const [row] = await db
        .select({ installLocation: softwareInventory.installLocation, uninstallString: softwareInventory.uninstallString })
        .from(softwareInventory)
        .where(and(eq(softwareInventory.deviceId, deviceId), eq(softwareInventory.name, item.name)))
        .limit(1);
      targets.push({ packageId: resolved.packageId, name: item.name, folder: row ? resolveAppFolder(row) : null });
    }
    if (targets.length === 0) {
      return c.json(
        { error: 'Could not determine the exact winget package for any of these updates, so nothing was sent.', code: 'PACKAGE_UNRESOLVED', skipped },
        422
      );
    }

    const audit = (details: Record<string, unknown>) =>
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.software.update_batch.queue',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        details: { mode, packages: targets.map((t) => t.packageId), skipped: skipped.map((s) => s.name), ...details },
      });

    // Plain queued software_update per package: no detection, no notice.
    const queuePlain = async (reason: 'offline' | 'no_script_permission') => {
      const commandIds: string[] = [];
      for (const target of targets) {
        const payload: Record<string, unknown> = { name: target.name, source: 'device_software_tab' };
        applyWindowsUpdateTarget(payload, target.name, target.packageId);
        const queued = await queueCommandForExecution(deviceId, CommandTypes.SOFTWARE_UPDATE, payload, {
          userId: auth.user.id,
          preferHeartbeat: false,
        });
        if (queued.command) commandIds.push(queued.command.id);
      }
      audit({ delivery: 'queued', reason, commandIds });
      return c.json({
        success: true,
        delivery: 'queued',
        reason,
        commandIds,
        packages: targets.map((t) => ({ name: t.name, packageId: t.packageId, programs: [] as string[] })),
        skipped,
        notified: false,
      });
    };

    const dispatch = async (content: string, provenance: string, timeoutSeconds: number): Promise<DispatchScriptResult> => {
      const created = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          dispatchScriptToDevice({
            device,
            source: { kind: 'raw', content, language: 'powershell', provenance },
            runAs: 'system',
            timeoutSeconds,
            triggerType: 'manual',
            triggeredBy: auth.user.id,
            createdBy: auth.user.id,
            offlinePolicy: { kind: 'reject' },
            deferDelivery: true,
          })
        )
      );
      return deliverDeferredDispatch(created, { deviceId, caller: provenance });
    };

    // Delivery-time revalidation checks scripts.execute against the requester.
    const canRunScripts = !!permissions
      && hasPermission(permissions, PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action);
    if (!canRunScripts) {
      if (mode === 'force') {
        return c.json({ error: 'Close & update needs permission to run scripts on devices.', code: 'SCRIPTS_PERMISSION_REQUIRED' }, 403);
      }
      return queuePlain('no_script_permission');
    }

    // 2. Which programs hold each package's files right now.
    const programsById = new Map<string, string[]>();
    let detection: 'done' | 'timeout' | 'not_needed' = 'not_needed';
    if (targets.some((t) => t.folder)) {
      const detect = await dispatch(buildDetectScript(targets), DETECT_PROVENANCE, DETECT_TIMEOUT_SECONDS);
      if (!detect.ok) {
        if (detect.code === 'device_offline') {
          if (mode === 'force') return c.json({ error: 'The device is offline.', code: 'device_offline' }, 409);
          return queuePlain('offline');
        }
        return c.json({ error: detect.error, code: detect.code }, detect.code === 'maintenance_suppressed' ? 409 : 400);
      }
      const finished = await runOutsideDbContext(() => waitForCommandResult(detect.commandId, DETECT_WAIT_MS));
      const result = finished.result as { stdout?: string } | null | undefined;
      if (finished.status === 'completed' && result) {
        detection = 'done';
        for (const marker of parseMarkers(result.stdout).detect) programsById.set(marker.packageId, marker.programs);
      } else {
        detection = 'timeout';
      }
    }
    const blockers = targets
      .map((t) => ({ name: t.name, packageId: t.packageId, programs: programsById.get(t.packageId) ?? [] }))
      .filter((b) => b.programs.length > 0);

    // 3. One notice for the person at the device. Best effort: needs the user helper.
    let notified = false;
    try {
      const notice = buildUserNotification(targets.map((t) => t.name), blockers, mode);
      const queued = await withDbTransaction(() =>
        queueCommandForExecution(
          deviceId,
          CommandTypes.NOTIFY_USER,
          { title: notice.title, body: notice.body, urgency: blockers.length > 0 ? 'critical' : 'normal' },
          { userId: auth.user.id, expectedOrgId: device.orgId, offlinePolicy: { kind: 'queue', deliverWithinMs: NOTIFY_DELIVER_WITHIN_MS } }
        )
      );
      notified = !!queued.command;
    } catch (err) {
      console.error('[softwareUpdateBatch] user notification failed', { deviceId, error: err instanceof Error ? err.message : String(err) });
    }

    // 4. One update script for the whole batch.
    const update = await dispatch(buildGuardedUpdateScript(targets, mode), UPDATE_PROVENANCE, updateTimeoutSeconds(targets.length));
    if (!update.ok) {
      if (update.code === 'device_offline' && mode === 'wait') return queuePlain('offline');
      return c.json({ error: update.error, code: update.code }, update.code === 'device_offline' || update.code === 'maintenance_suppressed' ? 409 : 400);
    }

    audit({ delivery: 'script', commandId: update.commandId, blockers, notified, detection });
    return c.json({
      success: true,
      delivery: 'script',
      commandId: update.commandId,
      detection,
      packages: targets.map((t) => ({ name: t.name, packageId: t.packageId, programs: programsById.get(t.packageId) ?? [] })),
      skipped,
      notified,
    });
  }
);

softwareUpdateBatchRoutes.get(
  '/:id/software/update-runs/latest',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [row] = await db
      .select({
        id: deviceCommands.id,
        status: deviceCommands.status,
        createdAt: deviceCommands.createdAt,
        completedAt: deviceCommands.completedAt,
        result: deviceCommands.result,
      })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.type, 'script'),
          sql`${deviceCommands.payload}->>'scriptId' = ${UPDATE_PROVENANCE}`
        )
      )
      .orderBy(desc(deviceCommands.createdAt))
      .limit(1);
    if (!row) return c.json({ run: null });

    const result = row.result as { stdout?: string } | null;
    return c.json({
      run: {
        commandId: row.id,
        status: row.status,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        packages: parseMarkers(result?.stdout).update,
      },
    });
  }
);
