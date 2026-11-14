import { describe, expect, it } from 'vitest';
import { detectStrictScriptPatterns, scriptParameterDefinitionsSchema } from '@breeze/shared';
import { HELP_SHORTCUT_SCRIPTS, HELP_SHORTCUT_SCRIPT_NAMES, HELP_URL_PATTERN } from './helpShortcutScripts';
import { SYSTEM_LIBRARY_SCRIPTS } from '../systemScriptLibrary';

const TOKEN = 'A'.repeat(20) + 'b_c-'.repeat(7);

describe('Get help shortcut scripts (fork)', () => {
  it('ships one script per OS in the system library, each limited to its OS', () => {
    expect(HELP_SHORTCUT_SCRIPTS.map((s) => s.osTypes)).toEqual([['windows'], ['macos'], ['linux']]);
    for (const script of HELP_SHORTCUT_SCRIPTS) expect(SYSTEM_LIBRARY_SCRIPTS).toContain(script);
    expect(HELP_SHORTCUT_SCRIPTS.map((s) => s.name)).toEqual(Object.values(HELP_SHORTCUT_SCRIPT_NAMES));
  });

  it('declares help_url (required) and action (install/remove) as valid runtime parameters', () => {
    for (const script of HELP_SHORTCUT_SCRIPTS) {
      expect(scriptParameterDefinitionsSchema.safeParse(script.parameters).success).toBe(true);
      expect(script.parameters?.map((p) => p.name)).toEqual(['help_url', 'action']);
      expect(script.content).toContain('BREEZE_PARAM_HELP_URL');
      expect(script.content).toContain('BREEZE_PARAM_ACTION');
      // The in-script check is the same pattern as HELP_URL_PATTERN.
      expect(script.content).toContain(HELP_URL_PATTERN.source.replace(/\\\//g, '/'));
    }
  });

  it('the URL pattern accepts real help links and rejects anything that could inject or mislead', () => {
    expect(TOKEN).toHaveLength(48);
    for (const ok of [
      `https://rmm.example.com/help#${TOKEN}`,
      `https://192-168-1-5.nip.io/help#${TOKEN}`,
      `https://rmm.example.com:8443/app/help#${TOKEN}`,
    ]) expect(ok).toMatch(HELP_URL_PATTERN);
    for (const bad of [
      `http://rmm.example.com/help#${TOKEN}`,
      `https://rmm.example.com/help#${TOKEN}\r\nIconFile=evil`,
      `https://rmm.example.com/help#${TOKEN}"`,
      `https://rmm.example.com/help#${TOKEN.slice(1)}`,
      `https://rmm.example.com/other#${TOKEN}`,
      `https://user@rmm.example.com/help#${TOKEN}`,
      `javascript:alert(1)//help#${TOKEN}`,
      '',
    ]) expect(bad).not.toMatch(HELP_URL_PATTERN);
  });

  it('checks the WHOLE url value (line-based grep let a CR/LF line through)', () => {
    const [win, mac, lin] = HELP_SHORTCUT_SCRIPTS;
    for (const sh of [mac!, lin!]) {
      expect(sh.content).toContain('[[ "$url" =~ $re ]]');
      expect(sh.content).not.toMatch(/grep -E/);
    }
    expect(win!.content).toContain("$Url -match '[\\r\\n]'");
  });

  it('trips none of the agent strict danger patterns (runs without a security acknowledgement)', () => {
    for (const script of HELP_SHORTCUT_SCRIPTS) expect(detectStrictScriptPatterns(script.content)).toEqual([]);
  });

  it('Windows writes an Internet shortcut to the shared Public desktop', () => {
    const win = HELP_SHORTCUT_SCRIPTS[0]!;
    expect(win.language).toBe('powershell');
    expect(win.content).toContain("GetFolderPath('CommonDesktopDirectory')");
    expect(win.content).toContain("'Get help.url'");
    expect(win.content).toContain('[InternetShortcut]');
    expect(win.content).toContain('-cnotmatch');
  });
});
