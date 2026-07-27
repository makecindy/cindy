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

import path from 'node:path';

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
