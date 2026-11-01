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

## Modified upstream files (check these after every sync)

| Path | Change | Why |
|---|---|---|
| `apps/web/src/components/layout/Sidebar.tsx` | One `Partners` item at the top of the `administration` section | Sidebar link to `/admin/partners` |
| `apps/web/src/locales/*/common.json` (8 files) | `nav.partnersAdmin` key next to `nav.deletionRequests` | `Sidebar.nav.test.tsx` requires every nav item to have a translated key |

## Operational notes (not in git)

- The partner directory needs a **system-scope platform admin**: `is_platform_admin = true` and **no** `partner_users` / `organization_users` rows. Breeze has no UI to create one; it is inserted with SQL. A partner-member platform admin (e.g. `admin@breeze.local`) gets a 403 there by design.
