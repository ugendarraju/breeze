import { describe, expect, it } from 'vitest';
import {
  buildDetectScript,
  buildGuardedUpdateScript,
  buildUserNotification,
  deriveUpdateStatuses,
  folderFromUninstallString,
  parseMarkers,
  parsePackagesHeader,
  summarizeUpdateError,
  resolveAppFolder,
  safeAppFolder,
  updateTimeoutSeconds,
} from './softwareGuardedUpdate';

describe('safeAppFolder', () => {
  it.each([
    ['C:\\Program Files\\obs-studio', 'C:\\Program Files\\obs-studio'],
    ['c:\\Program Files\\obs-studio\\', 'C:\\Program Files\\obs-studio'],
    ['"C:\\Program Files (x86)\\Zoom"', 'C:\\Program Files (x86)\\Zoom'],
    ['D:/Tools/Everything', 'D:\\Tools\\Everything'],
    ['C:\\Users\\sam\\AppData\\Local\\Discord', 'C:\\Users\\sam\\AppData\\Local\\Discord'],
    ['C:\\ProgramData\\Vendor\\App', 'C:\\ProgramData\\Vendor\\App'],
  ])('accepts an app-specific folder %s', (raw, expected) => {
    expect(safeAppFolder(raw)).toBe(expected);
  });

  it.each([
    'C:\\',
    'C:\\Program Files',
    'C:\\Program Files (x86)\\',
    'C:\\Program Files\\Common Files',
    'C:\\Program Files\\Common Files\\Vendor',
    'C:\\Program Files\\WindowsApps\\Some.App_1.0',
    'C:\\Windows\\System32',
    'C:\\Windows\\Something\\Deep',
    'C:\\ProgramData\\Vendor',
    'C:\\Users\\sam',
    'C:\\Users\\sam\\AppData\\Local',
    'C:\\Users\\sam\\AppData\\Local\\Programs',
    'C:\\Program Files\\..\\Windows',
    'C:\\Program Files\\a*',
    'relative\\path',
    '\\\\server\\share\\app',
    '',
    null,
  ])('refuses %s', (raw) => {
    expect(safeAppFolder(raw)).toBeNull();
  });
});

describe('folderFromUninstallString / resolveAppFolder', () => {
  it('takes the folder of a quoted or unquoted uninstaller', () => {
    expect(folderFromUninstallString('"C:\\Program Files\\obs-studio\\uninstall.exe"')).toBe('C:\\Program Files\\obs-studio');
    expect(folderFromUninstallString('C:\\Program Files\\7-Zip\\Uninstall.exe /S')).toBe('C:\\Program Files\\7-Zip');
  });

  it('ignores generic hosts like msiexec', () => {
    expect(folderFromUninstallString('MsiExec.exe /X{1234}')).toBeNull();
    expect(folderFromUninstallString('"C:\\Windows\\System32\\rundll32.exe" foo.dll,Uninstall')).toBeNull();
  });

  it('prefers InstallLocation, falls back to the uninstaller folder, refuses broad results', () => {
    expect(resolveAppFolder({ installLocation: 'C:\\Program Files\\Zoom', uninstallString: null })).toBe('C:\\Program Files\\Zoom');
    expect(resolveAppFolder({ installLocation: null, uninstallString: '"C:\\Program Files\\obs-studio\\uninstall.exe"' }))
      .toBe('C:\\Program Files\\obs-studio');
    expect(resolveAppFolder({ installLocation: '', uninstallString: '"C:\\Program Files\\uninstall.exe"' })).toBeNull();
  });
});

const OBS = { packageId: 'OBSProject.OBSStudio', name: 'OBS Studio', folder: 'C:\\Program Files\\obs-studio' };
const ZOOM = { packageId: 'Zoom.Zoom', name: "Zoom's client", folder: null };

describe('buildDetectScript', () => {
  const script = buildDetectScript([OBS, ZOOM]);

  it('lists every package with its folder (or $null) and stops nothing', () => {
    expect(script).toContain("Id = 'OBSProject.OBSStudio'; Name = 'OBS Studio'; Dir = 'C:\\Program Files\\obs-studio'");
    expect(script).toContain("Id = 'Zoom.Zoom'; Name = 'Zoom''s client'; Dir = $null");
    expect(script).not.toContain('Stop-Process');
    expect(script).not.toContain('winget');
  });
});

