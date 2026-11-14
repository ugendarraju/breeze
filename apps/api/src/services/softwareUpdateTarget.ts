/**
 * fork: resolve the exact winget package a Windows `software_update` targets.
 *
 * The agent's Windows update path tries `winget upgrade --id <packageId>` first
 * but then falls back to `--name <name>`, and a bare name can match a different
 * source's package (e.g. the msstore "OBS Studio" listing, which fails under
 * SYSTEM with 0x8a150107). The agent can't be changed (devices run the signed
 * upstream agent), so the API only dispatches a Windows update once it knows
 * the exact winget id, in this order:
 *
 *  1. an explicit, well-formed `packageId` from the caller;
 *  2. the id of the third-party update the agent itself reported for this
 *     device's package (matched by normalized name, ambiguous names dropped);
 *  3. a single confident `winget_package_index` hit on name AND publisher.
 *
 * Returns null when none of these yields exactly one id; the caller must then
 * refuse the update instead of falling back to a name-based upgrade.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { devicePatches, patches, softwareInventory, wingetPackageIndex } from '../db/schema';
import {
  buildUpdateIndex,
  normalizeSoftwareName,
  toWingetPackageId,
} from '../routes/devices/softwareUpdateMatch';

export type WingetResolutionSource = 'request' | 'detected_update' | 'winget_index';

export interface WingetResolution {
  packageId: string;
  via: WingetResolutionSource;
}

export function windowsUpdateUnresolvedMessage(name: string): string {
  return `Could not determine the exact winget package for "${name}", so no update was sent. Run a patch scan on this device and retry once the update shows a package ID.`;
}

/**
 * Point a Windows `software_update` payload at exactly one winget id. The id
 * also replaces `name`, because the agent retries `winget upgrade --name <name>`
 * when `--id` fails; with the id as the name that retry can't drift to another
 * source's package. The display name is kept in `displayName` for history.
 */
export function applyWindowsUpdateTarget(
  payload: Record<string, unknown>,
  displayName: string,
  packageId: string
): void {
  payload.name = packageId;
  payload.packageId = packageId;
  payload.displayName = displayName;
}

/** "OBS Studio" → "obsstudio"; "OBS Project" → "obsproject". */
function compact(value: string | null | undefined): string {
  return normalizeSoftwareName(value).replace(/ /g, '');
}

export async function resolveWindowsUpdatePackageId(
  deviceId: string,
  name: string,
  requestedPackageId?: string | null
): Promise<WingetResolution | null> {
  const requested = toWingetPackageId(requestedPackageId);
  if (requested) return { packageId: requested, via: 'request' };

  // 2. The update the agent detected for this device (any status: an id is the
  // package's identity whether or not an upgrade is currently pending).
  const reported = await db
    .select({
      title: patches.title,
      packageId: patches.packageId,
      version: patches.version,
      source: patches.source,
    })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(and(eq(devicePatches.deviceId, deviceId), eq(patches.source, 'third_party')));
  const detected = buildUpdateIndex(reported).get(normalizeSoftwareName(name));
  const detectedId = toWingetPackageId(detected?.packageId);
  if (detectedId) return { packageId: detectedId, via: 'detected_update' };

  // 3. winget catalog mirror: manifest path segments must match both the
  // installed name and its publisher, and exactly one package may match.
  const nameKey = compact(name);
  if (!nameKey) return null;
  const [inventoryRow] = await db
    .select({ vendor: softwareInventory.vendor })
    .from(softwareInventory)
    .where(and(eq(softwareInventory.deviceId, deviceId), eq(softwareInventory.name, name)))
    .limit(1);
  const vendorKey = compact(inventoryRow?.vendor);
  if (!vendorKey) return null;

  const candidates = await db
    .select({ packageId: wingetPackageIndex.packageId })
    .from(wingetPackageIndex)
    .where(
      and(
        sql`lower(${wingetPackageIndex.nameSegment}) = ${nameKey}`,
        sql`lower(${wingetPackageIndex.vendorSegment}) = ${vendorKey}`
      )
    )
    .limit(2);
  if (candidates.length !== 1) return null;
  const indexed = toWingetPackageId(candidates[0]!.packageId);
  return indexed ? { packageId: indexed, via: 'winget_index' } : null;
}
