/**
 * The SSH access CONTROLLER's per-owner record, `owners/<owner>/ssh-device-access.json`: for each of the person's
 * devices that offered SSH access, the alias and host Cindy keeps for it, whether the person deleted that host,
 * the device's last state and endpoint, and which device this computer's dedicated key was made for. It holds
 * device ids, aliases, addresses, user names and public host keys only; the dedicated private key lives in its own
 * file (dedicatedKey.ts).
 *
 * Mutations run under the ordinary cross-process lock and replace the file atomically (0600 temporary file, rename).
 * An unreadable file is never overwritten: reads report it and the controller does nothing for that owner until it
 * is fixed. Values are validated on read because they flow into the SSH config and the known-hosts file.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSshAccessHost, type SshAccessParsedBlock } from '@cindy/device-link';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { isSshAccessDeviceId } from './sshAccessRecord.js';

export const SSH_DEVICE_ACCESS_MAX_TARGETS = 64;
const MAX_RECORD_BYTES = 512 * 1024;
const ALIAS = /^cindy-[a-z0-9][a-z0-9-]{0,79}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const HOST_KEY = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{16,1400}={0,2}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const BLOCKS: ReadonlySet<string> = new Set([
  'SSHD_UNREACHABLE', 'REMOTE_LOGIN_OFF', 'AUTHORIZED_KEYS_UNSUPPORTED', 'PLATFORM_UNSUPPORTED', 'UNKNOWN',
]);

/**
 * What this computer last knew about a device's SSH access:
 * - `pending`: waiting for the device (its next announce, a write it retries, or a call that failed for now);
 * - `ready`: this computer's key is authorized and the host is up to date;
 * - `off`: the device turned SSH access (or its remote control) off;
 * - `blocked`: access is on but the device cannot accept SSH right now (see `blocked`);
 * - `revoked`: the device revoked this computer's remote access;
 * - `removed`: the device is no longer in the account's device list;
 * - `error`: the device refused this computer's key or answered something unusable; waits for its next announce.
 */
export type SshDeviceTargetStatus = 'pending' | 'ready' | 'off' | 'blocked' | 'revoked' | 'removed' | 'error';

export interface SshDeviceEndpointRecord {
  user: string;
  port: number;
  /** The address in the SSH config: the first the device listed. */
  hostname: string;
  /** All the device's host keys (`<type> <base64>`), as written to cindy_known_hosts. */
  hostKeys: string[];
}

export interface SshDeviceTargetRecord {
  /** Terminal alias and SSH host id; follows the device's name (sshAccessController.ts writeHost). */
  alias: string | null;
  /** Cindy added the host and it should still be listed: if it is gone, the person deleted it. */
  hostAdded: boolean;
  /** The person deleted the host: it is never added again automatically. */
  userDeleted: boolean;
  /** The display name Cindy last gave the host; the host's name follows a rename only while it still equals this. */
  displayName: string | null;
  status: SshDeviceTargetStatus;
  blocked: SshAccessParsedBlock | null;
  /** The device's opaque revision the host was last brought up to date with (equality only). */
  revision: number | null;
  /** This computer's key fingerprint that the device last confirmed as authorized. */
  enrolledFingerprint: string | null;
  endpoint: SshDeviceEndpointRecord | null;
  /** The device answered "channel not allowed" while running this app version: not asked again until it changes. */
  needsUpdateVersion: string | null;
  updatedAt: number;
}

export interface SshDeviceAccessRecord {
  version: 1;
  /** The device this computer's dedicated key was made for; a profile copied to another computer makes a new key. */
  keyDeviceId: string | null;
  targets: Record<string, SshDeviceTargetRecord>;
}

export type SshDeviceAccessRecordRead =
  | { status: 'ready'; record: SshDeviceAccessRecord }
  | { status: 'unreadable'; record: null };

export class SshDeviceAccessRecordError extends Error {
  constructor(readonly code: 'UNREADABLE' | 'BUSY', message: string) {
    super(message);
    this.name = 'SshDeviceAccessRecordError';
  }
}

export const emptySshDeviceAccessRecord = (): SshDeviceAccessRecord => ({ version: 1, keyDeviceId: null, targets: {} });

export const emptySshDeviceTarget = (now: number): SshDeviceTargetRecord => ({
  alias: null,
  hostAdded: false,
  userDeleted: false,
  displayName: null,
  status: 'pending',
  blocked: null,
  revision: null,
  enrolledFingerprint: null,
  endpoint: null,
  needsUpdateVersion: null,
  updatedAt: now,
});

