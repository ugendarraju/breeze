// fork: one rule for a device's total disk capacity, shared by the Hardware tab
// (DeviceHardwareInventory) and the Overview's Hardware Summary (DeviceInfoTab).
// The agent's `diskTotalGb` is the system drive only (C: / "/"), so a device
// with several drives must be totalled from its drive list.

export type DiskSizeFields = {
  id?: string;
  device?: string;
  mountPoint?: string;
  totalGb?: number | string;
  sizeGb?: number | string;
  capacityGb?: number | string;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function totalDiskCapacityGb(
  disks: readonly DiskSizeFields[] | null | undefined,
  agentDiskTotalGb: number | null | undefined,
): number | null {
  if (!disks || disks.length === 0) return agentDiskTotalGb ?? null;
  const seen = new Set<string>();
  let total = 0;
  for (const disk of disks) {
    const size = toNumber(disk.totalGb ?? disk.sizeGb ?? disk.capacityGb ?? null);
    const deviceKey = disk.device ?? disk.mountPoint ?? disk.id;
    if (disk.mountPoint === "/" || disk.mountPoint === "C:\\") {
      return size;
    }
    if (deviceKey && !seen.has(deviceKey)) {
      seen.add(deviceKey);
      total += size ?? 0;
    }
  }
  return total > 0 ? total : (agentDiskTotalGb ?? null);
}
