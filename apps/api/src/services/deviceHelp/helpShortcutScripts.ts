// fork: system library scripts that put a "Get help" shortcut on a managed
// computer's desktop, pointing at that device's help link (helpLinkToken.ts).
// The technician runs them from the device's Tickets tab ("Install shortcut"),
// which passes the device's own link as the `help_url` parameter; the agent
// exports it as BREEZE_PARAM_HELP_URL. No agent change.
//
// The URL is checked against a strict pattern (https, host, optional port and
// path, then /help#<48-char token>) before anything is written, so it can be
// dropped into a .url / .webloc / .desktop file without escaping, and a
// CR/LF can never inject extra keys.
import type { SystemLibraryScriptDefinition } from '../systemScriptLibrary';

/** Mirror of the check every script below performs. */
export const HELP_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\/help#[A-Za-z0-9_-]{48}$/;
const SHELL_HELP_URL_ERE = '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*/help#[A-Za-z0-9_-]{48}$';

export const HELP_SHORTCUT_SCRIPT_NAMES = {
  windows: 'Get Help Desktop Shortcut (Windows)',
  macos: 'Get Help Desktop Shortcut (macOS)',
  linux: 'Get Help Desktop Shortcut (Linux)',
} as const;

const WINDOWS_CONTENT = `# Get help desktop shortcut (Windows) - Breeze fork.
#
# Puts "Get help" on the desktop of every user of this computer (the shared
# Public desktop), opening this device's help page in the default browser.
# Parameters: help_url (this device's link), action = install | remove.
$ErrorActionPreference = 'Stop'
$Url = [string]$env:BREEZE_PARAM_HELP_URL
$Action = ([string]$env:BREEZE_PARAM_ACTION).Trim().ToLowerInvariant()
if (-not $Action) { $Action = 'install' }

$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
if (-not $desktop) { $desktop = Join-Path $env:PUBLIC 'Desktop' }
$path = Join-Path $desktop 'Get help.url'

if ($Action -eq 'remove') {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force; Write-Output "Removed $path" }
  else { Write-Output 'No Get help shortcut to remove.' }
  exit 0
}
if ($Action -ne 'install') { Write-Output "Unknown action '$Action' (use install or remove)."; exit 1 }

# .NET '$' also matches before a trailing newline, so CR/LF are refused explicitly.
if ($Url -match '[\\r\\n]' -or $Url -cnotmatch '${SHELL_HELP_URL_ERE}') {
  Write-Output 'help_url is missing or is not a Breeze help link (https://.../help#...). Nothing changed.'
  exit 1
}

if (-not (Test-Path -LiteralPath $desktop)) { New-Item -ItemType Directory -Path $desktop -Force | Out-Null }
$lines = @('[InternetShortcut]', "URL=$Url", 'IconFile=%SystemRoot%\\System32\\shell32.dll', 'IconIndex=23')
Set-Content -LiteralPath $path -Value $lines -Encoding ASCII -Force
Write-Output "Get help shortcut saved to $path"
`;

const MACOS_CONTENT = `#!/bin/bash
# Get help desktop shortcut (macOS) - Breeze fork.
# Puts "Get help.webloc" on the Desktop of every local user (/Users/*).
# Parameters: help_url (this device's link), action = install | remove.
url="$BREEZE_PARAM_HELP_URL"
action=$(printf '%s' "\${BREEZE_PARAM_ACTION:-install}" | tr '[:upper:]' '[:lower:]')
name='Get help.webloc'
case "$action" in install|remove) ;; *) echo "Unknown action '$action' (use install or remove)."; exit 1 ;; esac
# [[ =~ ]] matches the WHOLE value (a CR/LF fails the character classes); grep would match line by line.
re='${SHELL_HELP_URL_ERE}'
if [ "$action" = install ] && ! [[ "$url" =~ $re ]]; then
  echo 'help_url is missing or is not a Breeze help link (https://.../help#...). Nothing changed.'; exit 1
fi
count=0
for home in /Users/*; do
  user=$(basename "$home")
  case "$user" in Shared|Guest|.*) continue ;; esac
  [ -d "$home/Desktop" ] || continue
  file="$home/Desktop/$name"
  if [ "$action" = remove ]; then
    [ -e "$file" ] && rm -f "$file" && count=$((count + 1))
    continue
  fi
  cat > "$file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>$url</string></dict></plist>
EOF
  chown "$user" "$file" 2>/dev/null
  chmod u=rw,go=r "$file"
  count=$((count + 1))
done
echo "Get help shortcut: $action on $count desktop(s)."
`;

const LINUX_CONTENT = `#!/bin/bash
# Get help desktop shortcut (Linux) - Breeze fork. Best effort: desktops that
# show files from ~/Desktop (GNOME needs the "Desktop Icons" extension; some
# ask the user to "Allow launching" the first time).
# Parameters: help_url (this device's link), action = install | remove.
url="$BREEZE_PARAM_HELP_URL"
action=$(printf '%s' "\${BREEZE_PARAM_ACTION:-install}" | tr '[:upper:]' '[:lower:]')
name='get-help.desktop'
case "$action" in install|remove) ;; *) echo "Unknown action '$action' (use install or remove)."; exit 1 ;; esac
# [[ =~ ]] matches the WHOLE value (a CR/LF fails the character classes); grep would match line by line.
re='${SHELL_HELP_URL_ERE}'
if [ "$action" = install ] && ! [[ "$url" =~ $re ]]; then
  echo 'help_url is missing or is not a Breeze help link (https://.../help#...). Nothing changed.'; exit 1
fi
count=0
for home in /home/*; do
  user=$(basename "$home")
  id "$user" >/dev/null 2>&1 || continue
  desktop="$home/Desktop"
  [ -d "$desktop" ] || continue
  file="$desktop/$name"
  if [ "$action" = remove ]; then
    [ -e "$file" ] && rm -f "$file" && count=$((count + 1))
    continue
  fi
  printf '[Desktop Entry]\\nType=Link\\nName=Get help\\nIcon=help-browser\\nURL=%s\\n' "$url" > "$file"
  chown "$user": "$file" 2>/dev/null
  chmod u=rwx,go=rx "$file"
  count=$((count + 1))
done
echo "Get help shortcut: $action on $count desktop(s)."
`;

const BASE = {
  description:
    'Puts a "Get help" shortcut on the desktop that opens this computer\'s help page, where its user can send a ' +
    'support ticket (name, phone, company, email, problem, screenshot) without an account. The ticket is linked to ' +
    'this device. Run it from the device\'s Tickets tab (Install shortcut), which fills in help_url; action=remove ' +
    'takes the shortcut away.',
  category: 'Maintenance',
  parameters: [
    { name: 'help_url', type: 'string' as const, required: true, source: 'runtime' as const },
    { name: 'action', type: 'select' as const, required: false, options: 'install,remove', defaultValue: 'install', source: 'runtime' as const },
  ],
  timeoutSeconds: 120,
  runAs: 'system' as const,
};

export const HELP_SHORTCUT_SCRIPTS: SystemLibraryScriptDefinition[] = [
  { ...BASE, name: HELP_SHORTCUT_SCRIPT_NAMES.windows, osTypes: ['windows'], language: 'powershell', content: WINDOWS_CONTENT },
  { ...BASE, name: HELP_SHORTCUT_SCRIPT_NAMES.macos, osTypes: ['macos'], language: 'bash', content: MACOS_CONTENT },
  { ...BASE, name: HELP_SHORTCUT_SCRIPT_NAMES.linux, osTypes: ['linux'], language: 'bash', content: LINUX_CONTENT },
];
