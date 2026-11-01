# Customizations

This fork tracks [LanternOps/breeze](https://github.com/LanternOps/breeze) as the `upstream` remote.
Sync with `.\scripts\dev\sync-upstream.ps1`.

Rule of thumb: put new features in new files; keep edits to upstream files to small hooks.
Every upstream file we modify gets a row below, so merge conflicts have a checklist.

## Added files (ours, never conflict)

| Path | Purpose |
|---|---|
| `CUSTOMIZATIONS.md` | This log |
| `scripts/dev/podman-infra.ps1` | Local Postgres + Redis on Podman (Windows, no Docker) |
| `scripts/dev/sync-upstream.ps1` | Merge upstream changes into this fork |

## Modified upstream files (check these after every sync)

| Path | Change | Why |
|---|---|---|
| _none yet_ | | |
