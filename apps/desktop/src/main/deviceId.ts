/**
 * deviceId.ts
 * ---------------------------------------------------------------------------
 * Crash-safe, stable resolution of the per-machine device identifier.
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
 *   1. Ensure the system bin dirs (`/usr/sbin:/sbin`) are on PATH before probing,
 *      so bare `ioreg` resolves regardless of how the app was launched.
 *   2. Never let a fingerprint failure be fatal, and never let a *transient*
 *      failure flip identity. The hardware id is authoritative when available:
 *      we probe first, and cache the resolved id to `userData/device-id`. If a
 *      later launch's probe fails, we reuse that stored id instead of minting a
 *      brand-new one — so a transient failure can't hand the server an unrelated
 *      id (which cold-start refresh would send with the existing token, risking
 *      a definitive rejection and logout). Probing first (rather than trusting
 *      the stored file blindly) also means a `userData` copied/restored onto a
 *      different machine re-derives that machine's own id rather than cloning the
 *      source's — two live installs must not share one server-side (user, device).
 *      Only when hardware can't be identified at all do we mint a persisted UUID,
 *      created exclusively so processes sharing one userData (device-link
 *      double-launch) converge on a single value instead of racing.
 */

import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { machineIdSync } from 'node-machine-id';

const DEVICE_ID_FILENAME = 'device-id';

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

/** Absolute path of the persisted identity file, or null if userData is unavailable. */
function deviceIdFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), DEVICE_ID_FILENAME);
  } catch {
    // userData not available yet (app not ready): caller handles the null.
    return null;
  }
}

function readPersistedDeviceId(file: string): string | null {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || null;
  } catch {
    // Missing / unreadable.
    return null;
  }
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Best-effort cleanup.
  }
}

/** Write `id` to a unique sibling temp file and return its path, or null on failure. */
function writeTempDeviceId(file: string, id: string): string | null {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return null; // userData unwritable.
  }
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, id, 'utf8');
    return tmp;
  } catch {
    safeUnlink(tmp);
    return null;
  }
}

/**
 * Overwrite the stored identity with `id` atomically (temp file + rename). Used
 * to keep the stored copy in sync with the current hardware id — including when
 * userData was copied from another machine. Concurrent writers all write the
 * same hardware id, so a last-writer-wins rename is harmless. Best-effort.
 */
function writeDeviceIdAtomic(file: string, id: string): void {
  const tmp = writeTempDeviceId(file, id);
  if (!tmp) return;
  try {
    fs.renameSync(tmp, file); // Atomic replace; consumes tmp.
  } catch {
    safeUnlink(tmp);
  }
}

/**
 * Create the stored identity only if none exists yet, atomically, so racing
 * processes converge on one value.
 *
 * We write the full contents to a temp file first, then `link()` it into place.
 * `link()` is atomic and fails with EEXIST if the target already exists, giving
 * exclusive create — and because the temp is fully written before linking, the
 * target is never observable half-written / empty. So a racer that loses
 * (EEXIST) is guaranteed to read the winner's complete value rather than an
 * empty string. (A plain `writeFileSync(…, 'wx')` creates the entry before
 * writing bytes, leaving exactly that empty-read window.)
 *
 * Returns the id that is authoritative on disk after the call.
 */
function createDeviceIdExclusive(file: string, id: string): string {
  const tmp = writeTempDeviceId(file, id);
  if (!tmp) return id; // userData unwritable: keep the in-memory id.
  try {
    fs.linkSync(tmp, file);
    return id; // We won the race (or were unopposed).
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      // Another process already published the identity. Because publishing is
      // atomic, the file already holds a complete value — use it.
      return readPersistedDeviceId(file) ?? id;
    }
    // Unexpected link failure: keep the in-memory id.
    return id;
  } finally {
    safeUnlink(tmp);
  }
}

/**
 * Persist `id` once the app is ready. Used only when userData was unavailable at
 * resolve time (extremely early startup): this run already committed to `id` in
 * memory, but persisting now makes future launches stable. Best-effort.
 */
function deferPersistWhenReady(id: string): void {
  const whenReady = (app as { whenReady?: () => Promise<void> }).whenReady;
  if (typeof whenReady !== 'function') return;
  whenReady
    .call(app)
    .then(() => {
      const file = deviceIdFilePath();
      if (file) createDeviceIdExclusive(file, id);
    })
    .catch(() => {
      // Best-effort only; a failure here just means we retry next launch.
    });
}

let cached: string | null = null;

/** Probe the hardware id, returning a non-empty trimmed value or null on any failure. */
function probeHardwareId(): string | null {
  ensureSystemBinPathForMachineId();
  try {
    const probed = machineIdSync()?.trim();
    // Treat an empty/whitespace result as a failure: persisting "" would hand
    // out a blank device id and never stabilise (blank reads back as null).
    return probed || null;
  } catch (err) {
    process.stderr.write(
      `[cindy] machineIdSync() failed (${(err as Error)?.message ?? err})\n`,
    );
    return null;
  }
}

/**
 * Resolve the device id, honouring the `XDT_DEVICE_ID_OVERRIDE` dev override,
 * then the live hardware probe (authoritative when available), then the last
 * stored id (reused only when the probe fails), then a freshly minted UUID
 * fallback. Result is memoised so every call site in the process agrees on one
 * id, and so the persistent-storage side effect happens at most once per process.
 */
export function resolveDeviceId(): string {
  if (cached) return cached;

  const override = process.env.XDT_DEVICE_ID_OVERRIDE?.trim();
  if (override) {
    cached = override;
    return cached;
  }

  const file = deviceIdFilePath();
  const hardwareId = probeHardwareId();

  if (hardwareId) {
    // Hardware id wins. Keep the stored copy in sync (so a later probe *failure*
    // reuses this exact id, and so a userData copied here is re-pinned to this
    // machine) — but only rewrite when it actually changed.
    if (file && readPersistedDeviceId(file) !== hardwareId) {
      writeDeviceIdAtomic(file, hardwareId);
    }
    cached = hardwareId;
    return cached;
  }

  // Probe failed: prefer the last successfully stored id so a transient failure
  // doesn't churn identity or log the user out.
  if (file) {
    const persisted = readPersistedDeviceId(file);
    if (persisted) {
      cached = persisted;
      return cached;
    }
  }

  // Hardware can't be identified and nothing is stored yet: mint a stable
  // fallback, created exclusively so concurrent first launches converge.
  const fallback = `fallback-${crypto.randomUUID()}`;
  if (file) {
    cached = createDeviceIdExclusive(file, fallback);
  } else {
    // userData wasn't available this early — commit now, persist when ready.
    cached = fallback;
    deferPersistWhenReady(fallback);
  }
  return cached;
}
