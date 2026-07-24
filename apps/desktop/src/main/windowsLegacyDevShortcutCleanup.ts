/**
 * Removes legacy development shortcuts that launch Electron without app args.
 *
 * This runs during Windows startup before notifications are initialized. Keep
 * it free of script hosts: spawning PowerShell here is both unnecessary
 * (Electron can read `.lnk` files itself) and prone to security-product alerts.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createLogger } from './logger';

const log = createLogger('legacyDevShortcutCleanup');
const CLEANUP_TIMEOUT_MS = 8_000;

interface ShortcutDirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface LegacyDevShortcutCleanupDeps {
  platform: NodeJS.Platform;
  appDataDir: () => string | null;
  exists: (filePath: string) => Promise<boolean>;
  readdir: (dirPath: string) => Promise<ShortcutDirEntry[]>;
  unlink: (filePath: string) => Promise<void>;
  readShortcut: (filePath: string) => Electron.ShortcutDetails;
  logger?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;
}

function defaultDeps(): LegacyDevShortcutCleanupDeps {
  return {
    platform: process.platform,
    appDataDir: () => {
      try {
        return app.getPath('appData');
      } catch {
        return null;
      }
    },
    exists: async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
    unlink: (filePath) => fs.unlink(filePath),
    readShortcut: (filePath) => shell.readShortcutLink(filePath),
    logger: log,
  };
}

async function collectShortcutFiles(
  deps: LegacyDevShortcutCleanupDeps,
  rootDir: string,
  shouldStop: () => boolean,
): Promise<string[]> {
  const shortcuts: string[] = [];
  const pending = [rootDir];

  while (pending.length > 0 && !shouldStop()) {
    const dirPath = pending.pop()!;
    let entries: ShortcutDirEntry[];
    try {
      entries = await deps.readdir(dirPath);
    } catch {
      // Start Menu may contain protected or concurrently removed directories.
      continue;
    }
    if (shouldStop()) break;
    for (const entry of entries) {
      if (shouldStop()) break;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lnk') {
        shortcuts.push(entryPath);
      }
    }
  }

  return shortcuts;
}

function isArgumentlessDevElectronShortcut(details: Electron.ShortcutDetails): boolean {
  if (typeof details.target !== 'string' || details.target.length === 0) return false;
  const target = details.target.replace(/\//g, '\\').toLowerCase();
  return target.endsWith('\\node_modules\\electron\\dist\\electron.exe') && !details.args;
}

async function runCleanup(
  deps: LegacyDevShortcutCleanupDeps,
  appData: string,
  shouldStop: () => boolean,
): Promise<void> {
  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let removed = 0;

  if (shouldStop()) return;
  const knownShortcut = path.join(startMenuDir, 'XdtMakerDev.lnk');
  try {
    const exists = await deps.exists(knownShortcut);
    if (shouldStop()) return;
    if (exists) {
      await deps.unlink(knownShortcut);
      if (shouldStop()) return;
      removed += 1;
    }
  } catch (err) {
    deps.logger?.warn('failed to remove known legacy dev shortcut', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (shouldStop()) return;
  const shortcutFiles = await collectShortcutFiles(deps, startMenuDir, shouldStop);
  if (shouldStop()) return;
  for (const shortcutPath of shortcutFiles) {
    if (shouldStop()) return;
    let details: Electron.ShortcutDetails;
    try {
      details = deps.readShortcut(shortcutPath);
    } catch {
      continue;
    }
    // readShortcutLink is synchronous, so also compare the wall-clock deadline
    // after each call; a busy main thread cannot rely on the timer firing first.
    if (shouldStop()) return;
    if (!isArgumentlessDevElectronShortcut(details)) continue;
    try {
      await deps.unlink(shortcutPath);
      if (shouldStop()) return;
      removed += 1;
    } catch (err) {
      deps.logger?.warn('failed to remove scanned legacy dev shortcut', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (shouldStop()) return;
  if (removed > 0) {
    deps.logger?.info('legacy dev shortcut cleanup applied', { removed });
  }
}

/**
 * Best-effort cleanup entrypoint. The known SnoreToast shortcut is removed by
 * name; the recursive fallback only removes argumentless links whose resolved
 * target is a development Electron binary. Slow or redirected Start Menu
 * storage must not delay the rest of application startup.
 */
export async function cleanupLegacyDevShortcuts(
  overrides?: Partial<LegacyDevShortcutCleanupDeps>,
): Promise<void> {
  const deps: LegacyDevShortcutCleanupDeps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== 'win32') return;

  const appData = deps.appDataDir();
  if (!appData) return;

  const deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
  let expired = false;
  const expire = (): void => {
    if (expired) return;
    expired = true;
    deps.logger?.warn('legacy dev shortcut cleanup timed out; continuing startup', {
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
  };
  const shouldStop = (): boolean => {
    if (!expired && Date.now() >= deadlineAt) expire();
    return expired;
  };
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      expire();
      resolve();
    }, CLEANUP_TIMEOUT_MS);
  });

  try {
    await Promise.race([runCleanup(deps, appData, shouldStop), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
