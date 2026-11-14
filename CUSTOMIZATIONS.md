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
| `apps/api/src/routes/auth/register.ts` | `/register-partner`: refuse without invite when `PARTNER_SIGNUP_INVITE_ONLY`; claim the invite after input checks (a claimed link is never reopened) | Invite-only signup |
| `apps/api/src/services/pendingRegistration.ts` | Optional `signupInviteId` on the pending record | Carries the invite to step 2 |
| `apps/api/src/routes/auth/verifyEmail.ts` | Refuse invite-less records in invite-only mode; invited partners created `pending` with an approval `statusMessage` and skip the `registration` partner hook (it could otherwise activate them); link invite → partner; redirect to `/account/inactive` | Admin approval of invited technicians |
| `apps/api/src/routes/config.ts` | Top-level `signupInvites.inviteOnly` in `GET /config` (kept out of `registration` so upstream tests stay untouched) | Web gate |
| `apps/web/src/stores/featuresStore.ts` | `signupInviteOnly` slice; `useRegistrationGate` also returns `inviteOnly` | Web gate |
| `apps/web/src/stores/auth.ts` | `apiRegisterPartner` optional `inviteToken` arg | Invite signup |
| `apps/web/src/components/auth/PartnerRegisterPage.tsx` | Read `#invite=` from the URL; "invitation only" card when invite-only and no invite | Invite signup |
| `apps/web/src/components/auth/LoginForm.tsx` | Hide "Register your MSP" when invite-only | Invite-only signup |
| `apps/web/src/pages/admin/partners.astro` | Render `PartnerInvitesPanel` under `PartnersAdmin` | Invite UI |
| `.env.example` | `PARTNER_SIGNUP_INVITE_ONLY` | Documents the switch |
| `apps/web/src/components/layout/Sidebar.tsx` | One `Partners` item at the top of the `administration` section | Sidebar link to `/admin/partners` |
| `apps/web/src/locales/*/common.json` (8 files) | `nav.partnersAdmin` key next to `nav.deletionRequests` | `Sidebar.nav.test.tsx` requires every nav item to have a translated key |
| `apps/web/src/styles/globals.css` | Rules after the global `select { padding-right }`: zero block padding on `h-6`..`h-10` selects; opaque tint + `z-index` on `thead.sticky.bg-muted/40` and `/30` | Fixed-height selects clipped their text (forms plugin padding); translucent sticky table headers let rows show through (Software tab and ~17 other tables) |
| `apps/web/src/components/devices/DeviceDetails.tsx` | Header icon uses `getDeviceRoleIcon(device.deviceRole)` (Monitor when unknown) | Servers, printers etc. no longer all show a monitor |

## Operational notes (not in git)

- The partner directory needs a **system-scope platform admin**: `is_platform_admin = true` and **no** `partner_users` / `organization_users` rows. Breeze has no UI to create one; it is inserted with SQL. A partner-member platform admin (e.g. `admin@breeze.local`) gets a 403 there by design.

## Battery health (fork)

Per-OS system scripts read laptop battery health and save it as device custom fields; the Power section shows it, and a low reading raises an alert. Uses the official signed agent (no agent change).

| Path | Kind | What |
|---|---|---|
| `apps/api/src/services/batteryHealthScript.ts` (+ `.test.ts`) | added | "Battery Health (Windows / macOS / Linux)" system library scripts; write-back field keys |
| `apps/api/src/services/batteryHealthProvisioning.ts` | added | Per partner, once (Redis set `fork:battery-health:provisioned-partners`): 3 number custom fields (`scriptWrite`) + one monthly partner-wide automation per OS, filtered to that OS. Runs at API boot and hourly |
| `apps/api/src/services/batteryHealthAlerts.ts` (+ `.test.ts`) | added | Health < 50% → rule-less alert via `createSourcedAlert` (`configItemName: battery_health`); auto-resolves at ≥ 50%; dismissal respected |
| `apps/web/src/components/devices/batteryHealth.ts` (+ `.test.ts`) | added | Health % / capacities from custom fields |
| `apps/api/src/services/systemScriptLibrary.ts` | modified | `...FORK_SYSTEM_LIBRARY_SCRIPTS` at the end of `SYSTEM_LIBRARY_SCRIPTS` |
| `apps/api/src/index.ts` | modified | `startBatteryHealthProvisioning()` after `ensureSystemLibraryScripts` |
| `apps/api/src/services/customFields/scriptWriteBack.ts` | modified | `evaluateBatteryHealthAlertSafely(device, writes)` after values are persisted |
| `apps/web/src/components/devices/DeviceInfoTab.tsx` | modified | Battery Health / Design Capacity / Full Charge Capacity / Charge Cycles rows in the Power section |
| `apps/web/src/locales/*/devices.json` (8 files) | modified | `deviceInfoTab.batteryHealth`, `designCapacity`, `fullChargeCapacity`, `chargeCycles` |

