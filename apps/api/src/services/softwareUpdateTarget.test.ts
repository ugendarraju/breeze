import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Chainable, awaitable Drizzle stand-in: every builder call returns the chain; awaiting yields `rows`. */
function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const select = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { select } }));

import { applyWindowsUpdateTarget, resolveWindowsUpdatePackageId } from './softwareUpdateTarget';

const DEV = 'device-1';
const patchRow = (title: string, packageId: string) => ({ title, packageId, version: '33.0.0', source: 'third_party' });

/** Queue the three possible reads in order: device patches, inventory vendor, winget index. */
function reads(patches: unknown[], inventory: unknown[] = [], index: unknown[] = []) {
  select
    .mockImplementationOnce(() => chain(patches))
    .mockImplementationOnce(() => chain(inventory))
    .mockImplementationOnce(() => chain(index));
}

beforeEach(() => {
  select.mockReset();
});

describe('resolveWindowsUpdatePackageId', () => {
  it('trusts a well-formed requested id without touching the database', async () => {
    await expect(resolveWindowsUpdatePackageId(DEV, 'Firefox', 'Mozilla.Firefox')).resolves.toEqual({
      packageId: 'Mozilla.Firefox',
      via: 'request',
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('strips the provider prefix from a requested id', async () => {
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio', 'winget:OBSProject.OBSStudio')).resolves.toMatchObject({
      packageId: 'OBSProject.OBSStudio',
    });
  });

  it('uses the winget id the agent reported for this package (OBS Studio regression)', async () => {
    reads([patchRow('OBS Studio', 'winget:OBSProject.OBSStudio'), patchRow('Zoom', 'winget:Zoom.Zoom')]);
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio')).resolves.toEqual({
      packageId: 'OBSProject.OBSStudio',
      via: 'detected_update',
    });
  });

  it('ignores a non-winget provider id and falls through', async () => {
    reads([patchRow('OBS Studio', 'chocolatey:obs-studio')], [{ vendor: null }]);
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio')).resolves.toBeNull();
  });

  it('falls back to a single winget index match on name and publisher', async () => {
    reads([], [{ vendor: 'OBS Project' }], [{ packageId: 'OBSProject.OBSStudio' }]);
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio')).resolves.toEqual({
      packageId: 'OBSProject.OBSStudio',
      via: 'winget_index',
    });
  });

  it('refuses an ambiguous winget index match', async () => {
    reads([], [{ vendor: 'OBS Project' }], [{ packageId: 'OBSProject.OBSStudio' }, { packageId: 'OBSProject.OBSStudio.Beta' }]);
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio')).resolves.toBeNull();
  });

  it('refuses without a publisher to confirm the index match', async () => {
    reads([], [{ vendor: null }]);
    await expect(resolveWindowsUpdatePackageId(DEV, 'OBS Studio')).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
  });
});

describe('applyWindowsUpdateTarget', () => {
  it('pins both name and packageId to the winget id and keeps the display name', () => {
    const payload: Record<string, unknown> = { name: 'OBS Studio', source: 'device_software_tab' };
    applyWindowsUpdateTarget(payload, 'OBS Studio', 'OBSProject.OBSStudio');
    expect(payload).toEqual({
      name: 'OBSProject.OBSStudio',
      packageId: 'OBSProject.OBSStudio',
      displayName: 'OBS Studio',
      source: 'device_software_tab',
    });
  });
});
