/**
 * The profile root, injected once at startup.
 *
 * Modules that only need "where is userData" must not import `electron` for it:
 * the Node host needs those same modules. Desktop installs its Electron value at
 * startup; the host installs its own before loading storage.
 */

import path from 'node:path';

let configuredUserDataDir: string | null = null;

export function configureUserDataDir(dir: string): void {
  if (!dir) throw new Error('userData directory must not be empty');
  configuredUserDataDir = dir;
}

export function getUserDataDir(): string {
  if (!configuredUserDataDir) {
    throw new Error('userData directory is not configured; call configureUserDataDir() during startup');
  }
  return configuredUserDataDir;
}

export function userDataPath(...parts: string[]): string {
  return path.join(getUserDataDir(), ...parts);
}
