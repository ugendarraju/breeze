// fork: a Get help ticket goes to the device's own technician. The ticket is
// already created in the device's org (only that partner can see it); this
// gives it an owner so the "ticket assigned" notification reaches someone.
// Order: a partner routing rule (createTicket already applied it) > the
// partner's default ticket assignee (settings.ticketing.inbound
// .defaultAssigneeUserId, the setting inbound email uses) > the partner's
// longest-standing active staff member (the technician who signed up).
// assignTicket re-checks eligibility (same partner, active, tickets:read,
// access to the org); an ineligible candidate is skipped, never an error.
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners, partnerUsers, users } from '../../db/schema';
import { assignTicket, TicketServiceError, type TicketActor } from '../ticketService';

const INELIGIBLE_CODES = new Set(['ASSIGNEE_NOT_FOUND', 'ASSIGNEE_WRONG_PARTNER', 'ASSIGNEE_NOT_ELIGIBLE']);
const MAX_STAFF_CANDIDATES = 5;

function defaultAssigneeFrom(settings: unknown): string | null {
  const id = (settings as { ticketing?: { inbound?: { defaultAssigneeUserId?: unknown } } } | null)
    ?.ticketing?.inbound?.defaultAssigneeUserId;
  return typeof id === 'string' && id ? id : null;
}

/** Candidate assignees, best first, without duplicates. */
export async function helpTicketAssigneeCandidates(partnerId: string): Promise<string[]> {
  const [partner] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const staff = await db
    .select({ userId: partnerUsers.userId })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId, partnerId), eq(users.status, 'active')))
    .orderBy(asc(partnerUsers.createdAt))
    .limit(MAX_STAFF_CANDIDATES);
  const ordered = [defaultAssigneeFrom(partner?.settings), ...staff.map((s) => s.userId)];
  return [...new Set(ordered.filter((id): id is string => !!id))];
}

/** Assigns an unassigned help ticket; returns the assignee id, or null if nobody qualified. */
export async function assignHelpTicket(
  ticket: { id: string; assignedTo: string | null },
  partnerId: string,
  actor: TicketActor,
): Promise<string | null> {
  if (ticket.assignedTo) return ticket.assignedTo;
  for (const candidate of await helpTicketAssigneeCandidates(partnerId)) {
    try {
      await assignTicket(ticket.id, candidate, actor);
      return candidate;
    } catch (err) {
      if (err instanceof TicketServiceError && err.code && INELIGIBLE_CODES.has(err.code)) continue;
      throw err;
    }
  }
  return null;
}