const STATUSES: ReadonlySet<string> = new Set(['pending', 'ready', 'off', 'blocked', 'revoked', 'removed', 'error']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value) ? value : null;

function normalizeEndpoint(raw: unknown): SshDeviceEndpointRecord | null {
  const root = object(raw);
  if (!root || typeof root.user !== 'string' || !USER.test(root.user) || !isSshAccessHost(root.hostname)) return null;
  const port = root.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const hostKeys = (Array.isArray(root.hostKeys) ? root.hostKeys : [])
    .filter((key): key is string => typeof key === 'string' && HOST_KEY.test(key))
    .filter((key, index, all) => all.indexOf(key) === index)
    .slice(0, 6);
  return hostKeys.length ? { user: root.user, port, hostname: root.hostname, hostKeys } : null;
}

function normalizeTarget(raw: unknown): SshDeviceTargetRecord | null {
  const root = object(raw);
  if (!root) return null;
  const alias = typeof root.alias === 'string' && ALIAS.test(root.alias) ? root.alias : null;
  const revision = root.revision;
  return {
    alias,
    hostAdded: root.hostAdded === true && alias !== null,
    userDeleted: root.userDeleted === true,
    displayName: text(root.displayName, 128),
    status: typeof root.status === 'string' && STATUSES.has(root.status) ? root.status as SshDeviceTargetStatus : 'pending',
    blocked: typeof root.blocked === 'string' && BLOCKS.has(root.blocked) ? root.blocked as SshAccessParsedBlock : null,
    revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
    enrolledFingerprint: typeof root.enrolledFingerprint === 'string' && FINGERPRINT.test(root.enrolledFingerprint)
      ? root.enrolledFingerprint : null,
    endpoint: normalizeEndpoint(root.endpoint),
    needsUpdateVersion: text(root.needsUpdateVersion, 64),
    updatedAt: typeof root.updatedAt === 'number' && Number.isFinite(root.updatedAt) && root.updatedAt > 0 ? root.updatedAt : 0,
  };
}

/** Drops malformed entries; an alias stays on one device only (the first in file order). */
export function normalizeSshDeviceAccessRecord(raw: unknown): SshDeviceAccessRecord {
  const record = emptySshDeviceAccessRecord();
  const root = object(raw);
  if (!root) return record;
  record.keyDeviceId = isSshAccessDeviceId(root.keyDeviceId) ? root.keyDeviceId : null;
  const aliases = new Set<string>();
  for (const [deviceId, value] of Object.entries(object(root.targets) ?? {})) {
    if (!isSshAccessDeviceId(deviceId)) continue;
    if (Object.keys(record.targets).length >= SSH_DEVICE_ACCESS_MAX_TARGETS) break;
    const target = normalizeTarget(value);
    if (!target) continue;
    if (target.alias && aliases.has(target.alias)) Object.assign(target, { alias: null, hostAdded: false });
    if (target.alias) aliases.add(target.alias);
    record.targets[deviceId] = target;
  }
  return record;
}

export async function readSshDeviceAccessRecord(file: string): Promise<SshDeviceAccessRecordRead> {
  let bytes: Buffer;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return { status: 'unreadable', record: null };
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ready', record: emptySshDeviceAccessRecord() };
    return { status: 'unreadable', record: null };
  }
  try {
    return { status: 'ready', record: normalizeSshDeviceAccessRecord(JSON.parse(bytes.toString('utf8'))) };
  } catch {
    return { status: 'unreadable', record: null };
  }
}

/**
 * Reads the record under the cross-process lock, applies `mutate` and writes the result when it returns a record
 * (null = no change). `assertCurrent` runs once the lock is held so an owner switch while waiting refuses the write.
 */
export async function updateSshDeviceAccessRecord(
  file: string,
  mutate: (record: SshDeviceAccessRecord) => SshDeviceAccessRecord | null,
  assertCurrent: () => void = () => undefined,
): Promise<SshDeviceAccessRecord> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withCrossProcessLock(`${file}.lock`, { label: 'ssh-device-access-record', waitMs: 12_000 }, async (lock) => {
    if (!lock.held) throw new SshDeviceAccessRecordError('BUSY', 'SSH device access record is busy in another process');
    assertCurrent();
    const current = await readSshDeviceAccessRecord(file);
    if (current.status !== 'ready') throw new SshDeviceAccessRecordError('UNREADABLE', 'SSH device access record is unreadable');
    const next = mutate(current.record);
    if (!next) return current.record;
    const normalized = normalizeSshDeviceAccessRecord(next);
    const temp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(normalized, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
    return normalized;
  });
}
