import { describe, expect, it } from 'vitest';
import {
  DRIVER_INSTALL_BEGIN,
  DRIVER_INSTALL_END,
  DRIVER_SCAN_BEGIN,
  DRIVER_SCAN_END,
  DRIVER_SCRIPTS,
  OEM_TOOL_WINGET_IDS,
  oemVendorFromManufacturer,
  parseDriverInstallOutput,
  parseDriverScanOutput,
} from './driverScripts';
import { SYSTEM_LIBRARY_SCRIPTS } from './systemScriptLibrary';
import { outputTail } from '../routes/devices/drivers';

const UPDATE_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const scanDoc = {
  version: 1,
  scannedAt: '2026-11-15T10:00:00.000Z',
  manufacturer: 'ASUSTeK COMPUTER INC.',
  model: 'ROG Strix',
  drivers: [
    { deviceName: 'Realtek Audio', deviceClass: 'MEDIA', deviceId: 'HDAUDIO\\FUNC_01&VEN_10EC', hardwareId: 'HDAUDIO\\FUNC_01&VEN_10EC', version: '6.0.9', date: '2024-01-02', provider: 'Realtek', inf: 'oem12.inf' },
    { deviceName: '', deviceId: 'X' },
  ],
  windowsUpdate: {
    ok: true,
    source: 'Windows Update',
    error: null,
    updates: [
      { updateId: UPDATE_ID.toUpperCase(), title: 'Realtek - MEDIA - 6.0.10', hardwareId: 'hdaudio\\func_01&ven_10ec', date: '2025-05-01', sizeBytes: 1234, mayRequireReboot: true, deviceIds: ['HDAUDIO\\FUNC_01&VEN_10EC'] },
      { updateId: 'not-a-guid', title: 'dropped' },
    ],
  },
  oem: { vendor: 'dell', tool: 'Dell Command Update', ok: true, listSupported: true, error: null, updates: { name: 'Intel Chipset', version: '10.1', id: 'ABC12' } },
};

const wrap = (doc: unknown, begin = DRIVER_SCAN_BEGIN, end = DRIVER_SCAN_END) =>
  `Installed drivers: 1.\r\n${begin}\r\n${JSON.stringify(doc)}\r\n${end}\r\n`;

describe('driver scripts (fork)', () => {
  it('ships Windows-only SYSTEM scripts in the system library', () => {
    for (const script of DRIVER_SCRIPTS) {
      expect(SYSTEM_LIBRARY_SCRIPTS).toContain(script);
      expect(script.osTypes).toEqual(['windows']);
      expect(script.runAs).toBe('system');
      expect(script.language).toBe('powershell');
    }
  });

  it('script bodies carry no template leftovers (backtick or dollar-brace)', () => {
    for (const script of DRIVER_SCRIPTS) {
      expect(script.content).not.toContain('`');
      expect(script.content).not.toContain('${');
    }
  });

  it('install and tool scripts never restart the device', () => {
    for (const script of DRIVER_SCRIPTS) {
      expect(script.content).not.toMatch(/Restart-Computer|shutdown(\.exe)?\s+\/r/i);
    }
    const install = DRIVER_SCRIPTS.find((s) => s.name === 'Driver Install (Windows)')!;
    expect(install.content).toContain('-reboot=disable');
    expect(install.content).toContain('-noreboot');
  });

  it('the tool script installs the maker-published winget packages', () => {
    const tool = DRIVER_SCRIPTS.find((s) => s.name === 'Driver Tool Install (Windows)')!;
    for (const { id } of Object.values(OEM_TOOL_WINGET_IDS)) expect(tool.content).toContain(`'${id}'`);
    expect(tool.content).toContain('--exact');
  });

  it('parses and validates a scan document', () => {
    const r = parseDriverScanOutput(wrap(scanDoc))!;
    expect(r.manufacturer).toBe('ASUSTeK COMPUTER INC.');
    expect(r.drivers).toHaveLength(1);
    expect(r.windowsUpdate.updates).toEqual([
      expect.objectContaining({ updateId: UPDATE_ID, mayRequireReboot: true, deviceIds: ['HDAUDIO\\FUNC_01&VEN_10EC'] }),
    ]);
    // PowerShell serializes a one-item array as an object.
    expect(r.oem?.updates).toEqual([expect.objectContaining({ name: 'Intel Chipset', id: 'ABC12' })]);
  });

  it('keeps the maker apps the scan found, even as a lone string', () => {
    expect(parseDriverScanOutput(wrap({ ...scanDoc, makerApps: ['MyASUS', 'Armoury Crate'] }))!.makerApps).toEqual(['MyASUS', 'Armoury Crate']);
    expect(parseDriverScanOutput(wrap({ ...scanDoc, makerApps: 'MyASUS' }))!.makerApps).toEqual(['MyASUS']);
    expect(parseDriverScanOutput(wrap(scanDoc))!.makerApps).toEqual([]);
  });

  it('the scan looks for MyASUS by its package folder', () => {
    expect(DRIVER_SCRIPTS[0]!.content).toContain('B9ECED6F.ASUSPCAssistant_*');
  });

  it('returns null without markers or with broken JSON, and ignores an unknown vendor', () => {
    expect(parseDriverScanOutput('no markers')).toBeNull();
    expect(parseDriverScanOutput(`${DRIVER_SCAN_BEGIN}{oops${DRIVER_SCAN_END}`)).toBeNull();
    expect(parseDriverScanOutput(wrap({ ...scanDoc, oem: { vendor: 'evil', updates: [] } }))!.oem).toBeNull();
  });

  it('caps device-supplied strings', () => {
    const long = 'x'.repeat(5000);
    const r = parseDriverScanOutput(wrap({ ...scanDoc, drivers: [{ deviceName: long, deviceId: long }] }))!;
    expect(r.drivers[0]!.deviceName).toHaveLength(200);
    expect(r.drivers[0]!.deviceId).toHaveLength(300);
  });

  it('parses an install result', () => {
    const doc = {
      restorePoint: true,
      rebootRequired: true,
      windowsUpdate: { updateId: UPDATE_ID, title: 'Realtek', result: 'succeeded', hresult: '0x00000000' },
      oem: { vendor: 'hp', tool: 'HP Image Assistant', result: 'nothing_to_install', exitCode: 256 },
      before: [{ deviceName: 'Realtek Audio', version: '6.0.9' }],
    };
    const r = parseDriverInstallOutput(wrap(doc, DRIVER_INSTALL_BEGIN, DRIVER_INSTALL_END))!;
    expect(r.rebootRequired).toBe(true);
    expect(r.windowsUpdate).toEqual([expect.objectContaining({ result: 'succeeded' })]);
    expect(r.oem).toEqual(expect.objectContaining({ vendor: 'hp', exitCode: '256' }));
    expect(r.before[0]!.version).toBe('6.0.9');
  });

  it('maps manufacturer strings to vendor lanes', () => {
    expect(oemVendorFromManufacturer('Dell Inc.')).toBe('dell');
    expect(oemVendorFromManufacturer('HP')).toBe('hp');
    expect(oemVendorFromManufacturer('Hewlett-Packard')).toBe('hp');
    expect(oemVendorFromManufacturer('LENOVO')).toBe('lenovo');
    expect(oemVendorFromManufacturer('ASUSTeK COMPUTER INC.')).toBeNull();
    expect(oemVendorFromManufacturer('HPE')).toBeNull();
    expect(oemVendorFromManufacturer(null)).toBeNull();
  });

  it('outputTail drops the JSON document and markers', () => {
    expect(outputTail(wrap(scanDoc))).toBe('Installed drivers: 1.');
  });
});
