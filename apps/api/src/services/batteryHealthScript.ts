// fork: battery health collected by a scheduled system script instead of an
// agent change, so devices keep the official signed agent. The script writes
// three device custom fields through Breeze's script write-back marker; the
// device Overview's Power section reads them. Fields and the daily automation
// are provisioned per partner by batteryHealthProvisioning.ts.
import type { SystemLibraryScriptDefinition } from './systemScriptLibrary';
import { DRIVER_SCRIPTS } from './driverScripts';

export const BATTERY_HEALTH_SCRIPT_NAME = 'Battery Health (Windows)';

/** Custom field keys the script writes; the web Power section reads the same keys. */
export const BATTERY_FIELD_KEYS = {
  design: 'battery_design_capacity_mwh',
  full: 'battery_full_charge_capacity_mwh',
  cycles: 'battery_cycle_count',
} as const;

const CONTENT = `# Battery health (Windows) - Breeze fork.
#
# Saves design capacity and full-charge capacity (mWh) and cycle count on this
# device as custom fields. Two sources, in order:
#   1. the ACPI battery classes in root\\wmi (cheap, but many consumer laptops
#      leave BatteryStaticData empty);
#   2. Windows' own battery report (powercfg /batteryreport /xml), which reads
#      the battery driver directly - the same numbers "battery report" shows.
# Devices without a battery (desktops, servers, most VMs) exit 0 and write
# nothing. Read-only apart from a temporary report file it deletes.
$ErrorActionPreference = 'SilentlyContinue'
$design = 0; $full = 0; $cycles = 0; $source = $null

$static = Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData | Select-Object -First 1
$charged = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1
if ($static -and $charged -and [int64]$static.DesignedCapacity -gt 0 -and [int64]$charged.FullChargedCapacity -gt 0) {
  $design = [int64]$static.DesignedCapacity; $full = [int64]$charged.FullChargedCapacity; $source = 'WMI'
  $c = Get-CimInstance -Namespace root/wmi -ClassName BatteryCycleCount | Select-Object -First 1
  if ($c) { $cycles = [int64]$c.CycleCount }
} else {
  $report = Join-Path $env:TEMP ('breeze-battery-' + [guid]::NewGuid().ToString('N') + '.xml')
  & powercfg.exe /batteryreport /xml /output $report | Out-Null
  if (Test-Path -LiteralPath $report) {
    try {
      [xml]$xml = Get-Content -LiteralPath $report -Raw
      $bat = @($xml.BatteryReport.Batteries.Battery) | Where-Object { $_ } | Select-Object -First 1
      if ($bat) {
        if ([string]$bat.RelativeCapacity -eq '1') {
          Write-Output 'This battery reports capacity only in relative units, not mWh; nothing saved.'
          exit 0
        }
        $design = [int64]$bat.DesignCapacity; $full = [int64]$bat.FullChargeCapacity; $cycles = [int64]$bat.CycleCount
        $source = 'battery report'
      }
    } finally {
      Remove-Item -LiteralPath $report -Force
    }
  }
}

if (-not $source) {
  Write-Output 'No battery on this device (or Windows reports no battery details).'
  exit 0
}
$fields = [ordered]@{}
if ($design -gt 0) { $fields['${BATTERY_FIELD_KEYS.design}'] = $design }
if ($full -gt 0) { $fields['${BATTERY_FIELD_KEYS.full}'] = $full }
if ($cycles -gt 0) { $fields['${BATTERY_FIELD_KEYS.cycles}'] = $cycles }
if ($fields.Count -eq 0) {
  Write-Output 'The battery reported zero capacity; nothing saved.'
  exit 0
}
Write-Output ('Source: {0}. Design capacity: {1} mWh, full charge capacity: {2} mWh, cycles: {3}' -f $source, $design, $full, $cycles)
Write-Output ('::breeze:custom-fields:: ' + ($fields | ConvertTo-Json -Compress))
`;

export const BATTERY_HEALTH_SCRIPT: SystemLibraryScriptDefinition = {
  name: BATTERY_HEALTH_SCRIPT_NAME,
  description:
    'Reads the laptop battery design capacity, full-charge capacity and cycle count and saves them as device custom fields (shown in the Power section).',
  category: 'Hardware',
  osTypes: ['windows'],
  language: 'powershell',
  content: CONTENT,
  timeoutSeconds: 120,
  runAs: 'system',
};

