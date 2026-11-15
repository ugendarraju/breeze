/**
 * fork: guarded Windows software updates for the device Software tab.
 *
 * A silent installer refuses to run while another process holds its files
 * (OBS Studio: "Files modified by the installer are currently in use", exit 6,
 * because Chrome/Opera had loaded the OBS virtual-camera DLL). Every Windows
 * update from the Software tab therefore runs as server-authored PowerShell,
 * as SYSTEM, through the raw script dispatch path:
 *
 *  - a short DETECT script lists, per package, the programs whose executable
 *    or a loaded module lives in the package's install folder;
 *  - the UPDATE script updates packages nobody is blocking right away, then,
 *    per mode, either waits for the blocking programs to close ('wait') or
 *    force-stops them ('force', the technician's "Close & update"), and runs
 *    `winget upgrade --exact --id <id> --source winget` for each package.
 *
 * Both print one `BREEZE_SOFTWARE_UPDATE {json}` line per package so the API can
 * report blockers and outcomes. Folders and ids are validated here and embedded
 * as single-quoted literals. Core Windows processes, the shell, the script and
 * its parents (the agent) are never stopped.
 */
import { WINGET_PACKAGE_ID_RE } from '../routes/devices/softwareUpdateMatch';

export const DETECT_PROVENANCE = 'software_update_detect';
export const UPDATE_PROVENANCE = 'software_update_guarded';
export const DETECT_TIMEOUT_SECONDS = 60;
/** How long a 'wait' run waits for blocking programs to close (all packages share it). */
export const BLOCKER_WAIT_SECONDS = 600;
export const MARKER = 'BREEZE_SOFTWARE_UPDATE';

/** Script timeout: the blocker wait plus ~5 minutes per package, within the agent's 1h cap. */
export function updateTimeoutSeconds(packageCount: number): number {
  return Math.min(3600, BLOCKER_WAIT_SECONDS + 300 * Math.max(1, packageCount) + 60);
}

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

export interface GuardedPackage {
  packageId: string;
  /** Display name (for messages); any text, embedded as a literal. */
  name: string;
  /** Install folder from resolveAppFolder, or null (then no blocker detection). */
  folder: string | null;
}

export type UpdateMode = 'wait' | 'force';

const psLiteral = (value: string) => `'${value.replace(/[\r\n]/g, ' ').replace(/'/g, "''")}'`;

function packagesBlock(packages: GuardedPackage[]): string {
  if (packages.length === 0) throw new Error('no packages');
  const rows = packages.map((p) => {
    if (!WINGET_PACKAGE_ID_RE.test(p.packageId)) throw new Error('invalid winget package id');
    if (p.folder !== null && safeAppFolder(p.folder) !== p.folder) throw new Error('unsafe install folder');
    const dir = p.folder === null ? '$null' : psLiteral(p.folder);
    return `  @{ Id = ${psLiteral(p.packageId)}; Name = ${psLiteral(p.name.slice(0, 200))}; Dir = ${dir} }`;
  });
  return `$packages = @(\n${rows.join(',\n')}\n)`;
}

