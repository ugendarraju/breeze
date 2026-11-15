// fork: device Drivers tab. Two system library scripts (no agent change, so
// devices keep the official signed agent):
//   - Driver Scan: lists installed PnP drivers, asks Windows Update for newer
//     Microsoft-catalog drivers matched to this PC's hardware IDs, and, when the
//     maker's own tool is installed (Dell Command Update, HP Image Assistant,
//     Lenovo Thin Installer / System Update), what that tool would install.
//   - Driver Install: installs chosen Windows Update drivers by update ID and/or
//     runs the maker's tool for drivers only. Never restarts the device.
// Both print one JSON document between marker lines; routes/devices/drivers.ts
// reads the latest run back from script_executions.stdout.
import type { SystemLibraryScriptDefinition } from './systemScriptLibrary';

export const DRIVER_SCAN_SCRIPT_NAME = 'Driver Scan (Windows)';
export const DRIVER_INSTALL_SCRIPT_NAME = 'Driver Install (Windows)';

export const DRIVER_SCAN_BEGIN = '::breeze:driver-scan-begin::';
export const DRIVER_SCAN_END = '::breeze:driver-scan-end::';
export const DRIVER_INSTALL_BEGIN = '::breeze:driver-install-begin::';
export const DRIVER_INSTALL_END = '::breeze:driver-install-end::';

export const OEM_VENDORS = ['dell', 'hp', 'lenovo'] as const;
export type OemVendor = (typeof OEM_VENDORS)[number];

// PowerShell kept in String.raw so backslashes survive; it must contain no
// backtick and no dollar-brace sequence (a guard test checks both).
const SHARED_PS = String.raw`
function Get-WuDriverSearch {
  # Ask Windows Update directly first (ServerSelection 2): a WSUS server usually
  # carries no drivers. Fall back to the machine's default source when policy
  # blocks direct access.
  param($Session)
  $criteria = "IsInstalled=0 and Type='Driver' and IsHidden=0"
  $searcher = $Session.CreateUpdateSearcher()
  try {
    $searcher.ServerSelection = 2
    return @{ result = $searcher.Search($criteria); source = 'Windows Update' }
  } catch {
    $searcher = $Session.CreateUpdateSearcher()
    return @{ result = $searcher.Search($criteria); source = 'default (WSUS/policy)' }
  }
}

function Find-OemTool {
  $pf = $env:ProgramFiles
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $candidates = @(
    @{ vendor = 'dell'; tool = 'Dell Command Update'; path = (Join-Path $pf 'Dell\CommandUpdate\dcu-cli.exe') },
    @{ vendor = 'dell'; tool = 'Dell Command Update'; path = (Join-Path $pf86 'Dell\CommandUpdate\dcu-cli.exe') },
    @{ vendor = 'hp'; tool = 'HP Image Assistant'; path = (Join-Path $pf 'HP\HPIA\HPImageAssistant.exe') },
    @{ vendor = 'hp'; tool = 'HP Image Assistant'; path = (Join-Path $pf86 'HP\HPIA\HPImageAssistant.exe') },
    @{ vendor = 'hp'; tool = 'HP Image Assistant'; path = 'C:\SWSetup\HPImageAssistant\HPImageAssistant.exe' },
    @{ vendor = 'hp'; tool = 'HP Image Assistant'; path = 'C:\HPIA\HPImageAssistant.exe' },
    @{ vendor = 'lenovo'; tool = 'Lenovo Thin Installer'; path = (Join-Path $pf86 'Lenovo\ThinInstaller\ThinInstaller.exe') },
    @{ vendor = 'lenovo'; tool = 'Lenovo System Update'; path = (Join-Path $pf86 'Lenovo\System Update\tvsu.exe') }
  )
  # HP Image Assistant is a self-extracting SoftPaq; find it wherever it unpacked.
  foreach ($root in @('C:\SWSetup', (Join-Path $pf 'HP'), (Join-Path $pf86 'HP'))) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      $hit = Get-ChildItem -LiteralPath $root -Filter 'HPImageAssistant.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { $candidates += @{ vendor = 'hp'; tool = 'HP Image Assistant'; path = $hit.FullName } }
    }
  }
  foreach ($c in $candidates) {
    if ($c.path -and (Test-Path -LiteralPath $c.path)) {
      $sig = Get-AuthenticodeSignature -LiteralPath $c.path
      if ($sig.Status -ne 'Valid') { continue }
      $c.signer = [string]$sig.SignerCertificate.Subject
      return $c
    }
  }
  return $null
}

function New-WorkDir {
  $d = Join-Path $env:ProgramData ('Breeze\drivers\' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  return $d
}

function Format-Date($v) {
  if (-not $v) { return $null }
  try { return ([datetime]$v).ToString('yyyy-MM-dd') } catch { return [string]$v }
}

function Limit-Text($v, $n) {
  if ($null -eq $v) { return $null }
  $s = [string]$v
  if ($s.Length -gt $n) { return $s.Substring(0, $n) }
  return $s
}
`;