// Linux: /sys/class/power_supply. energy_* are µWh; charge_* are µAh and are
// converted with voltage_min_design (µV). Peripheral batteries (scope=Device)
// and empty bays are skipped. No battery -> exit 0, nothing written.
const LINUX_CONTENT = `#!/bin/sh
# Battery health (Linux) - Breeze fork. Read-only.
for d in /sys/class/power_supply/*; do
  [ "$(cat "$d/type" 2>/dev/null)" = "Battery" ] || continue
  [ "$(cat "$d/scope" 2>/dev/null)" = "Device" ] && continue
  [ "$(cat "$d/present" 2>/dev/null || echo 1)" = "1" ] || continue
  if [ -r "$d/energy_full_design" ] && [ -r "$d/energy_full" ]; then
    design=$(( $(cat "$d/energy_full_design") / 1000 ))
    full=$(( $(cat "$d/energy_full") / 1000 ))
  elif [ -r "$d/charge_full_design" ] && [ -r "$d/charge_full" ] && [ -r "$d/voltage_min_design" ]; then
    v=$(cat "$d/voltage_min_design")
    design=$(( $(cat "$d/charge_full_design") / 1000 * (v / 1000) / 1000 ))
    full=$(( $(cat "$d/charge_full") / 1000 * (v / 1000) / 1000 ))
  else
    continue
  fi
  cycles=$(cat "$d/cycle_count" 2>/dev/null || echo 0)
  json="\\"${BATTERY_FIELD_KEYS.design}\\":$design,\\"${BATTERY_FIELD_KEYS.full}\\":$full"
  [ "$cycles" -gt 0 ] 2>/dev/null && json="$json,\\"${BATTERY_FIELD_KEYS.cycles}\\":$cycles"
  if [ "$design" -gt 0 ] && [ "$full" -gt 0 ]; then
    echo "Design capacity: $design mWh, full charge capacity: $full mWh"
    echo "::breeze:custom-fields:: {$json}"
  fi
  exit 0
done
echo "No battery on this device."
exit 0
`;

// macOS: ioreg AppleSmartBattery. Capacities are mAh; both are converted with
// the same voltage, so the health ratio is exact and the mWh values are close.
// Apple Silicon reports the real full-charge mAh as AppleRawMaxCapacity
// (MaxCapacity there is a percentage); Intel reports it as MaxCapacity.
const MACOS_CONTENT = `#!/bin/sh
# Battery health (macOS) - Breeze fork. Read-only.
info=$(ioreg -rn AppleSmartBattery 2>/dev/null)
if [ -z "$info" ]; then echo "No battery on this device."; exit 0; fi
val() { printf '%s\\n' "$info" | sed -n "s/^[[:space:]]*\\"$1\\" = \\([0-9][0-9]*\\)$/\\1/p" | head -n 1; }
design=$(val DesignCapacity); full=$(val AppleRawMaxCapacity); [ -n "$full" ] || full=$(val MaxCapacity)
cycles=$(val CycleCount); mv=$(val Voltage); [ -n "$mv" ] || mv=11400
if [ -z "$design" ] || [ -z "$full" ] || [ "$design" -le 0 ] || [ "$full" -le 0 ] || [ "$full" -le 100 ]; then
  echo "This Mac does not report battery capacity."; exit 0
fi
design=$(( design * mv / 1000 )); full=$(( full * mv / 1000 ))
json="\\"${BATTERY_FIELD_KEYS.design}\\":$design,\\"${BATTERY_FIELD_KEYS.full}\\":$full"
[ -n "$cycles" ] && [ "$cycles" -gt 0 ] && json="$json,\\"${BATTERY_FIELD_KEYS.cycles}\\":$cycles"
echo "Design capacity: ~$design mWh, full charge capacity: ~$full mWh"
echo "::breeze:custom-fields:: {$json}"
`;

export const BATTERY_HEALTH_SCRIPT_LINUX: SystemLibraryScriptDefinition = {
  ...BATTERY_HEALTH_SCRIPT,
  name: 'Battery Health (Linux)',
  osTypes: ['linux'],
  language: 'bash',
  content: LINUX_CONTENT,
};

export const BATTERY_HEALTH_SCRIPT_MACOS: SystemLibraryScriptDefinition = {
  ...BATTERY_HEALTH_SCRIPT,
  name: 'Battery Health (macOS)',
  osTypes: ['macos'],
  language: 'bash',
  content: MACOS_CONTENT,
};

/** One script per OS; batteryHealthProvisioning.ts schedules each on its own OS only. */
export const BATTERY_HEALTH_SCRIPTS_BY_OS = [
  { osType: 'windows', script: BATTERY_HEALTH_SCRIPT },
  { osType: 'macos', script: BATTERY_HEALTH_SCRIPT_MACOS },
  { osType: 'linux', script: BATTERY_HEALTH_SCRIPT_LINUX },
] as const;

/** Spread into SYSTEM_LIBRARY_SCRIPTS (services/systemScriptLibrary.ts). */
export const FORK_SYSTEM_LIBRARY_SCRIPTS: SystemLibraryScriptDefinition[] = [
  ...BATTERY_HEALTH_SCRIPTS_BY_OS.map((s) => s.script),
  ...DRIVER_SCRIPTS,
];