/** Shared helpers: blocker detection (never the script, its parents, or core Windows processes). */
const COMMON = `$ErrorActionPreference = 'Continue'
$protected = @('System','Idle','Registry','smss','csrss','wininit','winlogon','services','lsass','svchost','dwm','fontdrvhost','MsMpEng','explorer','sihost','ctfmon')
$skip = New-Object 'System.Collections.Generic.HashSet[int]'
$cur = $PID
for ($i = 0; $i -lt 16 -and $cur; $i++) {
  [void]$skip.Add([int]$cur)
  $cur = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue).ParentProcessId
}

$rmReady = $false
try {
  Add-Type -ErrorAction Stop -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BreezeRm {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int Id; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
    public int Type; public int Status; public int Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, UniqueProcess[] apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  public static List<int> Holders(string[] files) {
    var ids = new List<int>();
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return ids;
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return ids;
      uint needed = 0, count = 0, reasons = 0;
      if (RmGetList(h, out needed, ref count, null, ref reasons) != 234 || needed == 0) return ids;
      var info = new ProcessInfo[needed];
      count = needed;
      if (RmGetList(h, out needed, ref count, info, ref reasons) != 0) return ids;
      for (int i = 0; i < count; i++) ids.Add(info[i].Process.Id);
    } finally { RmEndSession(h); }
    return ids;
  }
}
"@
  $rmReady = $true
} catch {}

function Get-Blockers([string]$dir) {
  $found = @()
  if (-not $dir) { return ,$found }
  $prefix = $dir + '\\'
  foreach ($proc in Get-Process) {
    if ($skip.Contains($proc.Id) -or ($protected -contains $proc.ProcessName)) { continue }
    $hit = $false
    try { if ($proc.Path -and $proc.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true } } catch {}
    if (-not $hit) {
      try {
        foreach ($m in $proc.Modules) {
          if ($m.FileName -and $m.FileName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $hit = $true; break }
        }
      } catch {}
    }
    if ($hit) { $found += $proc }
  }
  # Also ask Windows' Restart Manager (what installers use for "files in use"):
  # it sees open file handles, not just loaded modules.
  if ($rmReady) {
    $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 4000 -ExpandProperty FullName)
    if ($files.Count -gt 0) {
      foreach ($holder in [BreezeRm]::Holders([string[]]$files)) {
        if ($skip.Contains($holder) -or ($found | Where-Object { $_.Id -eq $holder })) { continue }
        $proc = Get-Process -Id $holder -ErrorAction SilentlyContinue
        if ($proc -and -not ($protected -contains $proc.ProcessName)) { $found += $proc }
      }
    }
  }
  return ,$found
}

function Get-Labels($procs) {
  $labels = @()
  foreach ($p in $procs) {
    $label = $null
    try { $label = $p.MainModule.FileVersionInfo.FileDescription } catch {}
    if ([string]::IsNullOrWhiteSpace($label)) { $label = $p.ProcessName }
    $labels += $label.Trim()
  }
  return ,@($labels | Sort-Object -Unique)
}

function Write-Marker($data) {
  Write-Output ('${MARKER} ' + (ConvertTo-Json -InputObject $data -Compress -Depth 4))
}
`;

/** Detect-only: one marker per package with the programs holding its folder. Stops nothing. */
export function buildDetectScript(packages: GuardedPackage[]): string {
  return `# Breeze: find programs blocking software updates (server-generated, read-only)
${packagesBlock(packages)}
${COMMON}
foreach ($pkg in $packages) {
  $programs = @()
  if ($pkg.Dir) { $programs = Get-Labels (Get-Blockers $pkg.Dir) }
  Write-Marker ([ordered]@{ phase = 'detect'; packageId = $pkg.Id; programs = $programs })
}
exit 0
`;
}

/** 'force': stop every blocker (the technician confirmed). Only emitted in force mode. */
const FORCE_BLOCK = `    foreach ($t in $blockers) {
      try {
        Stop-Process -Id $t.Id -Force -ErrorAction Stop
        Write-Output "Stopped $($t.ProcessName) (PID $($t.Id)) for $($pkg.Name)"
      } catch {
        Write-Output "Could not stop $($t.ProcessName) (PID $($t.Id)): $($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 3`;

/** 'wait': poll until the user has closed the blockers or the shared deadline passes. */
const WAIT_BLOCK = `    $names = (Get-Labels $blockers) -join ', '
    Write-Output "Waiting for $names to close so $($pkg.Name) can update..."
    while ($blockers.Count -gt 0 -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 15
      $blockers = Get-Blockers $pkg.Dir
    }`;

