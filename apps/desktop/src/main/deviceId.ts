/**
 * deviceId.ts
 * ---------------------------------------------------------------------------
 * `node-machine-id`'s `machineIdSync()` runs bare `ioreg` on macOS (and relies on
 * `/usr/sbin:/sbin` on Linux). An app launched from Finder/Dock inherits a minimal
 * PATH — often just `/usr/bin:/bin` — that omits those dirs, so the command isn't
 * found and `machineIdSync()` throws `ioreg: command not found`. Because the device
 * id is read at module top level, that throw took the whole main process down on
 * launch — the "打开即闪退" (launch → instant crash) reported on packaged 0.1.14.
 *
 * The fix is just to guarantee the system bin dirs are on PATH before any device-id
 * probe runs. Call `ensureSystemBinPathForMachineId()` once, early in startup,
 * before the module that reads the device id loads.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';

/**
 * A computer whose hardware id collides with another computer's (Windows images
 * deployed without regenerating MachineGuid) can take a new identity on the user's
 * request. The record lives at the profile root, shared by Desktop and the Node Host.
 */
export const DEVICE_IDENTITY_FILE = 'device-identity.json';
const REPLACEMENT_DEVICE_ID = /^[0-9a-f]{64}$/;

export interface RuntimeDeviceIdentity {
  deviceId: string;
  source: 'override' | 'hardware' | 'replacement';
  /** The hardware id read on this start; null under an explicit override. */
  hardwareId: string | null;
  retiredDeviceIds?: readonly string[];
}

/**
 * The replacement only applies on the computer whose hardware id it replaced: a
 * profile copied to another computer, or a hardware id changed afterwards, falls back
 * to that hardware id instead of carrying the identity elsewhere. A missing or
 * malformed record means no replacement.
 */
function readReplacementDeviceIdentity(profileDir: string, physicalId: string): {
  deviceId: string; retiredDeviceIds: string[];
} | null {
  let raw: string | null;
  try {
    raw = readAtomicFileSync(path.join(profileDir, DEVICE_IDENTITY_FILE));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { version?: unknown; deviceId?: unknown; replaces?: unknown; retiredDeviceIds?: unknown };
    if (record?.version !== 1 || record.replaces !== physicalId) return null;
    if (typeof record.deviceId !== 'string' || !REPLACEMENT_DEVICE_ID.test(record.deviceId)) return null;
    if (record.deviceId === physicalId) return null;
    const retired = Array.isArray(record.retiredDeviceIds)
      ? record.retiredDeviceIds.filter((id): id is string =>
        typeof id === 'string' && REPLACEMENT_DEVICE_ID.test(id) && id !== record.deviceId)
      : [];
    return { deviceId: record.deviceId, retiredDeviceIds: [...new Set([physicalId, ...retired])] };
  } catch {
    return null;
  }
}

/**
 * Gives this computer a new random identity in the same shape as the hardware-derived
 * one (64 lowercase hex, within the server's 64-character limit). Takes effect on the
 * next start; returns the new id.
 */
export function writeReplacementDeviceId(profileDir: string, physicalId: string, outgoingId = physicalId): string {
  const deviceId = randomBytes(32).toString('hex');
  const previous = readReplacementDeviceIdentity(profileDir, physicalId);
  const retiredDeviceIds = [...new Set([...(previous?.retiredDeviceIds ?? []), outgoingId])]
    .filter((id) => id !== physicalId);
  atomicWriteFileSync(
    path.join(profileDir, DEVICE_IDENTITY_FILE),
    JSON.stringify({ version: 1, deviceId, replaces: physicalId, retiredDeviceIds, createdAt: Date.now() }),
  );
  return deviceId;
}

/** Auth, remote registration and the Node launcher must use one identity. An
 * explicitly isolated instance must never silently register its physical host. */
export function resolveRuntimeDeviceIdentity(
  readPhysicalId: () => string,
  override = process.env.XDT_DEVICE_ID_OVERRIDE,
  profileDir?: string,
): RuntimeDeviceIdentity {
  const explicit = override?.trim();
  if (explicit) return { deviceId: explicit, source: 'override', hardwareId: null };
  ensureSystemBinPathForMachineId();
  const hardwareId = readPhysicalId();
  const replacement = profileDir ? readReplacementDeviceIdentity(profileDir, hardwareId) : null;
  return replacement
    ? { ...replacement, source: 'replacement', hardwareId }
    : { deviceId: hardwareId, source: 'hardware', hardwareId };
}

export function resolveRuntimeDeviceId(
  readPhysicalId: () => string,
  override = process.env.XDT_DEVICE_ID_OVERRIDE,
  profileDir?: string,
): string {
  return resolveRuntimeDeviceIdentity(readPhysicalId, override, profileDir).deviceId;
}

/**
 * Ensure the system bin directories are on PATH so `node-machine-id`'s bare
 * `ioreg` / `hostnamectl` invocations resolve regardless of how the app was
 * launched. Idempotent; safe to call before `app` is ready. No-op on Windows
 * (registry-based, no PATH dependency).
 */
export function ensureSystemBinPathForMachineId(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const required = ['/usr/sbin', '/sbin'];
  const raw = process.env.PATH ?? '';
  // Membership check only — the Set may include empty segments; that's fine, we
  // only look up the required dirs.
  const present = new Set(raw.split(path.delimiter));
  const missing = required.filter((dir) => !present.has(dir));
  if (missing.length === 0) return;
  // Non-empty PATH: keep it verbatim (including any empty segments, which mean
  // CWD on Unix) and append the missing dirs at the end — no reordering, no
  // dropped segments. Empty/unset PATH: set just the system dirs; we intentionally
  // do not materialise an implicit "" / CWD entry into PATH.
  process.env.PATH = raw === '' ? missing.join(path.delimiter) : [raw, ...missing].join(path.delimiter);
}
