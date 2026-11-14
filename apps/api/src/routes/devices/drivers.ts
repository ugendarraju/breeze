// fork: device Drivers tab. Reads the latest Driver Scan / Driver Install runs
// back from script_executions and starts new runs of those system library
// scripts (services/driverScripts.ts). No table of its own: the scan document is
// the stdout of the last completed scan run, validated on read.
import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { scriptExecutions, scripts } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
  type AuthContext,
} from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  DRIVER_INSTALL_SCRIPT_NAME,
  DRIVER_SCAN_SCRIPT_NAME,
  DRIVER_TOOL_INSTALL_SCRIPT_NAME,
  OEM_TOOL_WINGET_IDS,
  OEM_VENDORS,
  oemVendorFromManufacturer,
  parseDriverInstallOutput,
  parseDriverScanOutput,
} from '../../services/driverScripts';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { executeScriptOnDevices } from '../../services/scriptExecution';
import { canAccessDeviceSite, getDeviceWithOrgCheck } from './helpers';

export const driversRoutes = new Hono();

driversRoutes.use('*', authMiddleware);

const SCRIPT_NAMES = [DRIVER_SCAN_SCRIPT_NAME, DRIVER_INSTALL_SCRIPT_NAME, DRIVER_TOOL_INSTALL_SCRIPT_NAME];
const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'cancelling']);

async function driverScriptIds(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: scripts.id, name: scripts.name })
    .from(scripts)
    .where(and(inArray(scripts.name, SCRIPT_NAMES), eq(scripts.isSystem, true), isNull(scripts.deletedAt)));
  return new Map(rows.map((r) => [r.name, r.id]));
}

async function latestRun(deviceId: string, scriptId: string | undefined, completedOnly = false) {
  if (!scriptId) return null;
  const [row] = await db
    .select({
      id: scriptExecutions.id,
      status: scriptExecutions.status,
      createdAt: scriptExecutions.createdAt,
      completedAt: scriptExecutions.completedAt,
      exitCode: scriptExecutions.exitCode,
      stdout: scriptExecutions.stdout,
      errorMessage: scriptExecutions.errorMessage,
      parameters: scriptExecutions.parameters,
    })
    .from(scriptExecutions)
    .where(and(
      eq(scriptExecutions.deviceId, deviceId),
      eq(scriptExecutions.scriptId, scriptId),
      ...(completedOnly ? [eq(scriptExecutions.status, 'completed')] : []),
    ))
    .orderBy(desc(scriptExecutions.createdAt))
    .limit(1);
  return row ?? null;
}

type Run = NonNullable<Awaited<ReturnType<typeof latestRun>>>;

const runSummary = (run: Run | null) => run && {
  executionId: run.id,
  status: run.status,
  createdAt: run.createdAt,
  completedAt: run.completedAt,
  exitCode: run.exitCode,
  errorMessage: run.errorMessage,
};

/** The last lines of a run's own output, minus the JSON document. */
export function outputTail(stdout: string | null): string | null {
  if (!stdout) return null;
  const lines = stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('::breeze:') && !l.startsWith('{'));
  return lines.slice(-15).join('\n').slice(0, 2000) || null;
}

// GET /devices/:id/drivers - latest driver scan, install and tool-install state.
driversRoutes.get(
  '/:id/drivers',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgCheck(c.req.param('id')!, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.osType !== 'windows') {
      return c.json({ supported: false, scriptsReady: false, scan: null, result: null, install: null, toolInstall: null, suggestedVendor: null, suggestedTool: null });
    }

    const ids = await driverScriptIds();
    const scanId = ids.get(DRIVER_SCAN_SCRIPT_NAME);
    const scan = await latestRun(device.id, scanId);
    const lastCompletedScan = scan?.status === 'completed' ? scan : await latestRun(device.id, scanId, true);
    const install = await latestRun(device.id, ids.get(DRIVER_INSTALL_SCRIPT_NAME));
    const toolInstall = await latestRun(device.id, ids.get(DRIVER_TOOL_INSTALL_SCRIPT_NAME));
    const result = parseDriverScanOutput(lastCompletedScan?.stdout);
    const vendor = oemVendorFromManufacturer(result?.manufacturer);
    // Offer the maker's tool only when the scan saw the maker and not the tool.
    const suggestedVendor = vendor && !result?.oem ? vendor : null;

    return c.json({
      supported: true,
      scriptsReady: ids.size === SCRIPT_NAMES.length,
      scan: runSummary(scan),
      result,
      install: install && {
        ...runSummary(install),
        parameters: install.parameters,
        result: parseDriverInstallOutput(install.stdout),
        output: outputTail(install.stdout),
      },
      toolInstall: toolInstall && { ...runSummary(toolInstall), parameters: toolInstall.parameters, output: outputTail(toolInstall.stdout) },
      suggestedVendor,
      suggestedTool: suggestedVendor ? OEM_TOOL_WINGET_IDS[suggestedVendor] : null,
    });
  }
);

