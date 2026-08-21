/**
 * compaction-settings-store —— Claude Code 与 Pi 共用的自动上下文压缩阈值。
 *
 * 文件: <userData>/compaction-settings.json
 *   { "claudeCodeAutoCompactPct": 75 }
 * 字段名保留历史 key，避免用户已调过的阈值丢失；Codex 不读这份设置。
 *
 * 默认 75 —— 对齐历史自动压缩默认阈值。范围固定 50–95,
 * 写入和读取都 clamp + round, 确保注入 runtimeConfig.autoCompactThresholdPct 始终是合法整数百分比。
 *
 * 同步 R/W —— 文件极小, Electron main 已是 background, 不会卡 renderer 主线程。
 * read 失败 (corrupt JSON / 文件不存在) → 走默认值, 同时清掉坏文件避免反复报错。
 */

import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('compaction-settings-store');

const MIN_PCT = 50;
const MAX_PCT = 95;
const DEFAULT_PCT = 75;

interface CompactionSettings {
  claudeCodeAutoCompactPct: number;
}

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? ownerScopedUserDataPath(), 'compaction-settings.json');
}

function clampPct(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PCT;
  return Math.min(MAX_PCT, Math.max(MIN_PCT, Math.round(value)));
}

function normalize(raw: unknown): CompactionSettings {
  if (!raw || typeof raw !== 'object') {
    return { claudeCodeAutoCompactPct: DEFAULT_PCT };
  }
  const r = raw as Record<string, unknown>;
  return {
    claudeCodeAutoCompactPct: clampPct(r.claudeCodeAutoCompactPct),
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<CompactionSettings>>>();

function currentStore() {
  const ownerRoot = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  const key = ownerRoot ?? '<no-session>';
  let store = stores.get(key);
  if (!store) {
    store = createOverrideSettingsFile<CompactionSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: { claudeCodeAutoCompactPct: DEFAULT_PCT },
      normalize,
      log,
      label: 'compaction',
    });
    stores.set(key, store);
  }
  return store;
}

/** 同步读取 Claude Code 自动压缩百分比。第一次从磁盘读, 后续走内存 cache。 */
export function readCompactionPct(): number {
  return currentStore().read().claudeCodeAutoCompactPct;
}

export function readCompactionState(): OverrideSettingsState<CompactionSettings> {
  return currentStore().readState();
}

/** 写入 Claude Code 自动压缩百分比, 落盘 + 更新 cache。 */
export function writeCompactionPct(value: number): void {
  const next: CompactionSettings = {
    claudeCodeAutoCompactPct: clampPct(value),
  };
  currentStore().writePatch(next);
  log.info('compaction setting written', { pct: next.claudeCodeAutoCompactPct });
}

export function resetCompactionPct(): number {
  return currentStore().reset().claudeCodeAutoCompactPct;
}
