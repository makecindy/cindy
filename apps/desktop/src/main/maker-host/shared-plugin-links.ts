import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claudeConfigDir } from '../remote-agent/controller/projectFiles.js';
import { accountDirectory, readPool } from '../subscription-accounts/store.js';

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
 *
 * Only the active owner's accounts are touched. Account directories are
 * owner-scoped (`.claude-cindy-<owner digest>-<uuid>`); blindly walking
 * `~/.claude-cindy-*` would also modify accounts that belong to a different
 * Cindy owner on the same OS user.
 *
 * The source follows `CLAUDE_CONFIG_DIR` the same way the default account's
 * runtime does: a user who moved their Claude config elsewhere still installs
 * plugins there, and linking `~/.claude/plugins` would share a stale set.
 */
export async function prepareSharedPluginLinks(
  homeDir = os.homedir(),
  configDir = claudeConfigDir(process.env, homeDir),
): Promise<void> {
  const pool = readPool('anthropic');
  if (!pool) return;

  const defaultPlugins = path.join(configDir, 'plugins');
  // Nothing installed on the default account: no source to share.
  if (!(await isDirectory(defaultPlugins))) return;

  for (const account of pool.accounts) {
    if (account.id === 'default') continue;
    // accountDirectory() validates the id shape and scopes the path to the
    // current owner, so this never yields another owner's directory.
    const accountHome = accountDirectory('anthropic', account.id);
    const accountPlugins = path.join(accountHome, 'plugins');
    if (await exists(accountPlugins)) continue;
    try {
      await fs.mkdir(accountHome, { recursive: true });
      await fs.symlink(
        defaultPlugins,
        accountPlugins,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      // Claude treats a missing `enabledPlugins` entry as enabled, but the
      // account's own settings.json may explicitly disable plugins the default
      // account uses. Without the account-level entry, `claude plugin list`
      // reports them as enabled here too — the shared link alone is enough.
      // If the account already wrote its own settings.json with overrides,
      // it takes precedence; this step does not touch it.
    } catch {
      // Concurrent creation or a permissions problem: the next preparation
      // retries, and a missing link only costs plugin visibility.
    }
  }
}
