/**
 * memory-settings-store —— 三个 memory 开关的 main 端持久化 source of truth。
 *
 * 背景:
 *  - Codex 的 enable 走 app-server in-memory enablement (重启即失效)
 *  - Claude 的 enable 走 BaseAgent.memoryOverride (内存字段)
 *  - Maker 的 enable 走 MakerMemoryManager.enabled (内存字段)
 *  三者都不持久化, 重启后用户上次设置丢失 → 这里收口落 JSON。
 *
 * 文件: <userData>/memory-settings.json
 *   { "maker": true, "claudeCode": true, "codex": true }
 *
 * 默认值跟原 runtime-configs.ts / maker-memory-host.ts 的硬编码对齐:
 *  - maker      : true (默认开启，用户可以关闭)
 *  - claudeCode : true  (Claude SDK autoMemoryEnabled 默认 true, host 跟随)
 *  - codex      : true  (host 强制开 to match Claude — 跟原 runtime-configs.ts:95 一致)
 *
 * 同步 R/W —— 文件小 (< 100B), Electron main 已是 background, 不会卡 UI 主线程。
 * read 失败 (corrupt JSON / 文件不存在) → 走默认值, 同时清掉坏文件避免反复报错。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('memory-settings-store');

export interface MemorySettings {
  maker: boolean;
  claudeCode: boolean;
  codex: boolean;
}

const DEFAULTS: MemorySettings = {
  maker: true,
  claudeCode: true,
  codex: true,
};

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'memory-settings.json');
}

function normalize(raw: unknown): MemorySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    maker: typeof r.maker === 'boolean' ? r.maker : DEFAULTS.maker,
    claudeCode: typeof r.claudeCode === 'boolean' ? r.claudeCode : DEFAULTS.claudeCode,
    codex: typeof r.codex === 'boolean' ? r.codex : DEFAULTS.codex,
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<MemorySettings>>>();

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<MemorySettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'memory',
    });
    stores.set(key, current);
  }
  return current;
}

/**
 * 同步读取持久化设置. 第一次调用时从磁盘读, 后续调用走内存 cache.
 * IPC handler / runtime-configs.ts module load 都直接用同步读, 不引入 async race。
 */
export function readMemorySettings(options?: { rootPath?: string }): MemorySettings {
  return currentStore(options?.rootPath).read();
}

export function readMemorySettingsState(): OverrideSettingsState<MemorySettings> {
  return currentStore().readState();
}

/**
 * 写一个字段, 落盘 + 更新 cache. 失败抛错让 IPC handler 反馈给 UI。
 */
export function writeMemorySetting<K extends keyof MemorySettings>(
  key: K,
  value: MemorySettings[K],
  options?: { preserveDefault?: boolean },
): OverrideSettingsState<MemorySettings> {
  currentStore().writePatch({ [key]: value } as Partial<MemorySettings>, {
    preserveDefaults: options?.preserveDefault === true,
  });
  log.info('memory setting written', { key, value });
  return currentStore().readState();
}

/**
 * 把旧版任一入口明确关闭记忆的用户意图迁成新默认下的 `maker:false` override。
 *
 * 旧默认值为 false 时，renderer localStorage 的 Maker 专属 marker 最精确；缺失时
 * 已持久化的任一 native false 是保留旧 opt-out 的可用证据。
 *
 * `legacyRendererValue=null` 表示旧 renderer marker 缺失；此时若存在 native false
 * 则迁移为 Maker false。marker=true 表示用户曾明确开启 Maker，迁移时保留这个显式 opt-in。
 * 已存在 maker override 时始终保持 main 端事实源。
 */
export function preserveLegacyMakerMemoryDisabled(
  legacyRendererValue: boolean | null,
): MemorySettings {
  const state = currentStore().readState();
  if (state.customizedKeys.includes('maker')) return state.value;
  if (legacyRendererValue === true) {
    // The new default is true, so keep an explicit legacy opt-in durable.
    return writeMemorySetting('maker', true, { preserveDefault: true }).value;
  }
  if (legacyRendererValue === false) {
    return writeMemorySetting('maker', false).value;
  }
  return state.value;
}

export function resetMemorySettings(): MemorySettings {
  return currentStore().reset();
}
