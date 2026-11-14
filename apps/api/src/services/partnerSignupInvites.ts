/**
 * Fork feature: invite-only technician (partner) signup.
 *
 * A platform admin creates a one-time invite link; the technician opens it and
 * signs up through the normal /auth/register-partner + email-verification flow.
 * The link works exactly once: the first signup that presents it claims it,
 * and every later attempt (a forwarded copy included) is refused. Invited
 * partners are created `pending` and wait for the admin to activate them on
 * the Partners page.
 *
 * Storage is Redis (AOF-persisted, noeviction), like pending registrations:
 *   partner-invite:token:<sha256(token)> -> invite id   (TTL = invite expiry)
 *   partner-invite:rec:<id>              -> JSON record (TTL = expiry + retention)
 *   partner-invites:index                -> ZSET of ids scored by createdAt
 *
 * Single use rests on GETDEL of the token key: Redis runs it atomically, so of
 * any number of concurrent claims exactly one gets the id back. Revoking or
 * expiring an invite removes that key, which makes the link dead the same way.
 * The raw token is never stored; it is returned once to the admin who creates it.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getRedis } from './redis';
import { envFlag } from '../utils/envFlag';

const TOKEN_KEY_PREFIX = 'partner-invite:token:';
const RECORD_KEY_PREFIX = 'partner-invite:rec:';
const INDEX_KEY = 'partner-invites:index';

export const INVITE_DEFAULT_TTL_DAYS = 7;
export const INVITE_MAX_TTL_DAYS = 30;
/** How long a used/revoked/expired invite stays listable after it expires. */
const RECORD_RETENTION_SECONDS = 90 * 24 * 3600;
const LIST_LIMIT = 200;

export type StoredInviteStatus = 'open' | 'used' | 'revoked';
export type InviteStatus = StoredInviteStatus | 'expired';

export interface PartnerSignupInviteRecord {
  id: string;
  /** Admin's own reminder of who the link is for, e.g. "Ravi - RK Computers". */
  label: string;
  tokenHash: string;
  status: StoredInviteStatus;
  createdAt: string;
  expiresAt: string;
  createdByUserId: string;
  createdByEmail?: string;
  usedAt?: string;
  usedEmail?: string;
  usedCompanyName?: string;
  /** Set once the signup's email is verified and the partner row exists. */
  partnerId?: string;
  revokedAt?: string;
}

/** What the admin API returns: never the token hash. */
export interface PartnerSignupInviteView extends Omit<PartnerSignupInviteRecord, 'tokenHash' | 'status'> {
  status: InviteStatus;
}

/** PARTNER_SIGNUP_INVITE_ONLY=true: /register-partner refuses signups without a valid invite. */
export function partnerSignupInviteOnly(): boolean {
  return envFlag('PARTNER_SIGNUP_INVITE_ONLY', false);
}

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) throw new Error('Redis unavailable');
  return redis;
}

function recordKey(id: string) {
  return `${RECORD_KEY_PREFIX}${id}`;
}

function tokenKey(tokenHash: string) {
  return `${TOKEN_KEY_PREFIX}${tokenHash}`;
}

function secondsUntil(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / 1000);
}

function parseRecord(raw: string | null): PartnerSignupInviteRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PartnerSignupInviteRecord;
  } catch {
    return null;
  }
}

export function toInviteView(rec: PartnerSignupInviteRecord, now = Date.now()): PartnerSignupInviteView {
  const { tokenHash: _tokenHash, status, ...rest } = rec;
  const effective: InviteStatus = status === 'open' && Date.parse(rec.expiresAt) <= now ? 'expired' : status;
  return { ...rest, status: effective };
}

async function writeRecord(rec: PartnerSignupInviteRecord, now: number): Promise<void> {
  const ttl = Math.max(secondsUntil(rec.expiresAt, now), 0) + RECORD_RETENTION_SECONDS;
  await requireRedis().setex(recordKey(rec.id), ttl, JSON.stringify(rec));
}

export async function getInvite(id: string): Promise<PartnerSignupInviteRecord | null> {
  return parseRecord(await requireRedis().get(recordKey(id)));
}

