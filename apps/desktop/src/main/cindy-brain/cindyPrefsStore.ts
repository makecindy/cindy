/**
 * cindyPrefsStore —— cindy 槽"意识专属后端覆盖"的持久化(解析表第②层)。
 *
 * File: <userData>/ghost-cindy-prefs.json
 *
 * 形态:{ overrides: { <ghostId>: { "image.generate": "<白名单模型>", … } },
 *        inflightLimits: { <ghostId>: <正整数并发上限> } }
 * - 没写 = 跟随默认(出厂 = 自带 proxy 基座;规则 20:override 与默认值
 *   分开记,清除即重新跟随当下默认);
 * - inflightLimits:该意识同时能跑几单 cindy 代办(隐藏配置层级,无
 *   Settings UI,直接改文件或让 agent 改);缺项 = 不限并发(系统默认);
 * - 抽离意识**不**清覆盖——与布局位置"重新注入原位复活"同语义,重装回来
 *   钉的后端还在;
 * - 已确认的一对一模型 rename 在读取 normalize 时兼容映射,保留用户显式
 *   override;真正失效的值仍由消费方(cindySlot)校验,静默落回默认并留日志。
 */

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('cindy-prefs-store');

/** cindy 槽能力键(类目.动作;与身份卡详单同一词汇表,当前包含 video)。 */
// text.oneshot(快问快答)与图像/视频同表:每项覆盖记的都是一组供应商×模型。
// 文本类的取值是轻量任务模型链的档位键(codex-gpt-5.4-mini 等),不是媒体目录模型 id。
export const CINDY_CAPABILITY_KEYS = [
  'image.generate',
  'image.edit',
  'video.generate',
  'video.edit',
  'text.oneshot',
] as const;
export type CindyCapabilityKey = (typeof CINDY_CAPABILITY_KEYS)[number];

export interface GhostCindyPrefs {
  /** ghostId → 能力键 → 白名单模型 id(缺项 = 跟随默认)。 */
  overrides: Record<string, Partial<Record<CindyCapabilityKey, string>>>;
  /** ghostId → 在途代办并发上限(正整数;缺项 = 不限并发)。 */
  inflightLimits: Record<string, number>;
}

const DEFAULTS: GhostCindyPrefs = { overrides: {}, inflightLimits: {} };

/** 已确认的一对一图片模型 rename；旧 override 代表明确的用户选择，可无歧义迁移。 */
const LEGACY_IMAGE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
};

function normalizeModelOverride(capability: CindyCapabilityKey, model: string): string {
  if (capability !== 'image.generate' && capability !== 'image.edit') return model;
  return LEGACY_IMAGE_MODEL_ALIASES[model] ?? model;
}

function normalize(raw: unknown): GhostCindyPrefs {
  if (!raw || typeof raw !== 'object') return { overrides: {}, inflightLimits: {} };
  const overridesRaw = (raw as { overrides?: unknown }).overrides;
  const overrides: GhostCindyPrefs['overrides'] = {};
  if (overridesRaw && typeof overridesRaw === 'object') {
    for (const [ghostId, capsRaw] of Object.entries(overridesRaw as Record<string, unknown>)) {
      if (!capsRaw || typeof capsRaw !== 'object') continue;
      const caps: Partial<Record<CindyCapabilityKey, string>> = {};
      for (const key of CINDY_CAPABILITY_KEYS) {
        const v = (capsRaw as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) caps[key] = normalizeModelOverride(key, v);
      }
      if (Object.keys(caps).length > 0) overrides[ghostId] = caps;
    }
  }
  // 并发上限:只收正整数,其它形态(0/负数/小数/字符串)一律丢弃 = 回到不限。
  const limitsRaw = (raw as { inflightLimits?: unknown }).inflightLimits;
  const inflightLimits: GhostCindyPrefs['inflightLimits'] = {};
  if (limitsRaw && typeof limitsRaw === 'object') {
    for (const [ghostId, v] of Object.entries(limitsRaw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1) inflightLimits[ghostId] = v;
    }
  }
  return { overrides, inflightLimits };
}

const store = createOverrideSettingsFile<GhostCindyPrefs>({
  filePath: () => ownerScopedUserDataPath('ghost-cindy-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-cindy-prefs',
});

/** 读某意识的全部覆盖(缺省空对象 = 全跟随默认)。 */
export function readGhostCindyOverrides(ghostId: string): Partial<Record<CindyCapabilityKey, string>> {
  // 本文件是"直接改文件也算配置入口"的隐藏配置(inflightLimits 无 UI),
  // 读前做 mtime 守卫失效:文件没变零开销,手改后下一单即生效。
  store.invalidateIfChanged();
  return store.read().overrides[ghostId] ?? {};
}

/**
 * 写/清一项覆盖:model 为 null 即清除(恢复跟随默认,规则 20 语义)。
 * 白名单校验由 IPC 层做(存储层不感知模型清单)。
 */
export function writeGhostCindyOverride(
  ghostId: string,
  capability: CindyCapabilityKey,
  model: string | null,
): Partial<Record<CindyCapabilityKey, string>> {
  // 写前同样失效缓存:避免把用户刚手改的文件内容用旧缓存整体覆写掉。
  store.invalidateIfChanged();
  const overrides = { ...store.read().overrides };
  const caps = { ...(overrides[ghostId] ?? {}) };
  if (model === null) delete caps[capability];
  else caps[capability] = model;
  if (Object.keys(caps).length === 0) delete overrides[ghostId];
  else overrides[ghostId] = caps;
  store.writePatch({ overrides });
  log.info('ghost cindy override written', { ghostId, capability, model });
  return caps;
}

/** 读某意识的在途并发上限;null = 未配置 = 不限并发。 */
export function readGhostCindyInflightLimit(ghostId: string): number | null {
  // 同上:mtime 守卫现读,手改 ghost-cindy-prefs.json 后下一单即按新上限判。
  store.invalidateIfChanged();
  return store.read().inflightLimits[ghostId] ?? null;
}

/**
 * 写/清某意识的在途并发上限:limit 为 null 即清除(恢复不限,规则 20 语义)。
 * 只收正整数,非法值直接抛(调用方应在入口校验,这里是最后防线)。
 */
export function writeGhostCindyInflightLimit(ghostId: string, limit: number | null): void {
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`inflight limit 必须是正整数或 null,收到:${String(limit)}`);
  }
  store.invalidateIfChanged();
  const inflightLimits = { ...store.read().inflightLimits };
  if (limit === null) delete inflightLimits[ghostId];
  else inflightLimits[ghostId] = limit;
  store.writePatch({ inflightLimits });
  log.info('ghost cindy inflight limit written', { ghostId, limit });
}

export const __testing = { normalize };
