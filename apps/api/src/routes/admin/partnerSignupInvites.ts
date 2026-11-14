/**
 * Fork feature: platform-admin management of one-time technician signup invites.
 * Mounted under adminRoutes (platformAdminMiddleware audits every request);
 * mutations additionally require MFA, like the other admin write surfaces.
 *
 *   GET    /admin/partner-invites          list (newest first)
 *   POST   /admin/partner-invites          { label, ttlDays? } -> { invite, token } (token shown once)
 *   DELETE /admin/partner-invites/:id      revoke an unused invite
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import {
  createInvite,
  listInvites,
  revokeInvite,
  partnerSignupInviteOnly,
  INVITE_MAX_TTL_DAYS,
} from '../../services/partnerSignupInvites';

const createInviteSchema = z.object({
  label: z.string().trim().min(1).max(120),
  ttlDays: z.number().int().min(1).max(INVITE_MAX_TTL_DAYS).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

export const partnerSignupInviteAdminRoutes = new Hono();

partnerSignupInviteAdminRoutes.get('/', async (c) => {
  const invites = await listInvites();
  return c.json({ data: invites, inviteOnly: partnerSignupInviteOnly() });
});

partnerSignupInviteAdminRoutes.post('/', requireMfa(), zValidator('json', createInviteSchema), async (c) => {
  const auth = c.get('auth');
  const { label, ttlDays } = c.req.valid('json');
  const { invite, token } = await createInvite({
    label,
    ttlDays,
    createdByUserId: auth.user.id,
    createdByEmail: auth.user.email,
  });
  return c.json({ invite, token }, 201);
});

partnerSignupInviteAdminRoutes.delete('/:id', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const invite = await revokeInvite(id);
  if (!invite) return c.json({ error: 'Invite not found' }, 404);
  return c.json({ invite });
});