const SCAN_CONTENT = String.raw`# Driver scan (Windows) - Breeze fork. Read-only apart from a temporary
# report folder under ProgramData\Breeze\drivers that it deletes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
` + SHARED_PS + String.raw`
$out = [ordered]@{
  version = 1
  scannedAt = (Get-Date).ToUniversalTime().ToString('o')
  manufacturer = $null
  model = $null
  drivers = @()
  windowsUpdate = [ordered]@{ ok = $false; source = $null; error = $null; updates = @() }
  oem = $null
}

try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem
  $out.manufacturer = Limit-Text $cs.Manufacturer 100
  $out.model = Limit-Text $cs.Model 100
} catch {}

# Maker apps that have no command line Breeze can drive (shown as a hint only).
$makerApps = @()
$appsDir = Join-Path $env:ProgramFiles 'WindowsApps'
foreach ($a in @(@{ name = 'MyASUS'; pattern = 'B9ECED6F.ASUSPCAssistant_*' }, @{ name = 'Armoury Crate'; pattern = 'B9ECED6F.ArmouryCrate_*' })) {
  try {
    if (Get-ChildItem -LiteralPath $appsDir -Filter $a.pattern -Directory -ErrorAction Stop | Select-Object -First 1) { $makerApps += $a.name }
  } catch {}
}
$out.makerApps = @($makerApps)

# 1. Installed drivers, plus every hardware/compatible ID per device for matching.
$idsByDevice = @{}
try {
  foreach ($e in (Get-CimInstance -ClassName Win32_PnPEntity)) {
    if (-not $e.PNPDeviceID) { continue }
    $ids = @()
    if ($e.HardwareID) { $ids += $e.HardwareID }
    if ($e.CompatibleID) { $ids += $e.CompatibleID }
    $idsByDevice[$e.PNPDeviceID.ToUpperInvariant()] = @($ids | ForEach-Object { $_.ToUpperInvariant() })
  }
} catch {}

$drivers = New-Object System.Collections.ArrayList
try {
  foreach ($d in (Get-CimInstance -ClassName Win32_PnPSignedDriver)) {
    if (-not $d.DeviceName -or -not $d.DriverVersion -or -not $d.DeviceID) { continue }
    [void]$drivers.Add([ordered]@{
      deviceName = Limit-Text $d.DeviceName 200
      deviceClass = Limit-Text $d.DeviceClass 60
      deviceId = Limit-Text $d.DeviceID 300
      hardwareId = Limit-Text $d.HardWareID 300
      version = Limit-Text $d.DriverVersion 60
      date = Format-Date $d.DriverDate
      provider = Limit-Text $d.DriverProviderName 120
      manufacturer = Limit-Text $d.Manufacturer 120
      inf = Limit-Text $d.InfName 60
      signer = Limit-Text $d.Signer 120
    })
  }
} catch {
  Write-Output ('Could not list installed drivers: ' + $_.Exception.Message)
}
$out.drivers = @($drivers)

# 2. Windows Update driver catalog.
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'Breeze driver scan'
  $search = Get-WuDriverSearch $session
  $out.windowsUpdate.source = $search.source
  $updates = New-Object System.Collections.ArrayList
  foreach ($u in $search.result.Updates) {
    $hwid = [string]$u.DriverHardwareID
    $matched = @()
    if ($hwid) {
      $needle = $hwid.ToUpperInvariant()
      foreach ($k in $idsByDevice.Keys) {
        if ($idsByDevice[$k] -contains $needle) { $matched += $k }
      }
    }
    $reboot = $false
    try { $reboot = ([int]$u.InstallationBehavior.RebootBehavior) -ne 0 } catch {}
    [void]$updates.Add([ordered]@{
      updateId = [string]$u.Identity.UpdateID
      title = Limit-Text $u.Title 300
      driverModel = Limit-Text $u.DriverModel 200
      driverClass = Limit-Text $u.DriverClass 60
      provider = Limit-Text $u.DriverProvider 120
      manufacturer = Limit-Text $u.DriverManufacturer 120
      hardwareId = Limit-Text $hwid 300
      date = Format-Date $u.DriverVerDate
      sizeBytes = [int64]$u.MaxDownloadSize
      mayRequireReboot = $reboot
      deviceIds = @($matched | Select-Object -First 10)
    })
  }
  $out.windowsUpdate.updates = @($updates)
  $out.windowsUpdate.ok = $true
} catch {
  $out.windowsUpdate.error = Limit-Text $_.Exception.Message 500
}

# 3. The maker's own tool, if installed and validly signed.
$tool = Find-OemTool
if ($tool) {
  $oem = [ordered]@{ vendor = $tool.vendor; tool = $tool.tool; ok = $false; listSupported = $true; error = $null; updates = @() }
  $work = New-WorkDir
  try {
    $list = New-Object System.Collections.ArrayList
    if ($tool.vendor -eq 'dell') {
      $p = Start-Process -FilePath $tool.path -ArgumentList @('/scan', '-updateType=driver', ('-report=' + $work), '-silent') -Wait -PassThru -WindowStyle Hidden
      # 0 = scan done, 500 = no updates found.
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 500) { throw ('dcu-cli exited with ' + $p.ExitCode) }
      $xmlFile = Get-ChildItem -LiteralPath $work -Filter '*.xml' -Recurse | Select-Object -First 1
      if ($xmlFile) {
        [xml]$x = Get-Content -LiteralPath $xmlFile.FullName -Raw
        foreach ($n in $x.SelectNodes('//update')) {
          [void]$list.Add([ordered]@{
            id = Limit-Text $n.release 40
            name = Limit-Text $n.name 300
            version = Limit-Text $n.version 60
            date = Limit-Text $n.date 30
            category = Limit-Text $n.category 60
            urgency = Limit-Text $n.urgency 30
          })
        }
      }
    } elseif ($tool.vendor -eq 'hp') {
      $p = Start-Process -FilePath $tool.path -ArgumentList @('/Operation:Analyze', '/Category:Drivers', '/Selection:All', '/Action:List', '/Silent', '/Noninteractive', ('/ReportFolder:' + $work)) -Wait -PassThru -WindowStyle Hidden
      # 0 = done, 256 = no recommendations.
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 256) { throw ('HP Image Assistant exited with ' + $p.ExitCode) }
      $jsonFile = Get-ChildItem -LiteralPath $work -Filter '*.json' -Recurse | Select-Object -First 1
      if ($jsonFile) {
        $j = Get-Content -LiteralPath $jsonFile.FullName -Raw | ConvertFrom-Json
        $recs = @()
        if ($j.HPIA -and $j.HPIA.Recommendations) { $recs = @($j.HPIA.Recommendations) }
        foreach ($r in $recs) {
          $sp = $r.Recommendation
          [void]$list.Add([ordered]@{
            id = Limit-Text $(if ($r.SoftPaqId) { $r.SoftPaqId } elseif ($sp) { $sp.SoftPaqId } else { $null }) 40
            name = Limit-Text $(if ($r.Name) { $r.Name } else { $r.TargetComponent }) 300
            version = Limit-Text $(if ($r.ReferenceVersion) { $r.ReferenceVersion } elseif ($sp) { $sp.Version } else { $null }) 60
            installedVersion = Limit-Text $r.TargetVersion 60
            category = Limit-Text $r.TargetComponent 60
            urgency = Limit-Text $r.RecommendationValue 30
          })
        }
      }
    } else {
      # Lenovo's tools cannot list updates to a file; install runs them for drivers only.
      $oem.listSupported = $false
    }
    $oem.updates = @($list)
    $oem.ok = $true
  } catch {
    $oem.error = Limit-Text $_.Exception.Message 500
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
  $out.oem = $oem
}

$wuCount = @($out.windowsUpdate.updates).Count
Write-Output ('Installed drivers: {0}. Windows Update driver updates: {1}.' -f @($out.drivers).Count, $wuCount)
if ($out.windowsUpdate.error) { Write-Output ('Windows Update search failed: ' + $out.windowsUpdate.error) }
if ($out.oem) { Write-Output ('{0}: {1} update(s).' -f $out.oem.tool, @($out.oem.updates).Count) }
Write-Output '` + DRIVER_SCAN_BEGIN + String.raw`'
Write-Output ($out | ConvertTo-Json -Depth 6 -Compress)
Write-Output '` + DRIVER_SCAN_END + String.raw`'
exit 0
`;

