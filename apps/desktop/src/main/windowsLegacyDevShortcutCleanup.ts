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
): Promise<string[]> {
  const shortcuts: string[] = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const dirPath = pending.pop()!;
    let entries: ShortcutDirEntry[];
    try {
      entries = await deps.readdir(dirPath);
    } catch {
      // Start Menu may contain protected or concurrently removed directories.
      continue;
    }
    for (const entry of entries) {
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

/**
 * Best-effort cleanup entrypoint. The known SnoreToast shortcut is removed by
 * name; the recursive fallback only removes argumentless links whose resolved
 * target is a development Electron binary.
 */
export async function cleanupLegacyDevShortcuts(
  overrides?: Partial<LegacyDevShortcutCleanupDeps>,
): Promise<void> {
  const deps: LegacyDevShortcutCleanupDeps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== 'win32') return;

  const appData = deps.appDataDir();
  if (!appData) return;

  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let removed = 0;

  const knownShortcut = path.join(startMenuDir, 'XdtMakerDev.lnk');
  try {
    if (await deps.exists(knownShortcut)) {
      await deps.unlink(knownShortcut);
      removed += 1;
    }
  } catch (err) {
    deps.logger?.warn('failed to remove known legacy dev shortcut', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const shortcutPath of await collectShortcutFiles(deps, startMenuDir)) {
    let details: Electron.ShortcutDetails;
    try {
      details = deps.readShortcut(shortcutPath);
    } catch {
      continue;
    }
    if (!isArgumentlessDevElectronShortcut(details)) continue;
    try {
      await deps.unlink(shortcutPath);
      removed += 1;
    } catch (err) {
      deps.logger?.warn('failed to remove scanned legacy dev shortcut', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (removed > 0) {
    deps.logger?.info('legacy dev shortcut cleanup applied', { removed });
  }
}
