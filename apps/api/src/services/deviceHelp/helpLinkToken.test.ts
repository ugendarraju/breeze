import { beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({
  active: { keyId: 'k2', key: Buffer.alloc(32, 2) },
  retained: [] as Array<{ keyId: string; key: Buffer }>,
}));
vi.mock('../secretCrypto', () => ({
  getSecretDerivedKeyMaterials: () => ({ active: keys.active, retained: keys.retained }),
}));

const store = vi.hoisted(() => ({ hashes: new Map<string, Map<string, string>>(), online: true }));
vi.mock('../redis', () => ({
  getRedis: () => {
    if (!store.online) return null;
    const h = (k: string) => {
      if (!store.hashes.has(k)) store.hashes.set(k, new Map());
      return store.hashes.get(k)!;
    };
    return {
      hgetall: async (k: string) => Object.fromEntries(store.hashes.get(k) ?? []),
      hsetnx: async (k: string, f: string, v: string) => (h(k).has(f) ? 0 : (h(k).set(f, v), 1)),
      hincrby: async (k: string, f: string, by: number) => {
        const next = Number(h(k).get(f) ?? '0') + by;
        h(k).set(f, String(next));
        return next;
      },
      hdel: async (k: string, f: string) => (h(k).delete(f) ? 1 : 0),
      hset: async (k: string, ...pairs: string[]) => {
        for (let i = 0; i < pairs.length; i += 2) h(k).set(pairs[i]!, pairs[i + 1]!);
        return pairs.length / 2;
      },
    };
  },
}));

import {
  HelpLinkUnavailableError,
  disableHelpLink,
  getHelpLinkState,
  helpLinkUrl,
  mintHelpToken,
  parseHelpToken,
  resolveHelpToken,
  rotateHelpLink,
} from './helpLinkToken';
import { HELP_URL_PATTERN } from './helpShortcutScripts';

const DEVICE = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const OTHER = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  store.hashes.clear();
  store.online = true;
  keys.active = { keyId: 'k2', key: Buffer.alloc(32, 2) };
  keys.retained = [];
});

describe('help link token (derived, not stored)', () => {
  it('round-trips device and version, and is URL-safe and fixed-length', () => {
    const token = mintHelpToken(DEVICE, 1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(parseHelpToken(token)).toEqual({ deviceId: DEVICE, version: 1 });
    expect(mintHelpToken(DEVICE, 1)).toBe(token); // deterministic: re-displayable
    expect(mintHelpToken(DEVICE, 2)).not.toBe(token);
    expect(mintHelpToken(OTHER, 1)).not.toBe(token);
  });

  it('rejects a tampered token, a token for another device id, junk and a foreign key', () => {
    const token = mintHelpToken(DEVICE, 1);
    const raw = Buffer.from(token, 'base64url');
    raw[0] = raw[0]! ^ 0x01; // claim a different device with the same MAC
    expect(parseHelpToken(raw.toString('base64url'))).toBeNull();
    const flippedMac = Buffer.from(token, 'base64url');
    flippedMac[35] = flippedMac[35]! ^ 0x80;
    expect(parseHelpToken(flippedMac.toString('base64url'))).toBeNull();
    expect(parseHelpToken('')).toBeNull();
    expect(parseHelpToken('x'.repeat(48))).toBeNull();
    expect(parseHelpToken(`${token}=`)).toBeNull();
    keys.active = { keyId: 'other', key: Buffer.alloc(32, 9) };
    expect(parseHelpToken(token)).toBeNull();
  });

  it('keeps verifying links minted under a key that was rotated into retention', () => {
    const token = mintHelpToken(DEVICE, 1);
    keys.retained = [keys.active];
    keys.active = { keyId: 'k3', key: Buffer.alloc(32, 3) };
    expect(parseHelpToken(token)).toEqual({ deviceId: DEVICE, version: 1 });
  });

  it('the link URL puts the token in the fragment and matches the shortcut scripts pattern', () => {
    process.env.DASHBOARD_URL = 'https://rmm.example.com/';
    const url = helpLinkUrl(mintHelpToken(DEVICE, 1));
    expect(url.startsWith('https://rmm.example.com/help#')).toBe(true);
    expect(url).toMatch(HELP_URL_PATTERN);
    delete process.env.DASHBOARD_URL;
  });
});

describe('help link state (rotate / disable)', () => {
  it('a device with no state is version 1, enabled', async () => {
    expect(await getHelpLinkState(DEVICE)).toEqual({ version: 1, enabled: true });
    expect(await resolveHelpToken(mintHelpToken(DEVICE, 1))).toBe(DEVICE);
  });

  it('rotate kills the old link and the new one works', async () => {
    const old = mintHelpToken(DEVICE, 1);
    expect(await rotateHelpLink(DEVICE)).toEqual({ version: 2, enabled: true });
    expect(await resolveHelpToken(old)).toBeNull();
    expect(await resolveHelpToken(mintHelpToken(DEVICE, 2))).toBe(DEVICE);
    expect((await rotateHelpLink(DEVICE)).version).toBe(3);
  });

  it('disable kills every link until the next rotate, which re-enables with a new version', async () => {
    await disableHelpLink(DEVICE);
    expect(await resolveHelpToken(mintHelpToken(DEVICE, 1))).toBeNull();
    const state = await rotateHelpLink(DEVICE);
    expect(state).toEqual({ version: 2, enabled: true });
    expect(await resolveHelpToken(mintHelpToken(DEVICE, 1))).toBeNull();
    expect(await resolveHelpToken(mintHelpToken(DEVICE, 2))).toBe(DEVICE);
  });

  it('one device rotating does not touch another', async () => {
    await rotateHelpLink(DEVICE);
    expect(await resolveHelpToken(mintHelpToken(OTHER, 1))).toBe(OTHER);
  });

  it('without Redis it refuses instead of guessing', async () => {
    store.online = false;
    await expect(resolveHelpToken(mintHelpToken(DEVICE, 1))).rejects.toBeInstanceOf(HelpLinkUnavailableError);
    await expect(rotateHelpLink(DEVICE)).rejects.toBeInstanceOf(HelpLinkUnavailableError);
  });
});
