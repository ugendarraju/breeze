// fork: Get help tickets go to the device's own technician.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  partnerRows: [] as unknown[],
  staffRows: [] as unknown[],
  assignTicket: vi.fn(),
}));

vi.mock('../../db', () => {
  let call = 0;
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy']) q[m] = () => q;
    q.limit = async () => rows();
    return q;
  };
  return {
    db: { select: () => chain(() => ((call++ % 2 === 0) ? h.partnerRows : h.staffRows)) },
  };
});
vi.mock('../ticketService', () => {
  class TicketServiceError extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
  }
  return { assignTicket: h.assignTicket, TicketServiceError };
});

import { assignHelpTicket, helpTicketAssigneeCandidates } from './helpTicketAssignee';
import { TicketServiceError } from '../ticketService';

const ACTOR = { kind: 'system', source: 'inbound_email', name: 'Get help form' } as const;
const TICKET = { id: 'ticket-1', assignedTo: null };

beforeEach(() => {
  h.partnerRows = [{ settings: {} }];
  h.staffRows = [{ userId: 'owner-1' }, { userId: 'tech-2' }];
  h.assignTicket.mockReset().mockResolvedValue(undefined);
});

describe('help ticket assignee (fork)', () => {
  it('puts the partner default assignee first, then staff oldest first, without duplicates', async () => {
    h.partnerRows = [{ settings: { ticketing: { inbound: { defaultAssigneeUserId: 'tech-2' } } } }];
    expect(await helpTicketAssigneeCandidates('partner-1')).toEqual(['tech-2', 'owner-1']);
  });

  it('assigns to the first candidate', async () => {
    expect(await assignHelpTicket(TICKET, 'partner-1', ACTOR)).toBe('owner-1');
    expect(h.assignTicket).toHaveBeenCalledTimes(1);
    expect(h.assignTicket).toHaveBeenCalledWith('ticket-1', 'owner-1', ACTOR);
  });

  it('leaves a ticket a routing rule already assigned', async () => {
    expect(await assignHelpTicket({ id: 'ticket-1', assignedTo: 'routed' }, 'partner-1', ACTOR)).toBe('routed');
    expect(h.assignTicket).not.toHaveBeenCalled();
  });

  it('skips an ineligible candidate and tries the next', async () => {
    h.assignTicket.mockImplementationOnce(async () => {
      throw new TicketServiceError('no', 400, 'ASSIGNEE_NOT_ELIGIBLE');
    });
    expect(await assignHelpTicket(TICKET, 'partner-1', ACTOR)).toBe('tech-2');
  });

  it('leaves the ticket unassigned when nobody qualifies', async () => {
    h.staffRows = [];
    expect(await assignHelpTicket(TICKET, 'partner-1', ACTOR)).toBeNull();
  });
});
