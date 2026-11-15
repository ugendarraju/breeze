// fork: the public, account-less side of the "Get help" link.
//
//   POST /device-help/public/check   { token }            -> { valid }
//   POST /device-help/public/submit  multipart form       -> { ticketNumber }
//
// SECURITY: no auth middleware - the derived per-device token
// (services/deviceHelp/helpLinkToken.ts) is the only credential, and it can do
// exactly one thing: open a ticket on its device. Nothing here returns tenant
// data (not even the org or device name) and every failure is the same generic
// answer, so the surface cannot be used to read or enumerate anything.
// The token travels in the request BODY (the page keeps it in the URL
// fragment), never in a path or query string, so it stays out of access logs.
// Abuse limits: per-IP and per-device rate limits in Redis, field length caps,
// one image <= 10 MB whose type is sniffed from its bytes (PNG/JPEG/WebP only).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { sniffImageMime } from '../services/avatarStorage';
import { HelpLinkUnavailableError, resolveHelpToken } from '../services/deviceHelp/helpLinkToken';
import { createHelpTicket, type HelpScreenshot } from '../services/deviceHelp/helpTicket';
import { AttachmentStorageError } from '../services/ticketAttachmentStorage';
import { captureException } from '../services/sentry';

export const deviceHelpPublicRoutes = new Hono();

const INVALID_LINK = { error: 'This help link is not valid any more. Please contact your IT support another way.' } as const;
const RATE_WINDOW_SECONDS = 3600;
const CHECK_PER_IP = 120;
const SUBMIT_PER_IP = 20;
const SUBMIT_PER_DEVICE = 10;

export const helpFormSchema = z.object({
  token: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(3).max(40).regex(/^[0-9+()\-.\s/xX]+$/),
  company: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).email(),
  details: z.string().trim().min(5).max(5000),
});

deviceHelpPublicRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
});

/** True when the caller is over `limit` in this window. Fails closed without Redis. */
async function overLimit(bucket: string, limit: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const result = await rateLimiter(redis, bucket, limit, RATE_WINDOW_SECONDS);
  return !result.allowed;
}

function tooMany(c: Context) {
  return c.json({ error: 'Too many requests from here. Please wait a while and try again.' }, 429);
}

function unavailable(c: Context) {
  return c.json({ error: 'Temporarily unavailable. Please try again shortly.' }, 503);
}

deviceHelpPublicRoutes.post('/check', async (c) => {
  const ip = rateLimitIpKey(getTrustedClientIp(c));
  if (await overLimit(`device-help-check:${ip}`, CHECK_PER_IP)) return tooMany(c);
  const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  try {
    return c.json({ valid: (await resolveHelpToken(token)) !== null });
  } catch (err) {
    if (err instanceof HelpLinkUnavailableError) return unavailable(c);
    throw err;
  }
});

function firstString(v: unknown): string {
  if (Array.isArray(v)) return firstString(v[0]);
  return typeof v === 'string' ? v : '';
}

deviceHelpPublicRoutes.post('/submit', async (c) => {
  const ip = rateLimitIpKey(getTrustedClientIp(c));
  if (await overLimit(`device-help-submit:${ip}`, SUBMIT_PER_IP)) return tooMany(c);

  let parsed: Record<string, unknown>;
  try {
    parsed = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Expected a form submission' }, 400);
  }

  const fields = helpFormSchema.safeParse({
    token: firstString(parsed.token),
    name: firstString(parsed.name),
    phone: firstString(parsed.phone),
    company: firstString(parsed.company),
    email: firstString(parsed.email),
    details: firstString(parsed.details),
  });
  if (!fields.success) {
    const invalid = [...new Set(fields.error.issues.map((i) => String(i.path[0] ?? '')))];
    return c.json({ error: 'Please check the form', fields: invalid }, 400);
  }

  const files = ([] as unknown[]).concat(parsed.screenshot ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 1) return c.json({ error: 'Attach one screenshot at most' }, 400);
  let shot: HelpScreenshot | null = null;
  const file = files[0];
  if (file) {
    if (file.size > TICKET_ATTACHMENT_LIMITS.maxBytes) {
      return c.json({ error: 'The screenshot is too large (max 10 MB)', code: 'SCREENSHOT_TOO_LARGE' }, 413);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const contentType = sniffImageMime(bytes);
    if (!contentType) {
      return c.json({ error: 'The screenshot must be a PNG, JPEG or WebP image', code: 'SCREENSHOT_NOT_IMAGE' }, 415);
    }
    shot = { bytes, contentType, filename: file.name };
  }

  const { token, ...input } = fields.data;
  let deviceId: string | null;
  try {
    deviceId = await resolveHelpToken(token);
  } catch (err) {
    if (err instanceof HelpLinkUnavailableError) return unavailable(c);
    throw err;
  }
  if (!deviceId) return c.json(INVALID_LINK, 404);
  if (await overLimit(`device-help-submit-device:${deviceId}`, SUBMIT_PER_DEVICE)) return tooMany(c);

  try {
    const result = await createHelpTicket(deviceId, input, shot);
    if (!result.ok) {
      return result.reason === 'ticketing_off'
        ? c.json({ error: 'Your IT provider is not taking requests through this page right now. Please contact them another way.' }, 409)
        : c.json(INVALID_LINK, 404);
    }
    return c.json({ ticketNumber: result.ticketNumber }, 201);
  } catch (err) {
    if (err instanceof AttachmentStorageError) {
      return c.json({ error: 'The screenshot could not be saved. Try again, or send the request without it.' }, 503);
    }
    captureException(err);
    console.error('[device-help] ticket create failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Your request could not be sent. Please try again shortly.' }, 500);
  }
});