Parked alternative: branch `feature/battery-health-agent` collects the same data in the agent itself (needs our own signed agent builds).
### Registries updated for the invite feature (upstream guard tests)

| Path | Change |
|---|---|
| `apps/api/src/services/mcpCoverage.ts` | `'admin/partnerSignupInvites.ts': { exempt: 'platform_admin' }` |
| `apps/api/src/system/connections/internalEnvVars.ts` | `PARTNER_SIGNUP_INVITE_ONLY` |
| `apps/api/src/__tests__/orgSettingsWriters.contract.test.ts` | `verifyEmail.ts` write sites 3 → 4 |
## Library scripts listed on the Scripts page (fork)

| Path | Change |
|---|---|
| `apps/web/src/components/scripts/ScriptsPage.tsx` | Loads the list with `includeSystem: true`; Edit / Duplicate on a built-in script opens Import from Library |
| `apps/web/src/components/scripts/ScriptList.tsx` | No Edit / Delete buttons on `isSystem` rows (Run and the copy button stay) |
## Software tab: updates filter + bulk update (fork)

| Path | Change |
|---|---|
| `apps/web/src/components/devices/DeviceSoftwareInventory.tsx` | "Updates only" toggle, row checkboxes on updatable rows, "Select all with updates", "Update selected (N)" (sequential, one summary toast); `queueSoftwareAction` gains `quiet` and returns success |
| `apps/web/src/components/devices/DeviceSoftwareInventory.bulk.test.tsx` | added: tests for the above |
| `apps/web/src/locales/*/devices.json` (8 files) | `deviceSoftwareInventory.bulk.*` |

## Manual warranty dates (fork)

| Path | Change |
|---|---|
| `apps/api/src/routes/devices/warranty.ts` | `PUT /devices/:id/warranty/manual` (dates saved via `applyWarrantyImport`, data_source `import`; 409 for agent-owned; audited) |
| `apps/api/src/routes/devices/warranty.test.ts` | MFA gate count pin 1 -> 2 |
| `apps/api/src/routes/devices/warranty.manual.test.ts` | added: route tests |
| `apps/web/src/components/devices/WarrantyManualControls.tsx` (+ `.test.tsx`) | added: "Edit dates" + "Check on vendor site" (ASUS global, Acer, Microsoft, Dell service tag, HP, Lenovo) |
| `apps/web/src/components/devices/DeviceWarrantyCard.tsx` | Renders `WarrantyManualControls` beside Refresh |
| `apps/web/src/locales/*/devices.json` (8 files) | `deviceWarrantyCard.manual.*` |

## Device Drivers tab (fork)

Windows only. Scan lists installed drivers and newer ones from Windows Update (matched by hardware ID) and from the maker's tool when installed (Dell Command Update, HP Image Assistant, Lenovo Thin Installer / System Update). Technician-confirmed installs; never restarts the device. All device work runs as system library scripts (no agent change).

| Path | Change |
|---|---|
| `apps/api/src/services/driverScripts.ts` (+ `.test.ts`) | added: Driver Scan / Driver Install / Driver Tool Install (winget) scripts and output parsers |
| `apps/api/src/services/batteryHealthScript.ts` | `FORK_SYSTEM_LIBRARY_SCRIPTS` also spreads `DRIVER_SCRIPTS` |
| `apps/api/src/services/batteryHealthScript.test.ts` | fork-script count check counts battery scripts only |
| `apps/api/src/routes/devices/drivers.ts` | added: `GET /devices/:id/drivers`, `POST .../drivers/scan`, `.../drivers/install`, `.../drivers/install-tool` |
| `apps/api/src/routes/devices/index.ts` | mounts `driversRoutes` |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts` | registers the three drivers POST routes |
| `apps/api/src/services/mcpCoverage.ts` | `devices/drivers.ts` exempt (`human_only_oem_updates`) |
| `apps/web/src/components/devices/DeviceDriversTab.tsx` (+ `.test.tsx`) | added: Drivers tab |
| `apps/web/src/components/devices/DeviceDetails.tsx` | `drivers` tab (Windows, Inventory group under More) |
| `apps/web/src/locales/*/devices.json` (8 files) | `deviceDrivers.*`, `deviceDetails.drivers`, `deviceDetails.driversTitle` |