const INSTALL_CONTENT = String.raw`# Driver install (Windows) - Breeze fork.
# Parameters (environment, set by the Breeze agent):
#   BREEZE_PARAM_UPDATE_IDS  comma-separated Windows Update update IDs to install
#   BREEZE_PARAM_OEM_VENDOR  dell | hp | lenovo: run that maker's tool, drivers only
# Never restarts the device. Tries to create a System Restore point first (only
# when System Restore is already on). Rollback: Device Manager > device >
# Driver > Roll Back Driver, or the restore point.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
` + SHARED_PS + String.raw`
$ids = @()
if ($env:BREEZE_PARAM_UPDATE_IDS) {
  $ids = @($env:BREEZE_PARAM_UPDATE_IDS -split '[,;\s]+' | Where-Object { $_ -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } | ForEach-Object { $_.ToLowerInvariant() })
}
$vendor = ([string]$env:BREEZE_PARAM_OEM_VENDOR).Trim().ToLowerInvariant()
if ($vendor -and @('dell', 'hp', 'lenovo') -notcontains $vendor) { $vendor = '' }

$out = [ordered]@{
  version = 1
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  restorePoint = $false
  rebootRequired = $false
  windowsUpdate = @()
  oem = $null
  before = @()
}

if ($ids.Count -eq 0 -and -not $vendor) {
  Write-Output 'Nothing to install: no update IDs and no vendor given.'
  exit 1
}

try {
  Checkpoint-Computer -Description 'Breeze driver install' -RestorePointType 'MODIFY_SETTINGS'
  $out.restorePoint = $true
} catch {
  Write-Output ('No restore point created (System Restore off or one was made in the last 24 hours): ' + $_.Exception.Message)
}

$failed = $false

if ($ids.Count -gt 0) {
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $session.ClientApplicationID = 'Breeze driver install'
    $search = Get-WuDriverSearch $session
    $coll = New-Object -ComObject Microsoft.Update.UpdateColl
    $found = @{}
    foreach ($u in $search.result.Updates) {
      $uid = ([string]$u.Identity.UpdateID).ToLowerInvariant()
      if ($ids -contains $uid) {
        if (-not $u.EulaAccepted) { $u.AcceptEula() }
        [void]$coll.Add($u)
        $found[$uid] = $u
      }
    }
    # Record what is installed now, for the rollback note.
    $hwids = @($found.Values | ForEach-Object { ([string]$_.DriverHardwareID).ToUpperInvariant() } | Where-Object { $_ })
    if ($hwids.Count -gt 0) {
      $before = New-Object System.Collections.ArrayList
      foreach ($d in (Get-CimInstance -ClassName Win32_PnPSignedDriver)) {
        if ($d.HardWareID -and ($hwids -contains ([string]$d.HardWareID).ToUpperInvariant())) {
          [void]$before.Add([ordered]@{ deviceName = Limit-Text $d.DeviceName 200; version = Limit-Text $d.DriverVersion 60; date = Format-Date $d.DriverDate; inf = Limit-Text $d.InfName 60 })
        }
      }
      $out.before = @($before)
    }
    foreach ($id in $ids) {
      if (-not $found.ContainsKey($id)) {
        $out.windowsUpdate += [ordered]@{ updateId = $id; title = $null; result = 'not_offered'; hresult = $null }
        $failed = $true
      }
    }
    if ($coll.Count -gt 0) {
      $dl = $session.CreateUpdateDownloader()
      $dl.Updates = $coll
      [void]$dl.Download()
      $inst = $session.CreateUpdateInstaller()
      $inst.Updates = $coll
      $res = $inst.Install()
      if ($res.RebootRequired) { $out.rebootRequired = $true }
      $codes = @{ 0 = 'not_started'; 1 = 'in_progress'; 2 = 'succeeded'; 3 = 'succeeded_with_errors'; 4 = 'failed'; 5 = 'aborted' }
      for ($i = 0; $i -lt $coll.Count; $i++) {
        $r = $res.GetUpdateResult($i)
        $code = [int]$r.ResultCode
        if ($code -ne 2) { $failed = $true }
        $out.windowsUpdate += [ordered]@{
          updateId = ([string]$coll.Item($i).Identity.UpdateID).ToLowerInvariant()
          title = Limit-Text $coll.Item($i).Title 300
          result = $codes[$code]
          hresult = ('0x{0:X8}' -f [int]$r.HResult)
        }
      }
    }
  } catch {
    $failed = $true
    $out.windowsUpdate += [ordered]@{ updateId = $null; title = $null; result = 'error'; hresult = Limit-Text $_.Exception.Message 500 }
  }
}

if ($vendor) {
  $tool = Find-OemTool
  $oem = [ordered]@{ vendor = $vendor; tool = $null; exitCode = $null; result = $null }
  if (-not $tool -or $tool.vendor -ne $vendor) {
    $oem.result = 'tool_not_found'
    $failed = $true
  } else {
    $oem.tool = $tool.tool
    $work = New-WorkDir
    try {
      if ($vendor -eq 'dell') {
        $p = Start-Process -FilePath $tool.path -ArgumentList @('/applyUpdates', '-updateType=driver', '-reboot=disable', '-silent', ('-outputLog=' + (Join-Path $work 'dcu.log'))) -Wait -PassThru -WindowStyle Hidden
        $oem.exitCode = $p.ExitCode
        # 0 ok, 1/5 ok + restart needed, 500 nothing to install.
        switch ($p.ExitCode) {
          0 { $oem.result = 'succeeded' }
          1 { $oem.result = 'succeeded'; $out.rebootRequired = $true }
          5 { $oem.result = 'succeeded'; $out.rebootRequired = $true }
          500 { $oem.result = 'nothing_to_install' }
          default { $oem.result = 'failed'; $failed = $true }
        }
      } elseif ($vendor -eq 'hp') {
        $p = Start-Process -FilePath $tool.path -ArgumentList @('/Operation:Analyze', '/Category:Drivers', '/Selection:All', '/Action:Install', '/Silent', '/Noninteractive', ('/ReportFolder:' + (Join-Path $work 'report')), ('/SoftpaqDownloadFolder:' + (Join-Path $work 'softpaqs'))) -Wait -PassThru -WindowStyle Hidden
        $oem.exitCode = $p.ExitCode
        # 0 ok, 256 nothing to install, 3010 ok + restart needed.
        switch ($p.ExitCode) {
          0 { $oem.result = 'succeeded' }
          256 { $oem.result = 'nothing_to_install' }
          3010 { $oem.result = 'succeeded'; $out.rebootRequired = $true }
          default { $oem.result = 'failed'; $failed = $true }
        }
      } else {
        # Lenovo: package type 2 = drivers. -noreboot keeps restarts with the technician.
        $p = Start-Process -FilePath $tool.path -ArgumentList @('/CM', '-search', 'A', '-action', 'INSTALL', '-packagetypes', '2', '-includerebootpackages', '1,3,4', '-noicon', '-noreboot', '-nolicense') -Wait -PassThru -WindowStyle Hidden
        $oem.exitCode = $p.ExitCode
        if ($p.ExitCode -eq 0) { $oem.result = 'succeeded' } else { $oem.result = 'failed'; $failed = $true }
      }
    } catch {
      $oem.result = 'error'
      $oem.exitCode = Limit-Text $_.Exception.Message 300
      $failed = $true
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $out.oem = $oem
}

foreach ($r in $out.windowsUpdate) { Write-Output ('{0}: {1}' -f $(if ($r.title) { $r.title } else { $r.updateId }), $r.result) }
if ($out.oem) { Write-Output ('{0}: {1}' -f $out.oem.vendor, $out.oem.result) }
if ($out.rebootRequired) { Write-Output 'A restart is needed to finish. Breeze will not restart the device by itself.' }
Write-Output '` + DRIVER_INSTALL_BEGIN + String.raw`'
Write-Output ($out | ConvertTo-Json -Depth 6 -Compress)
Write-Output '` + DRIVER_INSTALL_END + String.raw`'
if ($failed) { exit 1 }
exit 0
`;

