/**
 * 终端默认 shell 偏好的 main 进程持久化（electron-store 后端）。
 *
 * 跟 `sidebarSettingsStore.ts` 同款 pattern：单独 JSON 文件（`userData/terminal-prefs.json`），
 * 跨 dev (http://localhost) / installed (file://) 共享。
 *
 * 设计取舍：不走 Drizzle 表，因为这是单值偏好，不值得跑 migration；电池容量小、
 * 启动开销也小。如果未来加更多终端偏好（per-tab 设置等）再统一迁过去。
 */

import Store from 'electron-store';
import { app } from 'electron';
import path from 'node:path';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { inspectSettingsFile, validateOptionalSettingsFields } from '../maker-host/settings-inspection.js';
import { createLogger } from '../logger.js';

import type { ShellId } from './shellResolver.js';

interface TerminalPrefsShape {
  /** 'auto' = 走 resolveAutoDetectShell；具体 id = 锁定该 shell（不可用时仍 fallback auto） */
  defaultShellPref: ShellId;
}

const VALID_SHELL_IDS: ReadonlySet<ShellId> = new Set<ShellId>([
  'auto',
  'zsh',
  'bash',
  'fish',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
]);

let storeInstance: Store<TerminalPrefsShape> | null = null;

function getStore(): Store<TerminalPrefsShape> {
  if (!storeInstance) {
    storeInstance = new Store<TerminalPrefsShape>({
      name: 'terminal-prefs',
      defaults: { defaultShellPref: 'auto' },
      schema: {
        defaultShellPref: { type: 'string' },
      },
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export function getDefaultShellPref(): ShellId {
  const raw = getStore().get('defaultShellPref', 'auto');
  return VALID_SHELL_IDS.has(raw as ShellId) ? (raw as ShellId) : 'auto';
}

export function setDefaultShellPref(value: ShellId): void {
  if (!VALID_SHELL_IDS.has(value)) {
    throw new Error(`invalid shell id: ${value}`);
  }
  getStore().set('defaultShellPref', value);
}

// ── Cloud settings (cloud instances only) ──────────────────────────────────
/** 不实例化 electron-store：其 defaults/clearInvalidConfig 分支可能写盘。 */
export function inspectTerminalPrefs() {
  return inspectSettingsFile<TerminalPrefsShape>({
    filePath: () => path.join(app.getPath('userData'), 'terminal-prefs.json'),
    defaults: { defaultShellPref: 'auto' },
    normalize: (raw) => ({ defaultShellPref: (raw as TerminalPrefsShape).defaultShellPref }),
    savedSource: 'unknown',
    validate: (raw) => validateOptionalSettingsFields(raw, {
      defaultShellPref: (value) => VALID_SHELL_IDS.has(value as ShellId),
    }),
  });
}
/** Revision-checked cloud commits on the same file; electron-store re-reads it on each access. */
const cloudStore = createOverrideSettingsFile<TerminalPrefsShape>({
  filePath: () => path.join(app.getPath('userData'), 'terminal-prefs.json'),
  defaults: { defaultShellPref: 'auto' },
  normalize: raw => ({ defaultShellPref: VALID_SHELL_IDS.has((raw as TerminalPrefsShape).defaultShellPref) ? (raw as TerminalPrefsShape).defaultShellPref : 'auto' }),
  validateOverrides: raw => validateOptionalSettingsFields(raw, { defaultShellPref: value => VALID_SHELL_IDS.has(value as ShellId) }),
  preserveUnreadableFile: true, log: createLogger('terminal-prefs'), label: 'terminal-prefs',
});
export function getTerminalSettingsStore() { return cloudStore; }
