import { inspectSettingsJson, isSettingsRecord } from '../maker-host/inspect-settings-json.js';
import { validateOptionalSettingsFields } from '../maker-host/settings-inspection.js';
import path from 'node:path';
/**
 * cindyPrefsStore —— cindy 槽的用户级隐藏配置(在途并发上限)。
 *
 * File: <userData>/ghost-cindy-prefs.json
 *
 * 形态:{ inflightLimits: { <ghostId>: <正整数并发上限> } }
 * - inflightLimits:该插件同时能跑几单 cindy 代办(隐藏配置层级,无
 *   Settings UI,直接改文件或让 agent 改);缺项 = 不限并发(系统默认);
 * - 抽离插件**不**清配置——与布局位置"重新注入原位复活"同语义。
 *
 * 旧版这里还有 `overrides`(插件详情「Cindy 能力」逐项钉的模型)。2026-10 起
 * 插件只有一个「模型」字段,存在 pluginTaskPrefsStore;旧 `overrides` 只留给
 * 一次性迁移读取(见 readLegacyOneshotPins / clearLegacyOverrides),迁移后
 * 从文件里删掉该键。旧版本回退读到缺键视为无覆盖,不会判损坏。
 */

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { assertGhostPrefsWritable, relocateGhostPreferenceMaps } from './ghostPreferenceRelocation.js';

const log = desktopMakerLogger.child('cindy-prefs-store');

export const GHOST_CINDY_PREFS_FILE = 'ghost-cindy-prefs.json';

export async function relocateGhostCindyPrefs(from: string, to: string): Promise<void> {
  // 尚未迁移的旧 overrides 跟着一起搬,迁移时才能落到正确的插件身份上。
  await relocateGhostPreferenceMaps(GHOST_CINDY_PREFS_FILE, ['overrides', 'inflightLimits'], from, to, () => {
    store = createStore();
  });
}

interface GhostCindyPrefs {
  /** ghostId → 在途代办并发上限(正整数;缺项 = 不限并发)。 */
  inflightLimits: Record<string, number>;
  /**
   * 旧版逐能力钉档里的快问快答钉值(ghostId → 原始字符串),只供一次性迁移;
   * 其它能力键(图像/视频/向量)不再有消费者,读取时直接忽略。
   */
  overrides?: Record<string, { 'text.oneshot'?: string }>;
}

const DEFAULTS: GhostCindyPrefs = { inflightLimits: {} };

function normalize(raw: unknown): GhostCindyPrefs {
  if (!raw || typeof raw !== 'object') return { inflightLimits: {} };
  // 并发上限:只收正整数,其它形态(0/负数/小数/字符串)一律丢弃 = 回到不限。
  const limitsRaw = (raw as { inflightLimits?: unknown }).inflightLimits;
  const inflightLimits: GhostCindyPrefs['inflightLimits'] = {};
  if (limitsRaw && typeof limitsRaw === 'object') {
    for (const [ghostId, v] of Object.entries(limitsRaw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1) inflightLimits[ghostId] = v;
    }
  }
  const overridesRaw = (raw as { overrides?: unknown }).overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object') return { inflightLimits };
  const overrides: NonNullable<GhostCindyPrefs['overrides']> = {};
  for (const [ghostId, capsRaw] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (!capsRaw || typeof capsRaw !== 'object') continue;
    const pin = (capsRaw as Record<string, unknown>)['text.oneshot'];
    overrides[ghostId] = typeof pin === 'string' && pin.length > 0 ? { 'text.oneshot': pin } : {};
  }
  return { inflightLimits, overrides };
}

function createStore() {
  return createOverrideSettingsFile<GhostCindyPrefs>({
    filePath: () => ownerScopedUserDataPath(GHOST_CINDY_PREFS_FILE),
    defaults: DEFAULTS,
    normalize,
    log,
    label: 'ghost-cindy-prefs',
    preserveUnreadableFile: true,
  });
}

let store = createStore();

/** Host-managed preference records only; does not load Ghosts or arbitrary plugin KV. */
export function inspectGhostCindyPrefs(root: string) {
  return inspectSettingsJson(path.join(root, 'ghost-cindy-prefs.json'), raw => {
    validateOptionalSettingsFields(raw, { overrides: isSettingsRecord, inflightLimits: isSettingsRecord });
    if (isSettingsRecord(raw.overrides)) for (const caps of Object.values(raw.overrides)) {
      if (!isSettingsRecord(caps)) throw new Error('invalid capability preferences');
      validateOptionalSettingsFields(caps, { 'text.oneshot': (value: unknown) => typeof value === 'string' && value.length > 0 });
    }
    if (isSettingsRecord(raw.inflightLimits) && Object.values(raw.inflightLimits).some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) throw new Error('invalid concurrency preference');
    return normalize(raw);
  });
}

/** 读某插件的在途并发上限;null = 未配置 = 不限并发。 */
export function readGhostCindyInflightLimit(ghostId: string): number | null {
  // 本文件是"直接改文件也算配置入口"的隐藏配置(无 UI),读前做 mtime 守卫
  // 失效:文件没变零开销,手改后下一单即按新上限判。
  store.invalidateIfChanged();
  return store.read().inflightLimits[ghostId] ?? null;
}

/**
 * 写/清某插件的在途并发上限:limit 为 null 即清除(恢复不限,规则 20 语义)。
 * 只收正整数,非法值直接抛(调用方应在入口校验,这里是最后防线)。
 */
export function writeGhostCindyInflightLimit(ghostId: string, limit: number | null): void {
  assertGhostPrefsWritable(GHOST_CINDY_PREFS_FILE);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`inflight limit 必须是正整数或 null,收到:${String(limit)}`);
  }
  // 写前失效缓存:避免把用户刚手改的文件内容用旧缓存整体覆写掉。
  store.invalidateIfChanged();
  const inflightLimits = { ...store.read().inflightLimits };
  if (limit === null) delete inflightLimits[ghostId];
  else inflightLimits[ghostId] = limit;
  store.writePatch({ inflightLimits });
  log.info('ghost cindy inflight limit written', { ghostId, limit });
}

/**
 * 旧布局迁移专用:文件里仍有 `overrides` 键时返回 ghostId → 旧快问快答钉值
 * (没有钉快问快答的插件值为 null);已迁移 / 从未有过覆盖 / 文件不可读返回 null。
 */
export function readLegacyOneshotPins(): Record<string, string | null> | null {
  store.invalidateIfChanged();
  const overrides = store.read().overrides;
  if (!overrides) return null;
  return Object.fromEntries(
    Object.entries(overrides).map(([ghostId, caps]) => [ghostId, caps['text.oneshot'] ?? null]),
  );
}

/** 迁移完成后删除旧 `overrides` 键(保留其它键;文件随之为空则整份删除)。 */
export function clearLegacyOverrides(): void {
  assertGhostPrefsWritable(GHOST_CINDY_PREFS_FILE);
  store.invalidateIfChanged();
  if (!store.read().overrides) return;
  store.writePatch({ overrides: undefined });
  log.info('legacy ghost cindy overrides removed after migration');
}

export const __testing = {
  normalize,
  resetStore: () => {
    store = createStore();
  },
};
export const getHostPluginCindyStore = () => store;
