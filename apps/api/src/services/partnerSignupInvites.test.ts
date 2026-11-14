import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// In-memory Redis stand-in. Each method body runs without an internal await,
// so getdel is atomic the way the real command is: two concurrent claims race
// for one key and exactly one sees the value.
const store = new Map<string, string>();
const zset = new Map<string, number>();
const fakeRedis = {
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  }),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  zadd: vi.fn(async (_key: string, score: number, member: string) => {
    zset.set(member, score);
    return 1;
  }),
  zrevrange: vi.fn(async () => [...zset.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)),
  zrem: vi.fn(async (_key: string, ...members: string[]) => {
    members.forEach((m) => zset.delete(m));
    return members.length;
  }),
};

vi.mock('./redis', () => ({ getRedis: () => fakeRedis }));

import {
  attachInvitePartner,
  claimInvite,
  createInvite,
  getInvite,
  hashInviteToken,
  listInvites,
  partnerSignupInviteOnly,
  releaseInviteClaim,
  revokeInvite,
} from './partnerSignupInvites';

const ADMIN = { createdByUserId: '11111111-1111-1111-1111-111111111111', createdByEmail: 'op@example.com' };
const ATTEMPT = { email: 'Ravi@RK.example ', companyName: 'RK Computers' };

describe('partnerSignupInvites', () => {
  beforeEach(() => {
    store.clear();
    zset.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    delete process.env.PARTNER_SIGNUP_INVITE_ONLY;
  });

  it('stores only the token hash, never the raw token', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    const serialized = [...store.values()].join('\n');
    expect(serialized).not.toContain(token);
    expect(store.has(`partner-invite:token:${hashInviteToken(token)}`)).toBe(true);
    expect(invite).not.toHaveProperty('tokenHash');
    expect(invite.status).toBe('open');
  });

  it('a link works exactly once: the second claim (a forwarded copy) is refused', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    const first = await claimInvite(token, ATTEMPT);
    expect(first?.id).toBe(invite.id);
    expect(first?.usedEmail).toBe('ravi@rk.example');
    expect(await claimInvite(token, { email: 'someone@else.example', companyName: 'Else' })).toBeNull();
    expect((await getInvite(invite.id))?.status).toBe('used');
  });

  it('concurrent claims of one link: exactly one wins', async () => {
    const { token } = await createInvite({ label: 'Ravi', ...ADMIN });
    const results = await Promise.all(Array.from({ length: 10 }, () => claimInvite(token, ATTEMPT)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses unknown tokens', async () => {
    expect(await claimInvite('not-a-real-token-value', ATTEMPT)).toBeNull();
    expect(await claimInvite('', ATTEMPT)).toBeNull();
  });

  it('a revoked link stops working', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    const revoked = await revokeInvite(invite.id);
    expect(revoked?.status).toBe('revoked');
    expect(await claimInvite(token, ATTEMPT)).toBeNull();
  });

  it('revoking a used invite leaves it used', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    await claimInvite(token, ATTEMPT);
    expect((await revokeInvite(invite.id))?.status).toBe('used');
  });

  it('revoke of an unknown id returns null', async () => {
    expect(await revokeInvite('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('an expired link is refused and lists as expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const { token, invite } = await createInvite({ label: 'Ravi', ttlDays: 1, ...ADMIN });
    vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
    // The real token key would have expired by TTL; the record check is the backstop.
    expect(await claimInvite(token, ATTEMPT)).toBeNull();
    const [listed] = await listInvites();
    expect(listed.id).toBe(invite.id);
    expect(listed.status).toBe('expired');
  });

  it('clamps the lifetime to 1..30 days', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-14T00:00:00Z');
    vi.setSystemTime(now);
    const { invite } = await createInvite({ label: 'long', ttlDays: 365, ...ADMIN });
    expect(Date.parse(invite.expiresAt) - now.getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it('releasing a claim reopens the same link', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    const claimed = await claimInvite(token, ATTEMPT);
    await releaseInviteClaim(claimed!);
    const reread = await getInvite(invite.id);
    expect(reread?.status).toBe('open');
    expect(reread?.usedEmail).toBeUndefined();
    expect((await claimInvite(token, ATTEMPT))?.id).toBe(invite.id);
  });

  it('records the partner the invite produced', async () => {
    const { token, invite } = await createInvite({ label: 'Ravi', ...ADMIN });
    await claimInvite(token, ATTEMPT);
    await attachInvitePartner(invite.id, '22222222-2222-2222-2222-222222222222');
    expect((await getInvite(invite.id))?.partnerId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('lists newest first and prunes index entries whose record aged out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const a = await createInvite({ label: 'A', ...ADMIN });
    vi.setSystemTime(new Date('2026-11-14T01:00:00Z'));
    const b = await createInvite({ label: 'B', ...ADMIN });
    expect((await listInvites()).map((i) => i.label)).toEqual(['B', 'A']);
    store.delete(`partner-invite:rec:${a.invite.id}`);
    expect((await listInvites()).map((i) => i.id)).toEqual([b.invite.id]);
    expect(zset.has(a.invite.id)).toBe(false);
  });

  it('PARTNER_SIGNUP_INVITE_ONLY toggles invite-only mode', () => {
    expect(partnerSignupInviteOnly()).toBe(false);
    process.env.PARTNER_SIGNUP_INVITE_ONLY = 'true';
    expect(partnerSignupInviteOnly()).toBe(true);
  });
});