/** The maker-published winget package for each vendor's update tool. */
export const OEM_TOOL_WINGET_IDS: Record<OemVendor, { id: string; tool: string }> = {
  dell: { id: 'Dell.CommandUpdate.Universal', tool: 'Dell Command Update' },
  hp: { id: 'HP.ImageAssistant', tool: 'HP Image Assistant' },
  lenovo: { id: 'Lenovo.SystemUpdate', tool: 'Lenovo System Update' },
};

/** Which vendor lane a Win32_ComputerSystem.Manufacturer string belongs to. */
export function oemVendorFromManufacturer(manufacturer: string | null | undefined): OemVendor | null {
  const m = (manufacturer ?? '').trim().toLowerCase();
  if (!m) return null;
  if (m.startsWith('dell')) return 'dell';
  if (m === 'hp' || m.startsWith('hp ') || m.startsWith('hewlett')) return 'hp';
  if (m.startsWith('lenovo')) return 'lenovo';
  return null;
}

const TOOL_INSTALL_CONTENT = String.raw`# Driver tool install (Windows) - Breeze fork.
# Installs the hardware maker's own driver update tool from the winget catalog
# (the package the maker publishes there), then checks its signature.
#   BREEZE_PARAM_OEM_VENDOR  dell | hp | lenovo
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
` + SHARED_PS + String.raw`
$vendor = ([string]$env:BREEZE_PARAM_OEM_VENDOR).Trim().ToLowerInvariant()
$ids = @{ dell = '` + OEM_TOOL_WINGET_IDS.dell.id + String.raw`'; hp = '` + OEM_TOOL_WINGET_IDS.hp.id + String.raw`'; lenovo = '` + OEM_TOOL_WINGET_IDS.lenovo.id + String.raw`' }
if (-not $ids.ContainsKey($vendor)) { Write-Output 'oem_vendor must be dell, hp or lenovo.'; exit 1 }

$existing = Find-OemTool
if ($existing -and $existing.vendor -eq $vendor) {
  Write-Output ($existing.tool + ' is already installed: ' + $existing.path)
  exit 0
}

# winget lives in the per-user App Installer package; as SYSTEM, call it by path.
$winget = $null
$apps = Join-Path $env:ProgramFiles 'WindowsApps'
if (Test-Path -LiteralPath $apps) {
  $winget = Get-ChildItem -LiteralPath $apps -Filter 'Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'winget.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}
if (-not $winget) { Write-Output 'winget (App Installer) is not available on this device.'; exit 1 }

Write-Output ('Installing ' + $ids[$vendor] + ' with winget...')
& $winget install --id $ids[$vendor] --exact --source winget --silent --scope machine --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Select-Object -Last 15 | ForEach-Object { Write-Output ([string]$_) }
$code = $LASTEXITCODE
$tool = Find-OemTool
if ($tool -and $tool.vendor -eq $vendor) {
  Write-Output ($tool.tool + ' installed and signed by ' + $tool.signer + ': ' + $tool.path)
  exit 0
}
Write-Output ('The tool was not found after install (winget exit code ' + $code + ').')
exit 1
`;