describe('buildGuardedUpdateScript', () => {
  it('wait mode never stops a process and waits for blockers', () => {
    const script = buildGuardedUpdateScript([OBS], 'wait');
    expect(script).not.toContain('Stop-Process');
    expect(script).toContain('mode: wait');
    expect(script).toContain('Start-Sleep -Seconds 15');
  });

  it('force mode stops blockers before updating', () => {
    expect(buildGuardedUpdateScript([OBS], 'force')).toContain('Stop-Process -Id $t.Id -Force');
  });

  it('upgrades each exact id from the winget source only', () => {
    const script = buildGuardedUpdateScript([OBS, ZOOM], 'wait');
    expect(script).toContain('upgrade --exact --id $pkg.Id --source winget');
    expect(script).not.toMatch(/--name|msstore/);
  });

  it('never stops itself, its parents, or core Windows processes', () => {
    const script = buildGuardedUpdateScript([OBS], 'force');
    expect(script).toContain('$skip.Contains($proc.Id)');
    for (const name of ['csrss', 'lsass', 'svchost', 'explorer', 'winlogon']) expect(script).toContain(`'${name}'`);
  });

  it('refuses an unsafe folder, a malformed id, or no packages', () => {
    expect(() => buildGuardedUpdateScript([{ ...OBS, folder: 'C:\\Program Files' }], 'wait')).toThrow();
    expect(() => buildGuardedUpdateScript([{ ...OBS, packageId: "x'; Remove-Item C:\\ -Recurse; '" }], 'wait')).toThrow();
    expect(() => buildGuardedUpdateScript([], 'wait')).toThrow();
  });

  it('keeps the timeout within the agent cap', () => {
    expect(updateTimeoutSeconds(1)).toBe(960);
    expect(updateTimeoutSeconds(50)).toBe(3600);
  });
});

describe('parseMarkers', () => {
  it('reads detect and update markers and ignores everything else', () => {
    const stdout = [
      'Updating OBS Studio (OBSProject.OBSStudio)...',
      'BREEZE_SOFTWARE_UPDATE {"phase":"detect","packageId":"OBSProject.OBSStudio","programs":["Google Chrome","Opera Internet Browser"]}',
      'BREEZE_SOFTWARE_UPDATE {"phase":"detect","packageId":"Zoom.Zoom","programs":[]}',
      'BREEZE_SOFTWARE_UPDATE {"phase":"update","packageId":"OBSProject.OBSStudio","name":"OBS Studio","outcome":"blocked","exitCode":null,"programs":"Google Chrome"}',
      'BREEZE_SOFTWARE_UPDATE {"phase":"update","packageId":"Zoom.Zoom","name":"Zoom","outcome":"updated","exitCode":0,"programs":[]}',
      'BREEZE_SOFTWARE_UPDATE not json',
      'BREEZE_SOFTWARE_UPDATE {"phase":"update","packageId":"X","outcome":"exploded"}',
    ].join('\r\n');
    const { detect, update } = parseMarkers(stdout);
    expect(detect).toEqual([
      { phase: 'detect', packageId: 'OBSProject.OBSStudio', programs: ['Google Chrome', 'Opera Internet Browser'] },
      { phase: 'detect', packageId: 'Zoom.Zoom', programs: [] },
    ]);
    expect(update).toEqual([
      { phase: 'update', packageId: 'OBSProject.OBSStudio', name: 'OBS Studio', outcome: 'blocked', exitCode: null, programs: ['Google Chrome'] },
      { phase: 'update', packageId: 'Zoom.Zoom', name: 'Zoom', outcome: 'updated', exitCode: 0, programs: [] },
    ]);
  });

  it('handles empty output', () => {
    expect(parseMarkers(undefined)).toEqual({ detect: [], update: [] });
  });
});

describe('summarizeUpdateError', () => {
  it('names the known installer and winget failures', () => {
    expect(summarizeUpdateError('...Files modified by the installer are currently in use by a different application. ...\nInstaller failed with exit code: 6)'))
      .toBe('Files are in use by another program, installer exit code 6');
    expect(summarizeUpdateError('The `msstore` source requires that you view the following agreements before using.'))
      .toBe('The Microsoft Store source needs interactive acceptance');
    expect(summarizeUpdateError('failed: exit status 0x8a150014 (No installed package found matching input criteria.)'))
      .toBe('winget could not find the installed package');
  });

  it('falls back to the exit status, the first line, or a generic message', () => {
    expect(summarizeUpdateError('failed to update "X" after 1 attempt(s): winget.exe [upgrade]: exit status 0x8a15ffff (weird)'))
      .toBe('The update failed (exit 0x8a15ffff)');
    expect(summarizeUpdateError('something odd\nmore')).toBe('something odd');
    expect(summarizeUpdateError(undefined)).toBe('The update failed without an error message');
  });
});

