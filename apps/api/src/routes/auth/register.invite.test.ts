// fork: invite-only technician signup gate on POST /register-partner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'users.id', email: 'users.email', setupCompletedAt: 'users.setupCompletedAt' },
  partnerUsers: { userId: 'partnerUsers.userId' },
}));

vi.mock('../../services', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/pendingRegistration', () => ({
  createPendingRegistration: vi.fn(async () => ({ rawToken: 'raw-token', tokenHash: 'f'.repeat(64) })),
}));

vi.mock('../../services/authEmailQueue', () => ({
  enqueueRegistrationVerification: vi.fn(async () => undefined),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../services/auditService', () => ({ createAuditLog: vi.fn(async () => undefined) }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1') }));

vi.mock('../../services/partnerSignupInvites', () => ({
  claimInvite: vi.fn(),
  releaseInviteClaim: vi.fn(async () => undefined),
  partnerSignupInviteOnly: vi.fn(() => true),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    runWithSystemDbAccess: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    authResponseFloorPromise: vi.fn(async () => undefined),
  };
});

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return { ...actual, ENABLE_REGISTRATION: true };
});

import { registerRoutes } from './register';
import { hashPassword } from '../../services';
import { createPendingRegistration } from '../../services/pendingRegistration';
import { claimInvite, releaseInviteClaim, partnerSignupInviteOnly } from '../../services/partnerSignupInvites';

const VALID_BODY = {
  companyName: 'RK Computers',
  email: 'ravi@rk.example',
  password: 'Sup3rSecure!',
  name: 'Ravi',
  acceptTerms: true,
};
const TOKEN = 'a'.repeat(43);
const CLAIMED = {
  id: '33333333-3333-3333-3333-333333333333',
  label: 'Ravi',
  tokenHash: 'h',
  status: 'used' as const,
  createdAt: '2026-11-14T00:00:00.000Z',
  expiresAt: '2026-11-21T00:00:00.000Z',
  createdByUserId: '11111111-1111-1111-1111-111111111111',
};

function post(body: unknown) {
  return registerRoutes.request('/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest/1.0' },
    body: JSON.stringify(body),
  });
}

describe('POST /register-partner — invite-only technician signup (fork)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    vi.mocked(partnerSignupInviteOnly).mockReturnValue(true);
    vi.mocked(createPendingRegistration).mockResolvedValue({ rawToken: 'raw-token', tokenHash: 'f'.repeat(64) });
  });

  afterEach(() => {
    delete process.env.IS_HOSTED;
  });

  it('refuses a signup without an invite and parks nothing', async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVITE_REQUIRED');
    expect(claimInvite).not.toHaveBeenCalled();
    expect(createPendingRegistration).not.toHaveBeenCalled();
  });

  it('refuses a used / revoked / unknown invite and parks nothing', async () => {
    vi.mocked(claimInvite).mockResolvedValueOnce(null);
    const res = await post({ ...VALID_BODY, inviteToken: TOKEN });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVITE_INVALID');
    expect(createPendingRegistration).not.toHaveBeenCalled();
  });

  it('claims the invite and parks the registration with its id', async () => {
    vi.mocked(claimInvite).mockResolvedValueOnce(CLAIMED);
    const res = await post({ ...VALID_BODY, inviteToken: TOKEN });
    expect(res.status).toBe(200);
    expect(claimInvite).toHaveBeenCalledWith(TOKEN, { email: VALID_BODY.email, companyName: VALID_BODY.companyName });
    expect(vi.mocked(createPendingRegistration).mock.calls[0]?.[0]).toMatchObject({ signupInviteId: CLAIMED.id });
  });

  it('does not burn the link when the form fails validation', async () => {
    const { isPasswordStrong } = await import('../../services');
    vi.mocked(isPasswordStrong).mockReturnValueOnce({ valid: false, errors: ['Password too weak'] });
    const res = await post({ ...VALID_BODY, inviteToken: TOKEN });
    expect(res.status).toBe(400);
    expect(claimInvite).not.toHaveBeenCalled();
  });

  it('releases the claim when the registration cannot be parked', async () => {
    vi.mocked(claimInvite).mockResolvedValueOnce(CLAIMED);
    vi.mocked(createPendingRegistration).mockRejectedValueOnce(new Error('redis down'));
    const res = await post({ ...VALID_BODY, inviteToken: TOKEN });
    expect(res.status).toBe(503);
    expect(releaseInviteClaim).toHaveBeenCalledWith(CLAIMED);
  });

  it('with open signup, a signup without an invite still works', async () => {
    vi.mocked(partnerSignupInviteOnly).mockReturnValue(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(vi.mocked(createPendingRegistration).mock.calls[0]?.[0]).not.toHaveProperty('signupInviteId');
    expect(hashPassword).toHaveBeenCalled();
  });

  it('with open signup, a bad invite is still refused rather than silently ignored', async () => {
    vi.mocked(partnerSignupInviteOnly).mockReturnValue(false);
    vi.mocked(claimInvite).mockResolvedValueOnce(null);
    const res = await post({ ...VALID_BODY, inviteToken: TOKEN });
    expect(res.status).toBe(400);
  });
});
