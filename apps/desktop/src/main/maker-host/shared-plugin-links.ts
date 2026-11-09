import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Account home prefix produced by `accountDirectory()` for non-default
 * subscription accounts: `.claude-cindy-<owner digest>-<uuid>`.
 */
const ACCOUNT_HOME_PREFIX = '.claude-cindy-';

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share the machine's Claude Code plugins with extra subscription accounts.
 *
 * `claude plugin list` reads only `<CLAUDE_CONFIG_DIR>/plugins`, so every
 * non-default account (whose CLAUDE_CONFIG_DIR points at its own home) starts
 * with an empty plugin list even though plugins are a machine-level capability.
 * Linking the default account's `plugins` into each account home that has none
 * makes those plugins loadable there again.
 *
 * An account home that already owns a `plugins` entry is left untouched — it
 * may hold a different plugin set, and silently replacing it would drop what
 * that account installed.
 */
export async function prepareSharedPluginLinks(homeDir = os.homedir()): Promise<void> {
  const defaultPlugins = path.join(homeDir, '.claude', 'plugins');
  // Nothing installed on the default account: no source to share.
  if (!(await isDirectory(defaultPlugins))) return;

  let names: string[];
  try {
    names = await fs.readdir(homeDir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.startsWith(ACCOUNT_HOME_PREFIX)) continue;
    const accountPlugins = path.join(homeDir, name, 'plugins');
    if (await exists(accountPlugins)) continue;
    try {
      await fs.symlink(
        defaultPlugins,
        accountPlugins,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      // Concurrent creation or a permissions problem: the next preparation
      // retries, and a missing link only costs plugin visibility.
    }
  }
}
