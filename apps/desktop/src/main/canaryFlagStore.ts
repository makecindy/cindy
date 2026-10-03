/**
 * canaryFlagStore.ts
 * ---------------------------------------------------------------------------
 * canary-release V0.1
 *
 * Persists the per-user "isCanary" flag locally so manifestService (which runs
 * on the background poll, *before* renderer mounts and even before login on a
 * fresh install) can decide which manifest URL to fetch from CDN.
 *
 * Storage: plain JSON file at userData/canary-flag.json. The flag is not
 * sensitive — it just toggles between two public CDN URLs — so we don't bother
 * with safeStorage encryption. Plain file also means the value survives
 * safeStorage being unavailable (rare edge case on Linux without keyring).
 *
 * Lifecycle(2026-07 起):
 *   - 登录 / 冷启动恢复 / 运行时换账号后从 oauth-broker 的
 *     `/api/user/feature-flags` 读取 isCanary 并 sync 到本地;
 *   - 接口失败或响应非法时保留旧值，避免瞬时故障把灰度用户静默降级;
 *   - 登出时 clear，避免未登录或下一账号继承当前账号的发布通道;
 *   - Read by manifestService.fetchManifest() to switch URL between
 *     manifest-{platform}.json and manifest-{platform}-canary.json
 *
 * Why not a module-level variable: the background update poll fires before
 * authManager.initialize() resolves on cold start, so we need a value that
 * survives across launches.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { createLogger } from './logger';

const log = createLogger('canaryFlagStore');

const FLAG_FILE = 'canary-flag.json';

// A credential-store failure can leave another saved account's flag on disk
// while the user explicitly starts a process-only session. Keep that session
// on the neutral stable channel without overwriting the saved account's flag.
// The override intentionally survives an in-process logout and disappears on
// process exit; a later durable login clears it before syncing its own flag.
let processOverride: boolean | null = null;

function getFlagPath(): string {
  return path.join(app.getPath('userData'), FLAG_FILE);
}

/**
 * Returns true iff the local flag file exists and contains `{ canary: true }`.
 * Any I/O error or malformed payload → false (fail-safe to stable channel).
 */
export function read(): boolean {
  if (processOverride !== null) return processOverride;
  try {
    const raw = fs.readFileSync(getFlagPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { canary?: unknown };
    return parsed.canary === true;
  } catch {
    return false;
  }
}

/** Override reads for this process without changing the persisted account flag. */
export function setProcessOverride(value: boolean | null): void {
  processOverride = value;
}

export function write(): void {
  try {
    fs.writeFileSync(getFlagPath(), JSON.stringify({ canary: true }));
  } catch (err) {
    log.error('write failed:', err);
  }
}

export function clear(): void {
  try {
    fs.unlinkSync(getFlagPath());
  } catch {
    // ENOENT is fine — flag was never written or already gone
  }
}

/**
 * Convenience: sync local flag to a desired value in one call.
 * authManager 仅在 feature-flags 请求成功且身份仍匹配时调用。
 */
export function sync(isCanary: boolean): void {
  if (isCanary) write();
  else clear();
}
