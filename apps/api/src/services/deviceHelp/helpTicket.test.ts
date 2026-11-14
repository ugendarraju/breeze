import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  inserts: [] as Array<{ values: Record<string, unknown> }>,
  createTicket: vi.fn(),
  putBytes: vi.fn(),
  deleteBytes: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where']) q[m] = () => q;
    q.limit = async () => h.deviceRows;
    return q;
  };
  return {
    db: {
      select: () => chain(),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          h.inserts.push({ values });
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: 'comment-1' }] });
        },
      }),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../ticketService', () => {
  class TicketServiceError extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
  }
  return { createTicket: h.createTicket, TicketServiceError };
});
vi.mock('../ticketRowLock', () => ({ lockTicketForWrite: h.lock }));
vi.mock('../ticketMerge/errors', () => ({ assertTicketNotMerged: vi.fn() }));
vi.mock('../ticketAttachmentStorage', () => ({ putBytes: h.putBytes, deleteBytes: h.deleteBytes }));

import { createHelpTicket, helpTicketDescription, helpTicketSubject } from './helpTicket';
import { TicketServiceError } from '../ticketService';

const DEVICE = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const INPUT = {
  name: 'Asha Rao', phone: '+1 555 0100', company: 'Cubestack', email: 'asha@example.com',
  details: 'Outlook crashes\nwhen I open attachments',
};
const LIVE_ROW = {
  orgId: 'org-1', hostname: 'ASUS-ROG', displayName: 'Asha laptop', status: 'online', orgStatus: 'active', partnerStatus: 'active',
};
const SHOT = { bytes: Buffer.from('png-bytes'), contentType: 'image/png' as const, filename: '../../error.png' };

beforeEach(() => {
  h.deviceRows = [LIVE_ROW];
  h.inserts = [];
  h.createTicket.mockReset().mockResolvedValue({ id: 'ticket-1', internalNumber: 'T-2026-0001' });
  h.putBytes.mockReset().mockResolvedValue({ backend: 'db', storageKey: null, data: Buffer.from('png-bytes') });
  h.deleteBytes.mockReset().mockResolvedValue(undefined);
  h.lock.mockReset().mockResolvedValue({ id: 'ticket-1' });
});

describe('help ticket text', () => {
  it('subject names the computer and the first line of the problem', () => {
    expect(helpTicketSubject(INPUT, 'ASUS-ROG')).toBe('[Get help] ASUS-ROG: Outlook crashes');
    expect(helpTicketSubject({ ...INPUT, details: 'x'.repeat(400) }, 'PC').length).toBeLessThanOrEqual(140);
  });

  it('description carries every form field, phone and company included', () => {
    const text = helpTicketDescription(INPUT, { hostname: 'ASUS-ROG', displayName: 'Asha laptop' });
    for (const s of ['Outlook crashes', 'Name: Asha Rao', 'Phone: +1 555 0100', 'Company: Cubestack', 'Email: asha@example.com', 'Computer: Asha laptop (ASUS-ROG)']) {
      expect(text).toContain(s);
    }
  });
});

describe('createHelpTicket', () => {
  it('creates the ticket on the device CURRENT org, linked to the device, with the requester', async () => {
    const result = await createHelpTicket(DEVICE, INPUT, null);
    expect(result).toEqual({ ok: true, ticketNumber: 'T-2026-0001' });
    const [input, actor] = h.createTicket.mock.calls[0]!;
    expect(input).toMatchObject({
      orgId: 'org-1', deviceId: DEVICE, source: 'api', submitterName: 'Asha Rao', submitterEmail: 'asha@example.com',
    });
    expect(actor).toMatchObject({ kind: 'system', name: 'Get help form' });
    expect(h.putBytes).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it('stores the screenshot first, then attaches it on one public comment after locking the ticket', async () => {
    await createHelpTicket(DEVICE, INPUT, SHOT);
    expect(h.putBytes).toHaveBeenCalledTimes(1);
    expect(h.lock).toHaveBeenCalledWith(expect.anything(), 'ticket-1');
    const [comment, attachment] = h.inserts.map((i) => i.values);
    expect(comment).toMatchObject({ ticketId: 'ticket-1', isPublic: true, authorName: 'Asha Rao', userId: null });
    expect(attachment).toMatchObject({
      ticketId: 'ticket-1', orgId: 'org-1', commentId: 'comment-1', contentType: 'image/png', uploadedByUserId: null,
      byteSize: SHOT.bytes.length,
    });
    expect(String(attachment!.originalFilename)).not.toContain('/');
    expect(h.deleteBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['missing device', []],
    ['decommissioned device', [{ ...LIVE_ROW, status: 'decommissioned' }]],
    ['suspended org', [{ ...LIVE_ROW, orgStatus: 'suspended' }]],
    ['suspended partner', [{ ...LIVE_ROW, partnerStatus: 'suspended' }]],
  ])('refuses a %s and deletes the stored screenshot', async (_label, rows) => {
    h.deviceRows = rows as unknown[];
    expect(await createHelpTicket(DEVICE, INPUT, SHOT)).toEqual({ ok: false, reason: 'device_unavailable' });
    expect(h.createTicket).not.toHaveBeenCalled();
    expect(h.deleteBytes).toHaveBeenCalledTimes(1);
  });

  it('maps "service management off" to ticketing_off and deletes the stored screenshot', async () => {
    h.createTicket.mockRejectedValue(new TicketServiceError('off', 409, 'service_management_off'));
    expect(await createHelpTicket(DEVICE, INPUT, SHOT)).toEqual({ ok: false, reason: 'ticketing_off' });
    expect(h.deleteBytes).toHaveBeenCalledTimes(1);
  });

  it('a failure after storing the bytes deletes them and rethrows', async () => {
    h.createTicket.mockRejectedValue(new Error('db down'));
    await expect(createHelpTicket(DEVICE, INPUT, SHOT)).rejects.toThrow('db down');
    expect(h.deleteBytes).toHaveBeenCalledTimes(1);
  });
});
