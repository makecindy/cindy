/**
 * deviceId.ts
 * ---------------------------------------------------------------------------
 * Crash-safe resolution of the per-machine device identifier.
 *
 * `node-machine-id`'s `machineIdSync()` shells out to platform tools that live
 * outside the default GUI PATH: on macOS it runs bare `ioreg`
 * (`/usr/sbin/ioreg`), on Linux it reads `/var/lib/dbus/machine-id` but can fall
 * back to tools in `/usr/sbin:/sbin`. An app launched from Finder/Dock (rather
 * than a login shell) inherits a minimal PATH — typically just `/usr/bin:/bin` —
 * so the bare command is not found and `machineIdSync()` throws
 * `ioreg: command not found`.
 *
 * Historically this call sat at module top level, so the throw took the entire
 * main process down before any window appeared — the "打开即闪退" (launch → instant
 * crash) reported on packaged 0.1.14. This module hardens the call two ways:
 *
 *   1. Prepend the system bin dirs (`/usr/sbin:/sbin`) to PATH before probing,
 *      so bare `ioreg` resolves regardless of how the app was launched.
 *   2. Never let a fingerprint failure be fatal — fall back to a UUID persisted
 *      under userData, so the id is stable across restarts (a fresh random id
 *      each launch would churn the server-side (user, device) registration).
 */

import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { machineIdSync } from 'node-machine-id';

/**
 * Ensure the system bin directories are on PATH so `node-machine-id`'s bare
 * `ioreg` / `hostnamectl` invocations resolve. Idempotent; safe to call before
 * `app` is ready. No-op on Windows (registry-based, no PATH dependency).
 */
export function ensureSystemBinPathForMachineId(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const required = ['/usr/sbin', '/sbin'];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing = required.filter((dir) => !current.includes(dir));
  if (missing.length === 0) return;
  // Append (not prepend): we only want these as a fallback lookup location, not
  // to shadow user-provided tool locations earlier on PATH.
  process.env.PATH = [...current, ...missing].join(path.delimiter);
}

/**
 * Stable per-install id used only when the hardware fingerprint is unavailable.
 * Persisted under userData so it survives restarts. Falls back to an ephemeral
 * id if userData is unwritable — keeping the app alive is the priority.
 */
function persistedFallbackDeviceId(): string {
  const generate = () => `fallback-${crypto.randomUUID()}`;

  let file: string;
  try {
    file = path.join(app.getPath('userData'), 'device-id-fallback');
  } catch {
    // userData path unavailable (e.g. app not ready): last-resort ephemeral id.
    return generate();
  }

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Missing / unreadable — fall through to generate and persist a fresh one.
  }

  const generated = generate();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, 'utf8');
  } catch {
    // userData unwritable (rare): keep the ephemeral id so the app still launches.
  }
  return generated;
}

let cached: string | null = null;

/**
 * Resolve the device id, honouring the `XDT_DEVICE_ID_OVERRIDE` dev override,
 * then the hardware fingerprint, then a persisted UUID fallback. Result is
 * memoised so every call site in the process agrees on one id.
 */
export function resolveDeviceId(): string {
  if (cached) return cached;

  const override = process.env.XDT_DEVICE_ID_OVERRIDE?.trim();
  if (override) {
    cached = override;
    return cached;
  }

  ensureSystemBinPathForMachineId();
  try {
    cached = machineIdSync();
  } catch (err) {
    process.stderr.write(
      `[cindy] machineIdSync() failed (${(err as Error)?.message ?? err}); ` +
        'falling back to persisted device id\n',
    );
    cached = persistedFallbackDeviceId();
  }
  return cached;
}
