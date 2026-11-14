import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  resolveHelpToken: vi.fn(),
  createHelpTicket: vi.fn(),
  allowed: true as boolean | ((bucket: string) => boolean),
  buckets: [] as string[],
}));

vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async (_redis: unknown, bucket: string) => {
    h.buckets.push(bucket);
    const allowed = typeof h.allowed === 'function' ? h.allowed(bucket) : h.allowed;
    return { allowed, remaining: 0, resetAt: new Date() };
  }),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/deviceHelp/helpLinkToken', async (orig) => ({
  ...(await orig<typeof import('../services/deviceHelp/helpLinkToken')>()),
  resolveHelpToken: h.resolveHelpToken,
}));
vi.mock('../services/deviceHelp/helpTicket', () => ({ createHelpTicket: h.createHelpTicket }));

import { deviceHelpPublicRoutes } from './deviceHelpPublic';
import { HelpLinkUnavailableError } from '../services/deviceHelp/helpLinkToken';

const DEVICE = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const app = new Hono().route('/device-help/public', deviceHelpPublicRoutes);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function form(overrides: Record<string, string | Blob | null> = {}) {
  const fd = new FormData();
  const base: Record<string, string | Blob | null> = {
    token: 'tok',
    name: 'Asha Rao',
    phone: '+1 (555) 010-2030',
    company: 'Cubestack',
    email: 'asha@example.com',
    details: 'Outlook crashes when I open attachments',
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === null) continue;
    if (v instanceof Blob) fd.append(k, v, 'error.png');
    else fd.append(k, v);
  }
  return fd;
}

const submit = (fd: FormData) => app.request('/device-help/public/submit', { method: 'POST', body: fd });

beforeEach(() => {
  h.resolveHelpToken.mockReset().mockResolvedValue(DEVICE);
  h.createHelpTicket.mockReset().mockResolvedValue({ ok: true, ticketNumber: 'T-2026-0042' });
  h.allowed = true;
  h.buckets = [];
});

describe('POST /device-help/public/check', () => {
  it('answers only valid true/false, never device data, with no-store headers', async () => {
    const res = await app.request('/device-help/public/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'tok' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    h.resolveHelpToken.mockResolvedValue(null);
    const bad = await app.request('/device-help/public/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
    });
    expect(await bad.json()).toEqual({ valid: false });
  });

  it('is rate limited per IP', async () => {
    h.allowed = false;
    const res = await app.request('/device-help/public/check', { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(h.resolveHelpToken).not.toHaveBeenCalled();
  });

  it('503 when the state store is down', async () => {
    h.resolveHelpToken.mockRejectedValue(new HelpLinkUnavailableError());
    const res = await app.request('/device-help/public/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 't' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /device-help/public/submit', () => {
  it('creates the ticket for the token device with the trimmed fields and a sniffed screenshot', async () => {
    const res = await submit(form({ name: '  Asha Rao ', screenshot: new Blob([PNG], { type: 'text/plain' }) }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ticketNumber: 'T-2026-0042' });
    expect(h.resolveHelpToken).toHaveBeenCalledWith('tok');
    const [deviceId, input, shot] = h.createHelpTicket.mock.calls[0]!;
    expect(deviceId).toBe(DEVICE);
    expect(input).toEqual({
      name: 'Asha Rao', phone: '+1 (555) 010-2030', company: 'Cubestack', email: 'asha@example.com',
      details: 'Outlook crashes when I open attachments',
    });
    // Type comes from the bytes, not the client's claim.
    expect(shot).toMatchObject({ contentType: 'image/png', filename: 'error.png' });
    expect(h.buckets).toEqual([expect.stringMatching(/^device-help-submit:/), `device-help-submit-device:${DEVICE}`]);
  });

  it('works without a screenshot', async () => {
    const res = await submit(form());
    expect(res.status).toBe(201);
    expect(h.createHelpTicket.mock.calls[0]![2]).toBeNull();
  });

  it('rejects a non-image file even when it claims to be one', async () => {
    const res = await submit(form({ screenshot: new Blob(['<svg onload=alert(1)>xxxxxxxx'], { type: 'image/png' }) }));
    expect(res.status).toBe(415);
    expect(h.createHelpTicket).not.toHaveBeenCalled();
  });

  it('rejects a bad email, bad phone or missing details, naming the fields', async () => {
    const res = await submit(form({ email: 'not-an-email', phone: 'call me', details: null }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields.sort()).toEqual(['details', 'email', 'phone']);
    expect(h.createHelpTicket).not.toHaveBeenCalled();
  });

  it('caps field lengths', async () => {
    const res = await submit(form({ details: 'x'.repeat(5001) }));
    expect(res.status).toBe(400);
  });

  it('an invalid, rotated or disabled link gets one generic 404 and no ticket', async () => {
    h.resolveHelpToken.mockResolvedValue(null);
    const res = await submit(form());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not valid/);
    expect(h.createHelpTicket).not.toHaveBeenCalled();
  });

  it('a decommissioned device answers like an invalid link', async () => {
    h.createHelpTicket.mockResolvedValue({ ok: false, reason: 'device_unavailable' });
    const res = await submit(form());
    expect(res.status).toBe(404);
  });

  it('ticketing turned off for the partner is a 409 with a plain message', async () => {
    h.createHelpTicket.mockResolvedValue({ ok: false, reason: 'ticketing_off' });
    const res = await submit(form());
    expect(res.status).toBe(409);
  });

  it('is rate limited per IP before parsing, and per device after the token resolves', async () => {
    h.allowed = false;
    expect((await submit(form())).status).toBe(429);
    expect(h.resolveHelpToken).not.toHaveBeenCalled();

    h.allowed = (bucket) => !bucket.startsWith('device-help-submit-device:');
    expect((await submit(form())).status).toBe(429);
    expect(h.createHelpTicket).not.toHaveBeenCalled();
  });

  it('an unexpected failure is a generic 500 without internals', async () => {
    h.createHelpTicket.mockRejectedValue(new Error('relation "tickets" does not exist'));
    const res = await submit(form());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation/);
  });
});
