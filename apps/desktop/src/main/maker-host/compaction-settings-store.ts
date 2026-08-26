/**
 * compaction-settings-store —— Claude Code 与 Pi 的自动上下文压缩阈值。
 *
 * 文件:
 *   <userData>/compaction-settings.json       { "claudeCodeAutoCompactPct": 75 }
 *   <userData>/pi-compaction-settings.json    { "piAutoCompactPct": 75 }
 *
 * 两个 agent 使用独立 override 文件，恢复其中一个默认值不会覆盖另一个设置；Codex
 * 不读这两份设置。
 *
 * 默认 75 —— 对齐历史自动压缩默认阈值。范围固定 50–95，写入和读取都 clamp + round。
 * 同步 R/W —— 文件极小，Electron main 已是 background，不会卡 renderer 主线程。
 */

import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

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

interface PiCompactionSettings {
  piAutoCompactPct: number;
}

function piSettingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? ownerScopedUserDataPath(), 'pi-compaction-settings.json');
}

function piMigrationMarkerPath(rootPath?: string): string {
  return path.join(rootPath ?? ownerScopedUserDataPath(), 'pi-compaction-migrated.json');
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isReadableJsonObject(filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function readMigratedPiPct(piPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(piPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pct = (parsed as { piAutoCompactPct?: unknown }).piAutoCompactPct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    return clampPct(pct);
  } catch {
    return null;
  }
}

function markPiMigrationDone(ownerRoot: string | null): void {
  const marker = piMigrationMarkerPath(ownerRoot ?? undefined);
  if (isReadableJsonObject(marker)) return;
  writeJsonAtomic(marker, { version: 1 });
}

function normalizePi(raw: unknown): PiCompactionSettings {
  if (!raw || typeof raw !== 'object') {
    return { piAutoCompactPct: DEFAULT_PCT };
  }
  const r = raw as Record<string, unknown>;
  return { piAutoCompactPct: clampPct(r.piAutoCompactPct) };
}

const piStores = new Map<string, ReturnType<typeof createOverrideSettingsFile<PiCompactionSettings>>>();

function migratePiFromLegacyIfNeeded(ownerRoot: string | null): void {
  const marker = piMigrationMarkerPath(ownerRoot ?? undefined);
  if (isReadableJsonObject(marker)) return;
  const piPath = piSettingsFilePath(ownerRoot ?? undefined);
  if (readMigratedPiPct(piPath) !== null) {
    markPiMigrationDone(ownerRoot);
    return;
  }
  const claude = currentStore().readState();
  if (claude.isCustomized) {
    const pct = clampPct(claude.value.claudeCodeAutoCompactPct);
    writeJsonAtomic(piPath, { piAutoCompactPct: pct });
    if (readMigratedPiPct(piPath) === null) {
      log.warn('pi compaction migration wrote an unreadable override; will retry next start', {
        pct,
      });
      return;
    }
    log.info('pi compaction migrated from customized claude setting', { pct });
  }
  markPiMigrationDone(ownerRoot);
}

function currentPiStore() {
  const ownerRoot = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  const key = ownerRoot ?? '<no-session>';
  let store = piStores.get(key);
  if (!store) {
    migratePiFromLegacyIfNeeded(ownerRoot);
    store = createOverrideSettingsFile<PiCompactionSettings>({
      filePath: () => piSettingsFilePath(ownerRoot ?? undefined),
      defaults: { piAutoCompactPct: DEFAULT_PCT },
      normalize: normalizePi,
      log,
      label: 'pi-compaction',
    });
    piStores.set(key, store);
  }
  return store;
}

/** 同步读取 Pi 原生自动压缩百分比。下次 startSession / 恢复任务时读取。 */
export function readPiCompactionPct(): number {
  return currentPiStore().read().piAutoCompactPct;
}

export function readPiCompactionState(): OverrideSettingsState<PiCompactionSettings> {
  return currentPiStore().readState();
}

export function writePiCompactionPct(value: number): void {
  const next: PiCompactionSettings = { piAutoCompactPct: clampPct(value) };
  currentPiStore().writePatch(next);
  log.info('pi compaction setting written', { pct: next.piAutoCompactPct });
}

export function resetPiCompactionPct(): number {
  return currentPiStore().reset().piAutoCompactPct;
}

export const __testing = {
  resetStores(): void {
    stores.clear();
    piStores.clear();
  },
};
