/**
 * The SSH access target's per-owner record, `owners/<owner>/ssh-access.json`: the source of truth for which device keys
 * and manual keys this computer accepts (the authorized-keys file is derived from it, authorizedKeysFile.ts). It holds
 * public keys, fingerprints, device ids and labels only; no private key ever reaches the target.
 *
 * Mutations run under the ordinary cross-process lock and replace the file atomically (0600 temporary file, rename),
 * so two processes sharing a profile cannot lose each other's change. An unreadable file is never overwritten: reads
 * report it and mutations refuse until the person resets it. Shared by the desktop and the Node Host.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSshEd25519PublicKey } from '@cindy/device-link';
import { SSH_ACCESS_MAX_MANUAL_KEYS } from '../../shared/sshAccess.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

export { SSH_ACCESS_MAX_MANUAL_KEYS };
export const SSH_ACCESS_MAX_DEVICES = 64;
export const SSH_ACCESS_MAX_LABEL_CHARS = 64;
const MAX_RECORD_BYTES = 256 * 1024;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SshAccessDeviceKey {
  publicKey: string;
  fingerprint: string;
  enrolledAt: number;
}

export interface SshAccessManualKey {
  publicKey: string;
  fingerprint: string;
  label: string;
  addedAt: number;
}

export interface SshAccessRecord {
  version: 1;
  /** deviceId → that device's dedicated key (one fingerprint = one device). */
  devices: Record<string, SshAccessDeviceKey>;
  manualKeys: SshAccessManualKey[];
}

export type SshAccessRecordRead = { status: 'ready'; record: SshAccessRecord } | { status: 'unreadable'; record: null };

export class SshAccessRecordError extends Error {
  constructor(readonly code: 'UNREADABLE' | 'BUSY', message: string) {
    super(message);
    this.name = 'SshAccessRecordError';
  }
}

export const emptySshAccessRecord = (): SshAccessRecord => ({ version: 1, devices: {}, manualKeys: [] });

/** OpenSSH's `SHA256:<base64 without padding>` fingerprint of a canonical `ssh-ed25519 <base64>` key. */
export function sshKeyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.split(' ')[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export function isSshAccessDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

/** Labels are free text for the person; control characters are removed and the length is bounded. */
export function normalizeSshKeyLabel(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  const label = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return [...label].slice(0, SSH_ACCESS_MAX_LABEL_CHARS).join('');
}

function normalizeKey(raw: unknown): { publicKey: string; fingerprint: string } | null {
  const key = raw && typeof raw === 'object' ? parseSshEd25519PublicKey((raw as { publicKey?: unknown }).publicKey) : null;
  return key && key.comment === null ? { publicKey: key.publicKey, fingerprint: sshKeyFingerprint(key.publicKey) } : null;
}

const timestamp = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Drops malformed entries and keeps every fingerprint on one row only (devices first). */
export function normalizeSshAccessRecord(raw: unknown): SshAccessRecord {
  const record = emptySshAccessRecord();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return record;
  const seen = new Set<string>();
  const devices = (raw as { devices?: unknown }).devices;
  if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
    for (const [deviceId, value] of Object.entries(devices as Record<string, unknown>)) {
      const key = normalizeKey(value);
      if (!isSshAccessDeviceId(deviceId) || !key || seen.has(key.fingerprint)) continue;
      if (Object.keys(record.devices).length >= SSH_ACCESS_MAX_DEVICES) break;
      seen.add(key.fingerprint);
      record.devices[deviceId] = { ...key, enrolledAt: timestamp((value as { enrolledAt?: unknown }).enrolledAt) };
    }
  }
  const manual = (raw as { manualKeys?: unknown }).manualKeys;
  for (const value of Array.isArray(manual) ? manual : []) {
    const key = normalizeKey(value);
    if (!key || seen.has(key.fingerprint)) continue;
    if (record.manualKeys.length >= SSH_ACCESS_MAX_MANUAL_KEYS) break;
    seen.add(key.fingerprint);
    record.manualKeys.push({ ...key, label: normalizeSshKeyLabel((value as { label?: unknown }).label),
      addedAt: timestamp((value as { addedAt?: unknown }).addedAt) });
  }
  return record;
}

export async function readSshAccessRecord(file: string): Promise<SshAccessRecordRead> {
  let bytes: Buffer;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return { status: 'unreadable', record: null };
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ready', record: emptySshAccessRecord() };
    return { status: 'unreadable', record: null };
  }
  try {
    return { status: 'ready', record: normalizeSshAccessRecord(JSON.parse(bytes.toString('utf8'))) };
  } catch {
    return { status: 'unreadable', record: null };
  }
}

/**
 * Reads the record under the cross-process lock, applies `mutate` and writes the result when it returns a record
 * (null = no change). `assertCurrent` runs after the lock is held so an owner switch while waiting refuses the write.
 */
export async function updateSshAccessRecord(
  file: string,
  mutate: (record: SshAccessRecord) => SshAccessRecord | null,
  assertCurrent: () => void = () => undefined,
): Promise<SshAccessRecord> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withCrossProcessLock(`${file}.lock`, { label: 'ssh-access-record', waitMs: 12_000 }, async (lock) => {
    if (!lock.held) throw new SshAccessRecordError('BUSY', 'SSH access record is busy in another process');
    assertCurrent();
    const current = await readSshAccessRecord(file);
    if (current.status !== 'ready') throw new SshAccessRecordError('UNREADABLE', 'SSH access record is unreadable');
    const next = mutate(current.record);
    if (!next) return current.record;
    const normalized = normalizeSshAccessRecord(next);
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
