import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  queue: vi.fn(),
  deferred: [] as Array<() => Promise<unknown>>,
}));

vi.mock('../db', () => ({
  db: { select: h.select },
  runAfterDbContextCommit: (_label: string, work: () => Promise<unknown>) => { h.deferred.push(work); },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({
  deviceCommands: { id: 'id', deviceId: 'deviceId', type: 'type', status: 'status', createdAt: 'createdAt' },
}));
vi.mock('./commandQueue', () => ({ queueCommandForExecution: h.queue }));

import { isFinishedSoftwareUpdate, scheduleInventoryRefreshAfterUpdate } from './softwareUpdateInventoryRefresh';

function inFlight(rows: unknown[]) {
  const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
  h.select.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deferred.length = 0;
  h.queue.mockResolvedValue({ command: { id: 'refresh-1' } });
});

describe('isFinishedSoftwareUpdate', () => {
  it('counts a succeeded software_update and any finished guarded update script', () => {
    expect(isFinishedSoftwareUpdate({ type: 'software_update', payload: {} }, 'completed')).toBe(true);
    expect(isFinishedSoftwareUpdate({ type: 'software_update', payload: {} }, 'failed')).toBe(false);
    expect(isFinishedSoftwareUpdate({ type: 'script', payload: { scriptId: 'software_update_guarded' } }, 'failed')).toBe(true);
    expect(isFinishedSoftwareUpdate({ type: 'script', payload: { scriptId: 'software_update_detect' } }, 'completed')).toBe(false);
    expect(isFinishedSoftwareUpdate({ type: 'script', payload: { scriptId: 'library-script' } }, 'completed')).toBe(false);
    expect(isFinishedSoftwareUpdate({ type: 'reboot', payload: {} }, 'completed')).toBe(false);
  });
});

describe('scheduleInventoryRefreshAfterUpdate', () => {
  it('queues nothing until the result commits, then one refresh_inventory', async () => {
    inFlight([]);
    scheduleInventoryRefreshAfterUpdate('device-1');
    expect(h.queue).not.toHaveBeenCalled();

    await h.deferred[0]!();
    expect(h.queue).toHaveBeenCalledWith('device-1', 'refresh_inventory', {}, { preferHeartbeat: false });
  });

  it('skips while a refresh for the device is already pending or in flight', async () => {
    inFlight([{ id: 'refresh-0' }]);
    scheduleInventoryRefreshAfterUpdate('device-1');
    await h.deferred[0]!();
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('never throws into the result path', async () => {
    h.select.mockImplementation(() => { throw new Error('db down'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scheduleInventoryRefreshAfterUpdate('device-1');
    await expect(h.deferred[0]!()).resolves.toBeUndefined();
  });
});