type DriverAction = 'scan' | 'install' | 'install_tool';
const SCRIPT_FOR: Record<DriverAction, string> = {
  scan: DRIVER_SCAN_SCRIPT_NAME,
  install: DRIVER_INSTALL_SCRIPT_NAME,
  install_tool: DRIVER_TOOL_INSTALL_SCRIPT_NAME,
};

async function startDriverRun(c: Context, action: DriverAction, parameters: Record<string, string>) {
  const auth = c.get('auth') as AuthContext;
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgCheck(c.req.param('id')!, auth));
  if (!device) return c.json({ error: 'Device not found' }, 404);
  if (!canAccessDeviceSite(device, permissions)) return c.json({ error: 'Access to this site denied' }, 403);
  if (device.osType !== 'windows') return c.json({ error: 'Drivers are managed on Windows devices only' }, 400);

  const scriptName = SCRIPT_FOR[action];
  const busy = await withAuthDbAccessContext(auth, async () => {
    const ids = await driverScriptIds();
    const scriptId = ids.get(scriptName);
    if (!scriptId) return { scriptId: null, active: null };
    // One install-type run at a time per device: driver installs and the tool
    // install both go through Windows Installer / Windows Update.
    const checks = action === 'scan' ? [scriptId] : [ids.get(DRIVER_INSTALL_SCRIPT_NAME), ids.get(DRIVER_TOOL_INSTALL_SCRIPT_NAME)];
    for (const id of checks) {
      const run = await latestRun(device.id, id);
      if (run && ACTIVE_STATUSES.has(run.status)) return { scriptId, active: run };
    }
    return { scriptId, active: null };
  });
  if (!busy.scriptId) return c.json({ error: 'The driver scripts are not installed on this server yet' }, 503);
  if (busy.active) {
    return c.json({ error: 'A driver run is already in progress on this device', executionId: busy.active.id }, 409);
  }

  const result = await executeScriptOnDevices({
    scriptId: busy.scriptId,
    deviceIds: [device.id],
    parameters,
    triggerType: 'manual',
    auth,
    permissions,
    runInDbContext: (fn) => withAuthDbAccessContext(auth, fn),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const target = result.admission.targets[0];
  if (!target || target.admission !== 'admitted') {
    return c.json({ error: 'The device did not accept the run', reason: target?.reasonCode ?? null }, 409);
  }

  writeRouteAudit(c, {
    orgId: device.orgId,
    action: `device.drivers.${action}`,
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { executionId: target.executionId, ...parameters },
  });
  return c.json({ executionId: target.executionId, delivery: target.delivery ?? null }, 202);
}

// POST /devices/:id/drivers/scan - list drivers and available updates.
driversRoutes.post(
  '/:id/drivers/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  async (c) => startDriverRun(c, 'scan', {})
);

const installSchema = z
  .object({
    updateIds: z.array(z.string().uuid()).max(50).default([]),
    oemVendor: z.enum(OEM_VENDORS).optional(),
    // The technician saw the restart / rollback warning and confirmed it.
    confirm: z.literal(true),
  })
  .refine((b) => b.updateIds.length > 0 || b.oemVendor, { message: 'Choose at least one driver update' });

// POST /devices/:id/drivers/install - install chosen updates. Never restarts.
driversRoutes.post(
  '/:id/drivers/install',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', installSchema),
  async (c) => {
    const body = c.req.valid('json');
    const parameters: Record<string, string> = {};
    if (body.updateIds.length) parameters.update_ids = [...new Set(body.updateIds.map((id) => id.toLowerCase()))].join(',');
    if (body.oemVendor) parameters.oem_vendor = body.oemVendor;
    return startDriverRun(c, 'install', parameters);
  }
);

const toolSchema = z.object({ oemVendor: z.enum(OEM_VENDORS), confirm: z.literal(true) });

// POST /devices/:id/drivers/install-tool - install the maker's update tool via winget.
driversRoutes.post(
  '/:id/drivers/install-tool',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', toolSchema),
  async (c) => startDriverRun(c, 'install_tool', { oem_vendor: c.req.valid('json').oemVendor })
);