export const DRIVER_SCAN_SCRIPT: SystemLibraryScriptDefinition = {
  name: DRIVER_SCAN_SCRIPT_NAME,
  description:
    'Lists installed device drivers (device, hardware ID, version, date, provider), asks Windows Update for newer ' +
    'drivers matched to this PC\'s hardware IDs, and, when Dell Command Update, HP Image Assistant or Lenovo ' +
    'Thin Installer / System Update is installed, what that tool would install. Read-only. Used by the device Drivers tab.',
  category: 'Hardware',
  osTypes: ['windows'],
  language: 'powershell',
  content: SCAN_CONTENT,
  timeoutSeconds: 900,
  runAs: 'system',
};

export const DRIVER_INSTALL_SCRIPT: SystemLibraryScriptDefinition = {
  name: DRIVER_INSTALL_SCRIPT_NAME,
  description:
    'Installs the given Windows Update driver updates (update_ids, comma-separated) and/or runs the maker\'s ' +
    'update tool for drivers only (oem_vendor: dell, hp or lenovo). Tries to create a restore point first and ' +
    'never restarts the device. Used by the device Drivers tab.',
  category: 'Hardware',
  osTypes: ['windows'],
  language: 'powershell',
  content: INSTALL_CONTENT,
  parameters: [
    { name: 'update_ids', type: 'string', required: false, source: 'runtime' },
    { name: 'oem_vendor', type: 'string', required: false, source: 'runtime' },
  ],
  timeoutSeconds: 3600,
  runAs: 'system',
};

