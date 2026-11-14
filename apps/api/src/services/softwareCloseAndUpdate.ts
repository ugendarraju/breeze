/**
 * fork: "Close app and update" for the device Software tab (Windows).
 *
 * A silent installer refuses to run while another process holds its files
 * (OBS Studio: "Files modified by the installer are currently in use", exit 6
 * — often the OBS virtual-camera DLL loaded inside Teams/Zoom/a browser). This
 * builds one server-authored PowerShell script, run as SYSTEM through the raw
 * script dispatch path, that:
 *
 *  1. force-stops every process whose executable or a loaded module lives in
 *     the app's install folder (never itself, its parents, or core Windows
 *     processes / the shell), printing what it stopped;
 *  2. runs `winget upgrade --exact --id <id> --source winget` — pinned to the
 *     exact package and the winget source.
 *
 * The folder and id are validated here and embedded as single-quoted literals.
 */
import { WINGET_PACKAGE_ID_RE } from '../routes/devices/softwareUpdateMatch';

export const CLOSE_AND_UPDATE_PROVENANCE = 'software_close_and_update';
export const CLOSE_AND_UPDATE_TIMEOUT_SECONDS = 900;

/** Folder names too broad to stop "everything inside" (matched on the last segment). */
const BROAD_LEAF_NAMES = new Set([
  'program files', 'program files (x86)', 'common files', 'windowsapps', 'windows', 'system32', 'syswow64',
  'microsoft', 'programs', 'temp', 'tmp', 'packages', 'appdata', 'local', 'locallow', 'roaming',
  'programdata', 'users', 'windows nt', 'windowspowershell', 'microsoft shared',
]);
/** Top-level folders whose contents are never an app's own folder at shallow depth. */
const SYSTEM_ROOTS = new Set(['windows', '$recycle.bin', 'system volume information', 'recovery', 'boot']);
const NON_APP_UNINSTALLERS = new Set(['msiexec.exe', 'rundll32.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe']);

/**
 * Validate an install folder: absolute drive path, specific to one app, not a
 * shared or system root. Returns the normalized folder (no trailing slash) or null.
 */
export function safeAppFolder(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^"+|"+$/g, '').replace(/[\\/]+$/, '');
  // Control characters, wildcards and quotes never belong in a folder we embed.
  if (!trimmed || /[\x00-\x1f*?"<>|]/.test(trimmed)) return null;
  const normalized = trimmed.replace(/\//g, '\\');
  const match = /^([A-Za-z]):\\(.+)$/.exec(normalized);
  if (!match) return null;
  const segments = match[2]!.split('\\');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const lower = segments.map((s) => s.toLowerCase());
  if (SYSTEM_ROOTS.has(lower[0]!)) return null;
  if (BROAD_LEAF_NAMES.has(lower[lower.length - 1]!)) return null;
  if (lower.includes('windowsapps') || lower.includes('common files')) return null;
  // Program Files\<App>, Tools\<App>: at least two levels below the drive.
  if (segments.length < 2) return null;
  // ProgramData\<Vendor>\<App>, Users\<name>\AppData\Local\<App>: need more depth.
  if (lower[0] === 'programdata' && segments.length < 3) return null;
  if (lower[0] === 'users' && segments.length < 5) return null;
  return `${match[1]!.toUpperCase()}:\\${segments.join('\\')}`;
}

/** The folder of the uninstaller exe in an uninstall string, unless it's a generic host (msiexec etc.). */
export function folderFromUninstallString(uninstall: string | null | undefined): string | null {
  if (!uninstall) return null;
  const quoted = /^\s*"([^"]+?\.exe)"/i.exec(uninstall);
  const bare = quoted ? null : /^\s*([A-Za-z]:\\[^"]*?\.exe)(?=\s|$)/i.exec(uninstall);
  const exe = quoted?.[1] ?? bare?.[1];
  if (!exe) return null;
  const parts = exe.replace(/\//g, '\\').split('\\');
  const file = parts.pop()!.toLowerCase();
  if (NON_APP_UNINSTALLERS.has(file)) return null;
  return parts.join('\\');
}

/** Install folder for a software row: InstallLocation, else the uninstaller's folder. */
export function resolveAppFolder(row: { installLocation: string | null; uninstallString: string | null }): string | null {
  return safeAppFolder(row.installLocation) ?? safeAppFolder(folderFromUninstallString(row.uninstallString));
}

const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The script. `folder` must come from safeAppFolder and `packageId` match the winget id shape. */
export function buildCloseAndUpdateScript(folder: string, packageId: string): string {
  if (safeAppFolder(folder) !== folder) throw new Error('unsafe install folder');
  if (!WINGET_PACKAGE_ID_RE.test(packageId)) throw new Error('invalid winget package id');
  return `# Breeze: close app and update (server-generated)
$ErrorActionPreference = 'Continue'
$appDir = ${psLiteral(folder)} + '\\'
$packageId = ${psLiteral(packageId)}
$protected = @('System','Idle','Registry','smss','csrss','wininit','winlogon','services','lsass','svchost','dwm','fontdrvhost','MsMpEng','explorer','sihost','ctfmon')

# Never stop this script or the agent that launched it.
$skip = New-Object 'System.Collections.Generic.HashSet[int]'
$cur = $PID
for ($i = 0; $i -lt 16 -and $cur; $i++) {
  [void]$skip.Add([int]$cur)
  $cur = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue).ParentProcessId
}

$targets = @()
foreach ($proc in Get-Process) {
  if ($skip.Contains($proc.Id) -or ($protected -contains $proc.ProcessName)) { continue }
  $hit = $false
  try { if ($proc.Path -and $proc.Path.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true } } catch {}
  if (-not $hit) {
    try {
      foreach ($m in $proc.Modules) {
        if ($m.FileName -and $m.FileName.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true; break }
      }
    } catch {}
  }
  if ($hit) { $targets += $proc }
}

if ($targets.Count -eq 0) {
  Write-Output "No running process was using $appDir"
} else {
  foreach ($t in $targets) {
    try {
      Stop-Process -Id $t.Id -Force -ErrorAction Stop
      Write-Output "Stopped $($t.ProcessName) (PID $($t.Id))"
    } catch {
      Write-Output "Could not stop $($t.ProcessName) (PID $($t.Id)): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 3
}

# winget for SYSTEM: the newest App Installer under WindowsApps, else PATH.
$wingetPath = $null
$candidates = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'WindowsApps') -Filter 'Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe' -Directory -ErrorAction SilentlyContinue |
  ForEach-Object {
    $version = $null
    if ($_.Name -match '_(\\d+(?:\\.\\d+)+)_') { $version = [version]$Matches[1] }
    [pscustomobject]@{ Path = (Join-Path $_.FullName 'winget.exe'); Version = $version }
  } |
  Where-Object { $_.Version -and (Test-Path $_.Path) } |
  Sort-Object Version -Descending
if ($candidates) { $wingetPath = @($candidates)[0].Path }
if (-not $wingetPath) {
  $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($cmd) { $wingetPath = $cmd.Source }
}
if (-not $wingetPath) { Write-Output 'winget was not found on this device.'; exit 1 }

Write-Output "Updating $packageId with winget..."
& $wingetPath upgrade --exact --id $packageId --source winget --include-unknown --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
$code = $LASTEXITCODE
# 0x8A15002B: no applicable upgrade (already current).
if ($code -eq -1978335189) { Write-Output 'Already up to date.'; exit 0 }
exit $code
`;
}
