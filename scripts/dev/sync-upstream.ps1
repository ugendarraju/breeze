# Pull the latest LanternOps/breeze changes into this fork.
#
#   .\scripts\dev\sync-upstream.ps1          # merge upstream/main into main
#   .\scripts\dev\sync-upstream.ps1 -Push    # ...and push to origin when clean
#
# Merges (never rebases) so our customizations are not replayed on every sync.
# On conflict it stops: fix the files listed, `git add` them, `git commit`,
# then check CUSTOMIZATIONS.md for anything the merge may have broken.

param([switch]$Push)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

if (git status --porcelain --untracked-files=no) { throw 'Commit or stash your changes before syncing.' }
if ((git branch --show-current) -ne 'main') { throw 'Switch to main before syncing.' }

git fetch upstream
$behind = git rev-list --count 'main..upstream/main'
if ($behind -eq '0') { Write-Host 'Already up to date with upstream.'; return }
Write-Host "$behind new upstream commit(s). Merging..."

git merge --no-edit upstream/main
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nMerge conflicts in:" -ForegroundColor Yellow
    git diff --name-only --diff-filter=U
    Write-Host "`nResolve them, 'git add' each file, then 'git commit'. Or 'git merge --abort' to back out."
    exit 1
}

pnpm install
pnpm db:migrate
Write-Host 'Merged cleanly. Run the app and tests before pushing.' -ForegroundColor Green
if ($Push) { git push origin main }