export async function createInvite(input: {
  label: string;
  ttlDays?: number;
  createdByUserId: string;
  createdByEmail?: string;
}): Promise<{ invite: PartnerSignupInviteView; token: string }> {
  const redis = requireRedis();
  const now = Date.now();
  const ttlDays = Math.min(Math.max(input.ttlDays ?? INVITE_DEFAULT_TTL_DAYS, 1), INVITE_MAX_TTL_DAYS);
  const token = randomBytes(32).toString('base64url');
  const rec: PartnerSignupInviteRecord = {
    id: randomUUID(),
    label: input.label.trim(),
    tokenHash: hashInviteToken(token),
    status: 'open',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 24 * 3600 * 1000).toISOString(),
    createdByUserId: input.createdByUserId,
    createdByEmail: input.createdByEmail,
  };
  await writeRecord(rec, now);
  await redis.setex(tokenKey(rec.tokenHash), ttlDays * 24 * 3600, rec.id);
  await redis.zadd(INDEX_KEY, now, rec.id);
  return { invite: toInviteView(rec, now), token };
}

export async function listInvites(): Promise<PartnerSignupInviteView[]> {
  const redis = requireRedis();
  const ids = await redis.zrevrange(INDEX_KEY, 0, LIST_LIMIT - 1);
  if (ids.length === 0) return [];
  const raws = await redis.mget(...ids.map(recordKey));
  const now = Date.now();
  const views: PartnerSignupInviteView[] = [];
  const gone: string[] = [];
  ids.forEach((id, i) => {
    const rec = parseRecord(raws[i] ?? null);
    if (rec) views.push(toInviteView(rec, now));
    else gone.push(id);
  });
  // Records age out by TTL; drop their index entries so the ZSET cannot grow forever.
  if (gone.length > 0) await redis.zrem(INDEX_KEY, ...gone);
  return views;
}

/** Revoke an unused invite. Returns null when it does not exist; the view otherwise. */
export async function revokeInvite(id: string): Promise<PartnerSignupInviteView | null> {
  const now = Date.now();
  const rec = await getInvite(id);
  if (!rec) return null;
  if (rec.status !== 'open') return toInviteView(rec, now);
  // Kill the link first: a claim racing this revoke either got the id already
  // (and the invite reads `used`) or finds the key gone.
  await requireRedis().del(tokenKey(rec.tokenHash));
  const latest = (await getInvite(id)) ?? rec;
  if (latest.status !== 'open') return toInviteView(latest, now);
  const revoked: PartnerSignupInviteRecord = { ...latest, status: 'revoked', revokedAt: new Date(now).toISOString() };
  await writeRecord(revoked, now);
  return toInviteView(revoked, now);
}

/**
 * Claim an invite for a signup attempt. Exactly one caller per invite ever gets
 * a record back; every other call (reuse, forwarded link, revoked, expired,
 * unknown token) gets null.
 */
export async function claimInvite(
  rawToken: string,
  attempt: { email: string; companyName: string },
): Promise<PartnerSignupInviteRecord | null> {
  if (!rawToken) return null;
  const redis = requireRedis();
  const id = await redis.getdel(tokenKey(hashInviteToken(rawToken)));
  if (!id) return null;
  const now = Date.now();
  const rec = await getInvite(id);
  if (!rec || rec.status !== 'open' || Date.parse(rec.expiresAt) <= now) return null;
  const used: PartnerSignupInviteRecord = {
    ...rec,
    status: 'used',
    usedAt: new Date(now).toISOString(),
    usedEmail: attempt.email.toLowerCase().trim(),
    usedCompanyName: attempt.companyName,
  };
  await writeRecord(used, now);
  return used;
}

/**
 * Undo a claim when the signup could not be parked (e.g. Redis write failed),
 * so a transient server error does not burn the technician's link.
 */
export async function releaseInviteClaim(rec: PartnerSignupInviteRecord): Promise<void> {
  const now = Date.now();
  const ttl = secondsUntil(rec.expiresAt, now);
  if (ttl <= 0) return;
  const reopened: PartnerSignupInviteRecord = {
    ...rec,
    status: 'open',
    usedAt: undefined,
    usedEmail: undefined,
    usedCompanyName: undefined,
  };
  await writeRecord(reopened, now);
  await requireRedis().setex(tokenKey(rec.tokenHash), ttl, rec.id);
}

/** Record which partner the invite produced, once email verification created it. */
export async function attachInvitePartner(id: string, partnerId: string): Promise<void> {
  const rec = await getInvite(id);
  if (!rec) return;
  await writeRecord({ ...rec, partnerId }, Date.now());
}
