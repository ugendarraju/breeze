import { describe, expect, it } from 'vitest';
import { totalDiskCapacityGb } from './diskTotal';

// The drives an ASUS laptop's agent reported (2026-11-14): the agent's own
// diskTotalGb was 174, i.e. C: only.
const laptopDisks = [
  { mountPoint: 'C:', device: 'C:', totalGb: 174.23769 },
  { mountPoint: 'D:', device: 'D:', totalGb: 258.78906 },
  { mountPoint: 'E:', device: 'E:', totalGb: 258.78906 },
  { mountPoint: 'F:', device: 'F:', totalGb: 260.5088 },
];

describe('totalDiskCapacityGb', () => {
  it('totals every drive instead of the system drive only', () => {
    expect(totalDiskCapacityGb(laptopDisks, 174)).toBeCloseTo(952.32, 1);
  });

  it('falls back to the agent value without a drive list', () => {
    expect(totalDiskCapacityGb(null, 174)).toBe(174);
    expect(totalDiskCapacityGb([], 174)).toBe(174);
    expect(totalDiskCapacityGb(undefined, undefined)).toBeNull();
  });

  it('counts a drive reported twice once', () => {
    expect(totalDiskCapacityGb([...laptopDisks, laptopDisks[1]!], 174)).toBeCloseTo(952.32, 1);
  });

  it('accepts string sizes and the alternate size fields', () => {
    expect(totalDiskCapacityGb([{ device: 'a', sizeGb: '100' }, { device: 'b', capacityGb: 50 }], null)).toBe(150);
  });

  it('keeps the Hardware tab rule: a root "/" volume is the whole disk', () => {
    expect(totalDiskCapacityGb([{ mountPoint: '/', totalGb: 512 }, { mountPoint: '/boot', totalGb: 1 }], 512)).toBe(512);
  });

  it('falls back when no drive has a usable size', () => {
    expect(totalDiskCapacityGb([{ device: 'x' }], 174)).toBe(174);
  });
});
