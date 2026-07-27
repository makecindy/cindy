/**
 * deviceId.ts
 * ---------------------------------------------------------------------------
 * Crash-safe resolution of the per-machine device identifier.
 *
 * `node-machine-id`'s `machineIdSync()` runs bare `ioreg` on macOS (and relies on
 * `/usr/sbin:/sbin` on Linux). An app launched from Finder/Dock inherits a minimal
 * PATH — often just `/usr/bin:/bin` — that omits those dirs, so the command isn't
 * found and `machineIdSync()` throws `ioreg: command not found`. When that call sat
 * at module top level it took the whole main process down on launch — the
 * "打开即闪退" (launch → instant crash) reported on packaged 0.1.14.
 *
 * The fix is deliberately small — three moves, no persistence layer:
 *   1. Root cause: put `/usr/sbin:/sbin` on PATH before probing, so bare `ioreg`
 *      resolves and the probe simply succeeds, returning the real, stable id.
 *   2. Lazy: callers resolve on demand (not at import time), so even a probe
 *      failure can never crash startup.
 *   3. Non-fatal fallback: if the probe still fails, return a per-run random id
 *      rather than throwing. deviceId is a non-auth discriminator; on any machine
 *      where the fingerprint resolves it stays stable for free (same value every
 *      launch), so no persistence is needed for the common path.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { machineIdSync } from 'node-machine-id';
import { createLogger } from './logger.js';

const log = createLogger('deviceId');

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
  // Append: only a fallback lookup location, don't shadow earlier PATH entries.
  process.env.PATH = [...current, ...missing].join(path.delimiter);
}

let cached: string | null = null;

/**
 * Resolve the device id: dev override → hardware fingerprint → non-fatal random
 * fallback. Memoised so every call site agrees and the probe runs at most once.
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
    const id = machineIdSync()?.trim();
    if (id) {
      cached = id;
      return cached;
    }
  } catch (err) {
    log.warn(`machineIdSync() failed: ${(err as Error)?.message ?? err}`);
  }

  // Hardware id unavailable — never fatal. A per-run random id keeps the app
  // usable; on any machine where the fingerprint resolves this branch is unused.
  cached = `fallback-${crypto.randomUUID()}`;
  return cached;
}