export const DRIVER_TOOL_INSTALL_SCRIPT_NAME = 'Driver Tool Install (Windows)';

export const DRIVER_TOOL_INSTALL_SCRIPT: SystemLibraryScriptDefinition = {
  name: DRIVER_TOOL_INSTALL_SCRIPT_NAME,
  description:
    'Installs the hardware maker\'s driver update tool from the winget catalog: Dell Command Update, HP Image ' +
    'Assistant or Lenovo System Update (oem_vendor: dell, hp or lenovo), then checks its signature. Used by the ' +
    'device Drivers tab.',
  category: 'Hardware',
  osTypes: ['windows'],
  language: 'powershell',
  content: TOOL_INSTALL_CONTENT,
  parameters: [{ name: 'oem_vendor', type: 'string', required: true, source: 'runtime' }],
  timeoutSeconds: 1200,
  runAs: 'system',
};

export const DRIVER_SCRIPTS: SystemLibraryScriptDefinition[] = [
  DRIVER_SCAN_SCRIPT,
  DRIVER_INSTALL_SCRIPT,
  DRIVER_TOOL_INSTALL_SCRIPT,
];

/** The JSON document a script printed between its marker lines, or null. */
export function extractMarkedJson(stdout: string | null | undefined, begin: string, end: string): unknown {
  if (!stdout) return null;
  const start = stdout.lastIndexOf(begin);
  if (start < 0) return null;
  const stop = stdout.indexOf(end, start + begin.length);
  if (stop < 0) return null;
  try {
    return JSON.parse(stdout.slice(start + begin.length, stop).trim());
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 300): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export type InstalledDriver = {
  deviceName: string;
  deviceClass: string | null;
  deviceId: string;
  hardwareId: string | null;
  version: string | null;
  date: string | null;
  provider: string | null;
  manufacturer: string | null;
  inf: string | null;
};

export type WindowsUpdateDriver = {
  updateId: string;
  title: string;
  driverModel: string | null;
  driverClass: string | null;
  provider: string | null;
  hardwareId: string | null;
  date: string | null;
  sizeBytes: number | null;
  mayRequireReboot: boolean;
  deviceIds: string[];
};

export type OemUpdate = {
  id: string | null;
  name: string;
  version: string | null;
  installedVersion: string | null;
  date: string | null;
  category: string | null;
  urgency: string | null;
};

export type DriverScanResult = {
  scannedAt: string | null;
  manufacturer: string | null;
  model: string | null;
  /** Maker apps found that Breeze cannot drive (e.g. MyASUS). */
  makerApps: string[];
  drivers: InstalledDriver[];
  windowsUpdate: { ok: boolean; source: string | null; error: string | null; updates: WindowsUpdateDriver[] };
  oem: {
    vendor: OemVendor;
    tool: string | null;
    ok: boolean;
    listSupported: boolean;
    error: string | null;
    updates: OemUpdate[];
  } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the scan document field by field. Script output is device-supplied,
 * so nothing is passed through unchecked and every string is length-capped.
 */
export function parseDriverScanOutput(stdout: string | null | undefined): DriverScanResult | null {
  const raw = extractMarkedJson(stdout, DRIVER_SCAN_BEGIN, DRIVER_SCAN_END);
  if (!raw || typeof raw !== 'object') return null;
  const doc = obj(raw);
  const drivers: InstalledDriver[] = [];
  for (const item of arr(doc.drivers).slice(0, 2000)) {
    const d = obj(item);
    const deviceName = str(d.deviceName, 200);
    const deviceId = str(d.deviceId, 300);
    if (!deviceName || !deviceId) continue;
    drivers.push({
      deviceName,
      deviceClass: str(d.deviceClass, 60),
      deviceId,
      hardwareId: str(d.hardwareId, 300),
      version: str(d.version, 60),
      date: str(d.date, 30),
      provider: str(d.provider, 120),
      manufacturer: str(d.manufacturer, 120),
      inf: str(d.inf, 60),
    });
  }
  const wu = obj(doc.windowsUpdate);
  const updates: WindowsUpdateDriver[] = [];
  for (const item of arr(wu.updates).slice(0, 500)) {
    const u = obj(item);
    const updateId = str(u.updateId, 36);
    if (!updateId || !UUID.test(updateId)) continue;
    updates.push({
      updateId: updateId.toLowerCase(),
      title: str(u.title) ?? updateId,
      driverModel: str(u.driverModel, 200),
      driverClass: str(u.driverClass, 60),
      provider: str(u.provider, 120),
      hardwareId: str(u.hardwareId, 300),
      date: str(u.date, 30),
      sizeBytes: typeof u.sizeBytes === 'number' && Number.isFinite(u.sizeBytes) ? u.sizeBytes : null,
      mayRequireReboot: u.mayRequireReboot === true,
      deviceIds: arr(u.deviceIds).map((x) => str(x, 300)).filter((x): x is string => !!x).slice(0, 10),
    });
  }
  let oem: DriverScanResult['oem'] = null;
  const o = obj(doc.oem);
  if (typeof o.vendor === 'string' && (OEM_VENDORS as readonly string[]).includes(o.vendor)) {
    const oemUpdates: OemUpdate[] = [];
    for (const item of arr(o.updates).slice(0, 500)) {
      const u = obj(item);
      const name = str(u.name);
      if (!name) continue;
      oemUpdates.push({
        id: str(u.id, 40),
        name,
        version: str(u.version, 60),
        installedVersion: str(u.installedVersion, 60),
        date: str(u.date, 30),
        category: str(u.category, 60),
        urgency: str(u.urgency, 30),
      });
    }
    oem = {
      vendor: o.vendor as OemVendor,
      tool: str(o.tool, 60),
      ok: o.ok === true,
      listSupported: o.listSupported !== false,
      error: str(o.error, 500),
      updates: oemUpdates,
    };
  }
  return {
    scannedAt: str(doc.scannedAt, 40),
    manufacturer: str(doc.manufacturer, 100),
    model: str(doc.model, 100),
    makerApps: (typeof doc.makerApps === 'string' ? [doc.makerApps] : arr(doc.makerApps)).map((x) => str(x, 40)).filter((x): x is string => !!x).slice(0, 5),
    drivers,
    windowsUpdate: { ok: wu.ok === true, source: str(wu.source, 60), error: str(wu.error, 500), updates },
    oem,
  };
}

export type DriverInstallResult = {
  restorePoint: boolean;
  rebootRequired: boolean;
  windowsUpdate: { updateId: string | null; title: string | null; result: string; hresult: string | null }[];
  oem: { vendor: string; tool: string | null; result: string | null; exitCode: string | null } | null;
  before: { deviceName: string; version: string | null; date: string | null; inf: string | null }[];
};

export function parseDriverInstallOutput(stdout: string | null | undefined): DriverInstallResult | null {
  const raw = extractMarkedJson(stdout, DRIVER_INSTALL_BEGIN, DRIVER_INSTALL_END);
  if (!raw || typeof raw !== 'object') return null;
  const doc = obj(raw);
  const o = obj(doc.oem);
  return {
    restorePoint: doc.restorePoint === true,
    rebootRequired: doc.rebootRequired === true,
    windowsUpdate: arr(doc.windowsUpdate).slice(0, 100).map((item) => {
      const r = obj(item);
      return { updateId: str(r.updateId, 36), title: str(r.title), result: str(r.result, 40) ?? 'unknown', hresult: str(r.hresult, 300) };
    }),
    oem: typeof o.vendor === 'string'
      ? { vendor: o.vendor.slice(0, 20), tool: str(o.tool, 60), result: str(o.result, 40), exitCode: o.exitCode == null ? null : String(o.exitCode).slice(0, 300) }
      : null,
    before: arr(doc.before).slice(0, 50).map((item) => {
      const b = obj(item);
      return { deviceName: str(b.deviceName, 200) ?? '', version: str(b.version, 60), date: str(b.date, 30), inf: str(b.inf, 60) };
    }).filter((b) => b.deviceName),
  };
}
