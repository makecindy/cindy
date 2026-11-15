/**
 * Claude Code flag settings delivery.
 *
 * The Agent SDK turns an inline settings object into one `--settings <json>`
 * command-line argument (see its `initialize()` / `qx()`). Windows CreateProcess
 * rejects a command line longer than 32767 characters with `spawn ENAMETOOLONG`,
 * so a catalog of roughly a thousand model ids (issue #9753) fails the session
 * before it starts. The same option also accepts a path to a settings JSON file,
 * which stays a few hundred characters no matter how long the catalog is.
 *
 * The file holds the same object `buildClaudeFlagSettings` already produced
 * (apiKeyHelper override, attribution, allowlist). It contains no credentials:
 * `buildSettings()` never copies auth env into the settings object, and the guest
 * route token stays on the child-process env (`ANTHROPIC_CUSTOM_HEADERS`), which the
 * SDK passes to the CLI as its environment and never writes here. Mode 0600 is not
 * treated as a credential boundary.
 * Remote cc-mgr sessions stay on the inline object: the daemon reads settings on
 * its own machine, and a path written here would not exist there. That inline object
 * is the same credential-free settings value; the route token still rides the remote
 * session env, not settings.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Settings } from '@anthropic-ai/claude-agent-sdk';

/** Inline JSON plus the `--settings` flag itself, under the 32767 Windows cap. */
export const CLAUDE_INLINE_SETTINGS_ARGV_BUDGET = 24_000;

export type ClaudeFlagSettingsDelivery =
  | { kind: 'inline'; settings: Settings }
  | { kind: 'file'; settingsPath: string; dispose: () => Promise<void> };

/** How many characters the SDK will spend on `--settings` plus its JSON value. */
export function claudeInlineSettingsArgvLength(settings: Settings): number {
  return '--settings'.length + 1 + JSON.stringify(settings).length;
}

export async function materializeClaudeFlagSettings(
  settings: Settings,
  reuse?: Extract<ClaudeFlagSettingsDelivery, { kind: 'file' }>,
): Promise<ClaudeFlagSettingsDelivery> {
  if (claudeInlineSettingsArgvLength(settings) <= CLAUDE_INLINE_SETTINGS_ARGV_BUDGET) {
    return { kind: 'inline', settings };
  }
  if (reuse) {
    await fs.writeFile(reuse.settingsPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
    return reuse;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-claude-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // mkdtemp 已经建好目录, 写入失败 (ENOSPC / EIO) 时调用方还没拿到 disposer,
    // 启动失败和关闭路径都回收不到它 —— 在这里尽力删掉再抛原始错误。
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    kind: 'file',
    settingsPath,
    dispose: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
