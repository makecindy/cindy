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

// Machine-wide shared resources (e.g. native Skill locks) must stay outside a
// profile. Each launcher injects the OS app-data directory independently.
let configuredAppDataDir: string | null = null;
export function configureAppDataDir(dir: string): void {
  if (!dir || !path.isAbsolute(dir)) throw new Error('appData must be an absolute directory');
  configuredAppDataDir = dir;
}
export function getAppDataDir(): string {
  if (!configuredAppDataDir) throw new Error('appData directory is not configured');
  return configuredAppDataDir;
}
