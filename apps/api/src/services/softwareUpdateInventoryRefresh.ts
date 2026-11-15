/**
 * fork: refresh a device's inventory after a software update finishes.
 *
 * The agent only re-sends its software list on its own schedule, so after a
 * successful update the Software tab kept offering "Update" for a package that
 * was already current. When an update run finishes (a guarded update script, or
 * a plain `software_update` that succeeded) the result handler calls this, and
 * once the result has committed one `refresh_inventory` is queued for the
 * device — skipped while another refresh for it is still pending or in flight,
 * so a batch of plain updates finishing together asks only once.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { db, runAfterDbContextCommit, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';
import { CommandTypes } from './commandTypes';
import { UPDATE_PROVENANCE } from './softwareGuardedUpdate';

/** A refresh queued this recently and not yet finished covers a new request. */
const DEDUPE_WINDOW_MS = 10 * 60_000;

/** Did this command run a software update whose finish should refresh inventory? */
export function isFinishedSoftwareUpdate(
  command: { type: string; payload: unknown },
  resultStatus: string | undefined
): boolean {
  if (command.type === CommandTypes.SOFTWARE_UPDATE) return resultStatus === 'completed';
  if (command.type === 'script') {
    const payload = (command.payload ?? {}) as Record<string, unknown>;
    // A guarded run reports per package; any finish may have updated something.
    return payload.scriptId === UPDATE_PROVENANCE;
  }
  return false;
}

/** Queue one refresh_inventory for the device once the current transaction commits. */
export function scheduleInventoryRefreshAfterUpdate(deviceId: string): void {
  runAfterDbContextCommit('software.update.inventory_refresh', async () => {
    try {
      await withSystemDbAccessContext(async () => {
        const [inFlight] = await db
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.type, CommandTypes.REFRESH_INVENTORY),
              inArray(deviceCommands.status, ['pending', 'sent']),
              gte(deviceCommands.createdAt, new Date(Date.now() - DEDUPE_WINDOW_MS))
            )
          )
          .limit(1);
        if (inFlight) return;
        // Imported lazily: the command queue pulls in the result-handler
        // registry, which imports this module.
        const { queueCommandForExecution } = await import('./commandQueue');
        const queued = await queueCommandForExecution(deviceId, CommandTypes.REFRESH_INVENTORY, {}, { preferHeartbeat: false });
        if (!queued.command) {
          console.warn('[softwareUpdate] inventory refresh not queued', { deviceId, error: queued.error });
        }
      });
    } catch (err) {
      // The scheduled inventory scan catches up anyway.
      console.error('[softwareUpdate] inventory refresh after update failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