describe('parsePackagesHeader', () => {
  it('reads the batch listed in an update script', () => {
    const script = buildGuardedUpdateScript([OBS, ZOOM], 'wait');
    expect(parsePackagesHeader(script)).toEqual([
      { packageId: 'OBSProject.OBSStudio', name: 'OBS Studio' },
      { packageId: 'Zoom.Zoom', name: "Zoom's client" },
    ]);
    expect(parsePackagesHeader('no header')).toEqual([]);
    expect(parsePackagesHeader('# BREEZE_PACKAGES not-json')).toEqual([]);
  });
});

describe('deriveUpdateStatuses', () => {
  const script = (status: string, stdout: string | null, id = 'cmd-s') => ({
    id, type: 'script', status, createdAt: '2026-11-15T06:00:00Z', completedAt: status === 'completed' || status === 'failed' ? '2026-11-15T06:05:00Z' : null,
    payload: { scriptId: 'software_update_guarded', content: buildGuardedUpdateScript([OBS, ZOOM], 'wait') },
    result: stdout === null ? null : { stdout },
  });

  it('shows every package in a running batch as running', () => {
    expect(deriveUpdateStatuses([script('sent', null)]).map((s) => [s.packageId, s.state])).toEqual([
      ['OBSProject.OBSStudio', 'running'],
      ['Zoom.Zoom', 'running'],
    ]);
  });

  it('turns a finished batch into per-package outcomes', () => {
    const stdout = [
      'BREEZE_SOFTWARE_UPDATE {"phase":"update","packageId":"Zoom.Zoom","name":"Zoom\'s client","outcome":"updated","exitCode":0,"programs":[]}',
      'BREEZE_SOFTWARE_UPDATE {"phase":"update","packageId":"OBSProject.OBSStudio","name":"OBS Studio","outcome":"blocked","exitCode":null,"programs":["Google Chrome"]}',
    ].join('\n');
    const statuses = deriveUpdateStatuses([script('failed', stdout)]);
    expect(statuses).toEqual([
      expect.objectContaining({ packageId: 'OBSProject.OBSStudio', state: 'blocked', programs: ['Google Chrome'] }),
      expect.objectContaining({ packageId: 'Zoom.Zoom', state: 'succeeded', message: null }),
    ]);
  });

  it('reports a package the script never reached as failed', () => {
    const statuses = deriveUpdateStatuses([{ ...script('timeout', null), result: { error: 'Command timed out after 960000ms' } }]);
    expect(statuses.every((s) => s.state === 'failed')).toBe(true);
    expect(statuses[0]!.message).toBe('Command timed out after 960000ms');
  });

  it('keeps only the newest status per package and maps plain update commands', () => {
    const statuses = deriveUpdateStatuses([
      { id: 'new', type: 'software_update', status: 'pending', createdAt: '2026-11-15T07:00:00Z', completedAt: null, payload: { packageId: 'Zoom.Zoom', displayName: 'Zoom' }, result: null },
      { id: 'old', type: 'software_update', status: 'failed', createdAt: '2026-11-15T06:00:00Z', completedAt: null, payload: { packageId: 'Zoom.Zoom' }, result: { error: 'x' } },
      { id: 'noid', type: 'software_update', status: 'completed', createdAt: '2026-11-15T06:00:00Z', completedAt: null, payload: { name: 'Legacy' }, result: null },
    ]);
    expect(statuses).toEqual([expect.objectContaining({ packageId: 'Zoom.Zoom', name: 'Zoom', state: 'queued', commandId: 'new' })]);
  });
});

describe('buildUserNotification', () => {
  it('names the updates only when nothing blocks them', () => {
    expect(buildUserNotification(['OBS Studio', 'Zoom'], [], 'wait').body).toBe('Your IT team is updating OBS Studio, Zoom.');
  });

  it('combines every blocking program into one request to close them', () => {
    const { body } = buildUserNotification(
      ['OBS Studio', 'Zoom', '7-Zip'],
      [
        { name: 'OBS Studio', programs: ['Google Chrome', 'Opera Internet Browser'] },
        { name: 'Zoom', programs: ['Google Chrome', 'Zoom Meetings'] },
      ],
      'wait'
    );
    expect(body).toContain('close Google Chrome, Opera Internet Browser, Zoom Meetings so OBS Studio, Zoom can update');
    expect(body).toContain('continues on its own');
  });

  it('warns that programs will be closed in force mode', () => {
    expect(buildUserNotification(['OBS Studio'], [{ name: 'OBS Studio', programs: ['Google Chrome'] }], 'force').body)
      .toContain('These programs will be closed so the update can finish: Google Chrome');
  });
});
