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
