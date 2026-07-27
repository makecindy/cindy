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
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing = required.filter((dir) => !current.includes(dir));
  if (missing.length === 0) return;
  // Append: only a fallback lookup location, don't shadow earlier PATH entries.
  process.env.PATH = [...current, ...missing].join(path.delimiter);
}