/** Update: unblocked packages first, then wait for (or force-stop) blockers and update the rest. */
export function buildGuardedUpdateScript(packages: GuardedPackage[], mode: UpdateMode): string {
  return `# Breeze: guarded software update (server-generated, mode: ${mode})
${packagesBlock(packages)}
# mode: ${mode}
$waitSeconds = ${BLOCKER_WAIT_SECONDS}
${COMMON}
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

# Packages nobody is blocking go first, so one open program can't hold up the rest.
$ordered = @($packages | Sort-Object { (Get-Blockers $_.Dir).Count -gt 0 })
$deadline = (Get-Date).AddSeconds($waitSeconds)
$failed = $false

foreach ($pkg in $ordered) {
  $blockers = Get-Blockers $pkg.Dir
  if ($blockers.Count -gt 0) {
${mode === 'force' ? FORCE_BLOCK : WAIT_BLOCK}
    $blockers = Get-Blockers $pkg.Dir
    if ($blockers.Count -gt 0) {
      Write-Marker ([ordered]@{ phase = 'update'; packageId = $pkg.Id; name = $pkg.Name; outcome = 'blocked'; exitCode = $null; programs = (Get-Labels $blockers) })
      $failed = $true
      continue
    }
  }

  Write-Output "Updating $($pkg.Name) ($($pkg.Id))..."
  & $wingetPath upgrade --exact --id $pkg.Id --source winget --include-unknown --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Marker ([ordered]@{ phase = 'update'; packageId = $pkg.Id; name = $pkg.Name; outcome = 'updated'; exitCode = 0; programs = @() })
  } elseif ($code -eq -1978335189) {
    # 0x8A15002B: no applicable upgrade (already current).
    Write-Marker ([ordered]@{ phase = 'update'; packageId = $pkg.Id; name = $pkg.Name; outcome = 'up_to_date'; exitCode = $code; programs = @() })
  } else {
    $after = @()
    if ($pkg.Dir) { $after = Get-Labels (Get-Blockers $pkg.Dir) }
    Write-Marker ([ordered]@{ phase = 'update'; packageId = $pkg.Id; name = $pkg.Name; outcome = 'failed'; exitCode = $code; programs = $after })
    $failed = $true
  }
}

if ($failed) { exit 1 }
exit 0
`;
}

export type DetectMarker = { phase: 'detect'; packageId: string; programs: string[] };
export type UpdateOutcome = 'updated' | 'up_to_date' | 'blocked' | 'failed';
export type UpdateMarker = {
  phase: 'update';
  packageId: string;
  name: string;
  outcome: UpdateOutcome;
  exitCode: number | null;
  programs: string[];
};

const OUTCOMES = new Set<UpdateOutcome>(['updated', 'up_to_date', 'blocked', 'failed']);

function stringList(value: unknown): string[] {
  // PowerShell serializes a one-element array as a bare string in some versions.
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.slice(0, 200));
}

/** Parse the marker lines out of a script's stdout; unknown or malformed lines are ignored. */
export function parseMarkers(stdout: string | null | undefined): { detect: DetectMarker[]; update: UpdateMarker[] } {
  const detect: DetectMarker[] = [];
  const update: UpdateMarker[] = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const at = line.indexOf(`${MARKER} `);
    if (at === -1) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line.slice(at + MARKER.length + 1)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object' || typeof data.packageId !== 'string') continue;
    if (data.phase === 'detect') {
      detect.push({ phase: 'detect', packageId: data.packageId, programs: stringList(data.programs) });
    } else if (data.phase === 'update' && OUTCOMES.has(data.outcome as UpdateOutcome)) {
      update.push({
        phase: 'update',
        packageId: data.packageId,
        name: typeof data.name === 'string' ? data.name : data.packageId,
        outcome: data.outcome as UpdateOutcome,
        exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
        programs: stringList(data.programs),
      });
    }
  }
  return { detect, update };
}

/** The message shown to the person signed in to the device. */
export function buildUserNotification(
  names: string[],
  blockers: Array<{ name: string; programs: string[] }>,
  mode: UpdateMode
): { title: string; body: string } {
  const list = (items: string[]) => items.join(', ');
  const programs = [...new Set(blockers.flatMap((b) => b.programs))];
  const blocked = blockers.map((b) => b.name);
  let body = `Your IT team is updating ${list(names)}.`;
  if (programs.length > 0) {
    body += mode === 'force'
      ? ` These programs will be closed so the update can finish: ${list(programs)}. Save your work now.`
      : ` Please save your work and close ${list(programs)} so ${list(blocked)} can update. The update continues on its own once they are closed.`;
  }
  return { title: 'Software updates', body: body.slice(0, 2000) };
}
