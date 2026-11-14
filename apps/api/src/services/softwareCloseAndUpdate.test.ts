import { describe, expect, it } from 'vitest';
import {
  buildCloseAndUpdateScript,
  folderFromUninstallString,
  resolveAppFolder,
  safeAppFolder,
} from './softwareCloseAndUpdate';

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

describe('folderFromUninstallString', () => {
  it('takes the folder of a quoted uninstaller (OBS Studio)', () => {
    expect(folderFromUninstallString('"C:\\Program Files\\obs-studio\\uninstall.exe"')).toBe('C:\\Program Files\\obs-studio');
  });

  it('takes the folder of an unquoted uninstaller with arguments', () => {
    expect(folderFromUninstallString('C:\\Program Files\\7-Zip\\Uninstall.exe /S')).toBe('C:\\Program Files\\7-Zip');
  });

  it('ignores generic hosts like msiexec', () => {
    expect(folderFromUninstallString('MsiExec.exe /X{1234}')).toBeNull();
    expect(folderFromUninstallString('"C:\\Windows\\System32\\msiexec.exe" /X{1234}')).toBeNull();
    expect(folderFromUninstallString('"C:\\Windows\\System32\\rundll32.exe" foo.dll,Uninstall')).toBeNull();
  });
});

describe('resolveAppFolder', () => {
  it('prefers InstallLocation, falls back to the uninstaller folder, refuses broad results', () => {
    expect(resolveAppFolder({ installLocation: 'C:\\Program Files\\Zoom', uninstallString: null })).toBe('C:\\Program Files\\Zoom');
    expect(resolveAppFolder({ installLocation: null, uninstallString: '"C:\\Program Files\\obs-studio\\uninstall.exe"' }))
      .toBe('C:\\Program Files\\obs-studio');
    expect(resolveAppFolder({ installLocation: '', uninstallString: '"C:\\Program Files\\uninstall.exe"' })).toBeNull();
    expect(resolveAppFolder({ installLocation: null, uninstallString: null })).toBeNull();
  });
});

describe('buildCloseAndUpdateScript', () => {
  const script = buildCloseAndUpdateScript('C:\\Program Files\\obs-studio', 'OBSProject.OBSStudio');

  it('embeds the folder and id as single-quoted literals', () => {
    expect(script).toContain("$appDir = 'C:\\Program Files\\obs-studio' + '\\'");
    expect(script).toContain("$packageId = 'OBSProject.OBSStudio'");
  });

  it('upgrades the exact id from the winget source only', () => {
    expect(script).toContain('upgrade --exact --id $packageId --source winget');
    expect(script).not.toMatch(/--name/);
    expect(script).not.toMatch(/msstore/);
  });

  it('never stops itself, its parents, or core Windows processes', () => {
    expect(script).toContain('$skip.Contains($proc.Id)');
    for (const name of ['csrss', 'lsass', 'svchost', 'explorer', 'winlogon']) expect(script).toContain(`'${name}'`);
  });

  it('doubles single quotes in the folder', () => {
    expect(buildCloseAndUpdateScript("C:\\Program Files\\it's", 'A.B')).toContain("'C:\\Program Files\\it''s'");
  });

  it('refuses an unsafe folder or a malformed id', () => {
    expect(() => buildCloseAndUpdateScript('C:\\Program Files', 'A.B')).toThrow();
    expect(() => buildCloseAndUpdateScript('C:\\Program Files\\App', "x'; Remove-Item C:\\ -Recurse; '")).toThrow();
  });
});
