# Customizations

This fork tracks [LanternOps/breeze](https://github.com/LanternOps/breeze) as the `upstream` remote.
Sync with `.\scripts\dev\sync-upstream.ps1`.

Rule of thumb: put new features in new files; keep edits to upstream files to small hooks.
Every upstream file we modify gets a row below, so merge conflicts have a checklist.

## Added files (ours, never conflict)

| Path | Purpose |
|---|---|
| `CUSTOMIZATIONS.md` | This log |
| `scripts/fork/setup-ubuntu.sh` | One-shot Breeze setup on fresh Ubuntu 24.04 (local VirtualBox VM, later the VPS) |
| `scripts/fork/Caddyfile.local` | Local HTTPS (Caddy internal CA, nip.io hostnames) in front of the dev stack |
| `scripts/dev/sync-upstream.ps1` | Merge upstream changes into this fork |
| `apps/web/src/components/admin/PartnersAdmin.tsx` (+ `.test.tsx`) | Platform-operator partner directory: list every MSP, activate / suspend / reactivate, open workspace. Uses the existing system-scope `GET`/`PATCH /orgs/partners` API (gentle, reversible suspend; never `suspend-for-abuse`) |
| `apps/web/src/pages/admin/partners.astro` | Route `/admin/partners` for the page above |

| `apps/api/src/services/partnerSignupInvites.ts` (+ `.test.ts`) | One-time technician signup invites, stored in Redis (`partner-invite:*`). Single use via `GETDEL` of the token key; no table, so no fork migration |
| `apps/api/src/routes/admin/partnerSignupInvites.ts` | `GET/POST/DELETE /admin/partner-invites` (platform admin; MFA on mutations; audited by `platformAdminMiddleware`) |
| `apps/api/src/routes/auth/register.invite.test.ts` | Invite gate tests for `/auth/register-partner` |
| `apps/web/src/components/admin/PartnerInvitesPanel.tsx` (+ `.test.tsx`) | "Technician invites" panel on `/admin/partners`: create link (shown once), list, revoke |

## Modified upstream files (check these after every sync)

| Path | Change | Why |
|---|---|---|
| `apps/api/src/routes/admin/index.ts` | Mount `partnerSignupInviteAdminRoutes` at `/partner-invites` | Invite admin API |
| `apps/api/src/routes/auth/schemas.ts` | Optional `inviteToken` on `registerPartnerSchema` | Invite signup |
| `apps/api/src/routes/auth/register.ts` | `/register-partner`: refuse without invite when `PARTNER_SIGNUP_INVITE_ONLY`; claim the invite after input checks; release it if parking fails | Invite-only signup |
| `apps/api/src/services/pendingRegistration.ts` | Optional `signupInviteId` on the pending record | Carries the invite to step 2 |
| `apps/api/src/routes/auth/verifyEmail.ts` | Refuse invite-less records in invite-only mode; invited partners created `pending` with an approval `statusMessage`; link invite → partner; redirect to `/account/inactive` | Admin approval of invited technicians |
| `apps/api/src/routes/config.ts` | Top-level `signupInvites.inviteOnly` in `GET /config` (kept out of `registration` so upstream tests stay untouched) | Web gate |
| `apps/web/src/stores/featuresStore.ts` | `signupInviteOnly` slice; `useRegistrationGate` also returns `inviteOnly` | Web gate |
| `apps/web/src/stores/auth.ts` | `apiRegisterPartner` optional `inviteToken` arg | Invite signup |
| `apps/web/src/components/auth/PartnerRegisterPage.tsx` | Read `#invite=` from the URL; "invitation only" card when invite-only and no invite | Invite signup |
| `apps/web/src/components/auth/LoginForm.tsx` | Hide "Register your MSP" when invite-only | Invite-only signup |
| `apps/web/src/pages/admin/partners.astro` | Render `PartnerInvitesPanel` under `PartnersAdmin` | Invite UI |
| `.env.example` | `PARTNER_SIGNUP_INVITE_ONLY` | Documents the switch |
| `apps/web/src/components/layout/Sidebar.tsx` | One `Partners` item at the top of the `administration` section | Sidebar link to `/admin/partners` |
| `apps/web/src/locales/*/common.json` (8 files) | `nav.partnersAdmin` key next to `nav.deletionRequests` | `Sidebar.nav.test.tsx` requires every nav item to have a translated key |

## Operational notes (not in git)

- The partner directory needs a **system-scope platform admin**: `is_platform_admin = true` and **no** `partner_users` / `organization_users` rows. Breeze has no UI to create one; it is inserted with SQL. A partner-member platform admin (e.g. `admin@breeze.local`) gets a 403 there by design.
