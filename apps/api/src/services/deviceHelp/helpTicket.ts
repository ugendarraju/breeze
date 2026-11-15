// fork: turn a "Get help" form submission into a ticket on the device's org,
// linked to the device, with the optional screenshot attached.
//
// Mirrors the inbound-email create path (services/inboundEmail): the bytes are
// stored FIRST, outside the transaction; then the ticket, one public comment
// carrying the screenshot, and its ticket_attachments row commit together in a
// single system-context transaction. If that transaction fails (or the create
// is refused) the stored bytes are deleted again. The comment emits no
// ticket.commented event (ticket.created already announced the ticket), and
// ticket.created never mails the requester, so the form cannot be used to make
// Breeze send mail to an arbitrary address.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, organizations, partners } from '../../db/schema';
import { ticketComments } from '../../db/schema/portal';
import { ticketAttachments } from '../../db/schema/ticketAttachments';
import { createTicket, TicketServiceError, type TicketActor } from '../ticketService';
import { assignHelpTicket } from './helpTicketAssignee';
import { lockTicketForWrite } from '../ticketRowLock';
import { assertTicketNotMerged } from '../ticketMerge/errors';
import { deleteBytes, putBytes, type AttachmentBackend } from '../ticketAttachmentStorage';
import { sanitizeAttachmentFilename } from '../attachmentFilename';

/** Same precedent as the Trust Center access request: no person, no dedicated system source. */
const HELP_FORM_ACTOR: TicketActor = { kind: 'system', source: 'inbound_email', name: 'Get help form' };

const LIVE_PARTNER_STATUSES = new Set<string>(['active', 'pending']);
const LIVE_ORG_STATUSES = new Set<string>(['active', 'trial']);

export interface HelpRequestInput {
  name: string;
  phone: string;
  company: string;
  email: string;
  details: string;
}

export interface HelpScreenshot {
  bytes: Buffer;
  /** Sniffed from the bytes, never the client's Content-Type. */
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  filename: string;
}

export type HelpTicketResult =
  | { ok: true; ticketNumber: string | null }
  | { ok: false; reason: 'device_unavailable' | 'ticketing_off' };

interface StoredShot {
  id: string;
  sha256: string;
  backend: AttachmentBackend;
  storageKey: string | null;
  data: Buffer | null;
}

/** The ticket description: everything the form collected, in plain text. */
export function helpTicketDescription(input: HelpRequestInput, device: { hostname: string; displayName: string | null }): string {
  const deviceLabel = device.displayName && device.displayName !== device.hostname
    ? `${device.displayName} (${device.hostname})`
    : device.hostname;
  return [
    input.details,
    '',
    '--- Sent with the "Get help" link on this computer ---',
    `Name: ${input.name}`,
    `Phone: ${input.phone}`,
    `Company: ${input.company}`,
    `Email: ${input.email}`,
    `Computer: ${deviceLabel}`,
  ].join('\n');
}

export function helpTicketSubject(input: HelpRequestInput, hostname: string): string {
  const firstLine = input.details.split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'Help request';
  const summary = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return `[Get help] ${hostname}: ${summary}`;
}

async function storeScreenshot(shot: HelpScreenshot): Promise<StoredShot> {
  const id = randomUUID();
  const sha256 = createHash('sha256').update(shot.bytes).digest('hex');
  const stored = await putBytes(id, shot.bytes, shot.contentType, sha256);
  return { id, sha256, ...stored };
}

async function discard(stored: StoredShot | null): Promise<void> {
  if (!stored) return;
  await deleteBytes({ storageBackend: stored.backend, storageKey: stored.storageKey, data: stored.data }).catch(() => undefined);
}

/**
 * Attach the stored screenshot to the new ticket on one public comment
 * (registered in ticketChildWriters.ts: ticket lock and tombstone guard first).
 */
export async function attachHelpScreenshot(input: {
  ticketId: string;
  orgId: string;
  authorName: string;
  stored: StoredShot;
  shot: HelpScreenshot;
}): Promise<void> {
  assertTicketNotMerged(await lockTicketForWrite(db, input.ticketId));
  const [comment] = await db.insert(ticketComments).values({
    ticketId: input.ticketId,
    userId: null,
    portalUserId: null,
    authorName: input.authorName,
    authorType: 'email',
    commentType: 'comment',
    content: 'Screenshot from the "Get help" form.',
    isPublic: true,
    oldValue: null,
    newValue: null,
  }).returning({ id: ticketComments.id });
  if (!comment) throw new Error('failed to insert the help-form screenshot comment');
  await db.insert(ticketAttachments).values({
    id: input.stored.id,
    orgId: input.orgId,
    ticketId: input.ticketId,
    commentId: comment.id,
    uploadedByUserId: null,
    storageBackend: input.stored.backend,
    storageKey: input.stored.storageKey,
    data: input.stored.data,
    contentType: input.shot.contentType,
    byteSize: input.shot.bytes.length,
    originalFilename: sanitizeAttachmentFilename(input.shot.filename || 'screenshot'),
    sha256: input.stored.sha256,
    attachedAt: new Date(),
  });
}

/**
 * Create the ticket for an already-resolved device. The device's CURRENT org is
 * read here, so a device that moved org (or whose org merged) files into its
 * new home. Decommissioned devices and inactive orgs/partners are refused.
 */
export async function createHelpTicket(
  deviceId: string,
  input: HelpRequestInput,
  shot: HelpScreenshot | null,
): Promise<HelpTicketResult> {
  const stored = shot ? await storeScreenshot(shot) : null;
  let result: HelpTicketResult;
  try {
    result = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<HelpTicketResult> => {
      const [row] = await db
        .select({
          orgId: devices.orgId,
          partnerId: organizations.partnerId,
          hostname: devices.hostname,
          displayName: devices.displayName,
          status: devices.status,
          orgStatus: organizations.status,
          partnerStatus: partners.status,
        })
        .from(devices)
        .innerJoin(organizations, and(eq(organizations.id, devices.orgId), isNull(organizations.deletedAt)))
        .innerJoin(partners, and(eq(partners.id, organizations.partnerId), isNull(partners.deletedAt)))
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (
        !row ||
        row.status === 'decommissioned' ||
        !LIVE_ORG_STATUSES.has(row.orgStatus) ||
        !LIVE_PARTNER_STATUSES.has(row.partnerStatus)
      ) {
        return { ok: false, reason: 'device_unavailable' };
      }

      let ticket: Awaited<ReturnType<typeof createTicket>>;
      try {
        ticket = await createTicket({
          orgId: row.orgId,
          deviceId,
          source: 'api',
          subject: helpTicketSubject(input, row.hostname),
          description: helpTicketDescription(input, row),
          submitterName: input.name,
          submitterEmail: input.email,
        }, HELP_FORM_ACTOR);
      } catch (err) {
        // Thrown before anything was written (the creation gate runs first).
        if (err instanceof TicketServiceError && err.code === 'service_management_off') {
          return { ok: false, reason: 'ticketing_off' };
        }
        throw err;
      }

      // Unless a routing rule already did, hand the ticket to this device's technician.
      await assignHelpTicket(ticket, row.partnerId, HELP_FORM_ACTOR);

      if (stored && shot) {
        await attachHelpScreenshot({ ticketId: ticket.id, orgId: row.orgId, authorName: input.name, stored, shot });
      }
      return { ok: true, ticketNumber: ticket.internalNumber ?? null };
    }));
  } catch (err) {
    await discard(stored);
    throw err;
  }
  if (!result.ok) await discard(stored);
  return result;
}
