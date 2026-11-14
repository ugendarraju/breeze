// fork: the per-device "Get help" link (no Breeze account needed to raise a
// ticket from a managed computer).
//
// The token is DERIVED, never stored:
//   token = base64url( deviceId[16] || version[4, BE] || HMAC-SHA256(key, "<deviceId>:<version>")[0..16] )
// so a technician can re-display the link at any time, nothing secret sits in
// the database, and there is no table (no migration, no RLS/cascade/export
// registration). The HMAC key comes from the deployment's secret-encryption key
// material under its own derived-key domain; links minted under a retained
// (rotated-out) key keep verifying until that key is dropped.
//
// Rotate / disable state is a small Redis hash per device (AOF-persisted,
// noeviction - the same store the fork's signup invites use):
//   fork:device-help:<deviceId>  ->  { v: <current version>, off: "1" when disabled }
// An absent hash means version 1, enabled - so every device has a working link
// without any provisioning step. Rotating bumps the version (old links die);
// disabling kills every version until the next rotate.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';
import { getRedis } from '../redis';

const KEY_DOMAIN = 'fork-device-help-link';
const STATE_KEY_PREFIX = 'fork:device-help:';
const MAC_BYTES = 16;
const TOKEN_BYTES = 16 + 4 + MAC_BYTES;
const TOKEN_RE = /^[A-Za-z0-9_-]{48}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HelpLinkUnavailableError extends Error {
  constructor() {
    super('Help link state store (Redis) is unavailable');
    this.name = 'HelpLinkUnavailableError';
  }
}

export interface HelpLinkState {
  version: number;
  enabled: boolean;
}

function uuidToBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mac(key: Buffer, deviceId: string, version: number): Buffer {
  return createHmac('sha256', key).update(`${deviceId.toLowerCase()}:${version}`).digest().subarray(0, MAC_BYTES);
}

/** Pure: the token for (device, version) under the ACTIVE key. */
export function mintHelpToken(deviceId: string, version: number): string {
  if (!UUID_RE.test(deviceId)) throw new Error('mintHelpToken: deviceId must be a uuid');
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new Error('mintHelpToken: bad version');
  const { active } = getSecretDerivedKeyMaterials(KEY_DOMAIN);
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(version);
  return Buffer.concat([uuidToBytes(deviceId), ver, mac(active.key, deviceId, version)]).toString('base64url');
}

/**
 * Pure: the device id and version a token claims, IF its MAC verifies under the
 * active or a retained key. Says nothing about whether that version is still
 * current - see resolveHelpToken.
 */
export function parseHelpToken(token: string): { deviceId: string; version: number } | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) return null;
  const deviceId = bytesToUuid(raw.subarray(0, 16));
  const version = raw.readUInt32BE(16);
  if (version < 1) return null;
  const given = raw.subarray(20);
  const { active, retained } = getSecretDerivedKeyMaterials(KEY_DOMAIN);
  for (const material of [active, ...retained]) {
    if (timingSafeEqual(given, mac(material.key, deviceId, version))) return { deviceId, version };
  }
  return null;
}

function stateKey(deviceId: string): string {
  return `${STATE_KEY_PREFIX}${deviceId.toLowerCase()}`;
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) throw new HelpLinkUnavailableError();
  return redis;
}

export async function getHelpLinkState(deviceId: string): Promise<HelpLinkState> {
  const raw = await requireRedis().hgetall(stateKey(deviceId));
  const version = Number.parseInt(raw?.v ?? '', 10);
  return { version: Number.isInteger(version) && version >= 1 ? version : 1, enabled: raw?.off !== '1' };
}

/** New version (old links stop working); also re-enables a disabled link. */
export async function rotateHelpLink(deviceId: string): Promise<HelpLinkState> {
  const redis = requireRedis();
  const key = stateKey(deviceId);
  const current = await getHelpLinkState(deviceId);
  // HINCRBY on an absent field starts from 0, so seed the implicit v1 first.
  await redis.hsetnx(key, 'v', String(current.version));
  const version = await redis.hincrby(key, 'v', 1);
  await redis.hdel(key, 'off');
  return { version, enabled: true };
}

/** Every link for this device stops working until the next rotate. */
export async function disableHelpLink(deviceId: string): Promise<HelpLinkState> {
  const redis = requireRedis();
  const current = await getHelpLinkState(deviceId);
  await redis.hset(stateKey(deviceId), 'v', String(current.version), 'off', '1');
  return { version: current.version, enabled: false };
}

/** The device a token currently stands for, or null (bad MAC, old version, disabled). */
export async function resolveHelpToken(token: string): Promise<string | null> {
  const parsed = parseHelpToken(token);
  if (!parsed) return null;
  const state = await getHelpLinkState(parsed.deviceId);
  if (!state.enabled || state.version !== parsed.version) return null;
  return parsed.deviceId;
}

/** Web origin the link points at (same resolution as other emailed dashboard links). */
export function helpLinkBase(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

/** The token rides in the fragment so it never reaches a server or proxy access log. */
export function helpLinkUrl(token: string): string {
  return `${helpLinkBase()}/help#${token}`;
}
