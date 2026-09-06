/**
 * model-context-limit-store —— 「单模型上下文上限」override 的持久化(main 侧唯一真源)。
 *
 * File: <owner-scoped userData>/model-context-limit-prefs.json
 * 形态:{ limits: { "<agent>:<providerId>:<modelId>": 272000 } }
 *
 * ## 这个设置解决什么
 *
 * 自动压缩的触发是「已用 token / 上下文窗口 ≥ 阈值百分比」。阈值百分比用户能调
 * (设置 → 个性化,compaction-settings-store,默认 90),但**分母**是模型窗口,由路由钉死:
 * Claude 给 1M、GPT 给 272K,用户想「这个模型我只想用到 500K 就开始压缩」无从下手 ——
 * 调百分比会同时影响所有模型,且换算成 token 数还得自己算。
 *
 * 所以这里存的是**分母的用户上限**:运行时按显式值配置窗口与原生压缩预算。
 * 缺席时保持原有路由判定；不会把路由默认快照进本地偏好。
 *
 * ## 为什么在 main 而不是 renderer localStorage
 *
 * 与 model-disable-store 同一条理由:它参与**运行期判定**,而判定发生在 main
 * (runtime-configs 的窗口评估),renderer 窗口可能根本不存在(MCP / IM hook / scheduler
 * 起的会话)。对比 modelVisibilityPrefs —— 那个纯粹影响 renderer 的选择器陈列,留在
 * renderer 是对的。
 *
 * ## override 语义(docs/dev-rules/configuration-and-overrides.md)
 *
 * - 只存用户显式设过的条目;缺席 = 跟随路由窗口。新模型、路由改窗口都天然跟随新默认。
 * - 「恢复默认」= 删除该条目(不是写一个当前默认值的快照),所以上游把窗口从 272K 放到
 *   1M 时,没自定义过的用户直接吃到 1M。
 * - `isModelContextLimitCustomized()` 让 UI 能区分「跟随默认」与「用户设过且刚好等于默认」。
 *
 * ## 为什么不设硬上限
 *
 * 值只 clamp 下限(见 MIN_LIMIT_TOKENS),**不 clamp 到模型窗口**:路由把窗口配错(下发
 * 值小于模型实际能力)时,用户得能强行往上填把自己解开;UI 侧超过上游窗口会给警示。
 * 上限只挡明显荒谬的量级(MAX_LIMIT_TOKENS),避免写进一个天文数字让比例判定失效。
 */

import type { AgentKind } from '@cindy/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('model-context-limit');

/** 低于这个数压缩会在第一条消息就触发,等于让会话不可用 —— 视为误输入。 */
const MIN_LIMIT_TOKENS = 1_000;
/**
 * 上限只挡量级荒谬(比当前最大窗口高两个数量级以上)。它不是「模型能力上限」——
 * 那个由 UI 提示,不由这里拦(见头注「为什么不设硬上限」)。
 */
const MAX_LIMIT_TOKENS = 100_000_000;
/**
 * 条目总量硬上限(深防线,同 model-disable-store):正常路径有 IPC 边界校验,这里兜的是
 * 「绕过 IPC 直改文件 / 未来新增写入口漏校验」,防止这份同步读写的 JSON 无界膨胀拖死
 * main。取目录现实规模(数百条路由 × 3 引擎)的一个数量级以上。
 */
const MAX_ENTRIES = 4096;

export interface ModelContextLimitPrefs {
  limits: Record<string, number>;
}

const DEFAULTS: ModelContextLimitPrefs = { limits: {} };

/** 键含 agent —— 同一模型在不同引擎下窗口本就可能不同(registry 的 perAgent.contextWindow)。 */
export function modelContextLimitKey(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): string {
  return `${agent}:${providerId}:${modelId}`;
}

function clampLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_LIMIT_TOKENS) return null;
  return Math.min(MAX_LIMIT_TOKENS, rounded);
}

/**
 * 只收「非空 key + 可 clamp 成合法 token 数」的条目;其它形态一律丢弃 = 跟随默认。
 * 读入也截断:写入路径的上限挡不住手改 / 灌大文件,不截断的话超大 map 会被完整持有
 * 并在下次 writePatch 原样重写放大。超限部分按遍历序丢弃(= 跟随默认,无副作用)。
 */
function sanitizeLimits(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    let kept = 0;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!key) continue;
      const limit = clampLimit(value);
      if (limit === null) continue;
      if (kept >= MAX_ENTRIES) {
        log.warn('model context limit prefs truncated at hard cap on read', { cap: MAX_ENTRIES });
        break;
      }
      out[key] = limit;
      kept += 1;
    }
  }
  return out;
}

function normalize(raw: unknown): ModelContextLimitPrefs {
  if (!raw || typeof raw !== 'object') return { limits: {} };
  return { limits: sanitizeLimits((raw as { limits?: unknown }).limits) };
}

const createStore = (filePath: () => string) => createOverrideSettingsFile<ModelContextLimitPrefs>({
  filePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'model-context-limit',
  maxBytes: 1_048_576,
  preserveUnreadableFile: true,
});

let store = createStore(() => ownerScopedUserDataPath('model-context-limit-prefs.json'));

function readPrefs(): ModelContextLimitPrefs {
  // 隐藏配置层级的文件也是正式契约:mtime 守卫让「直接手改文件」在下一次读取生效。
  store.invalidateIfChanged();
  return store.read();
}

/** 全部 override 快照。 */
export function readModelContextLimits(): Record<string, number> {
  return readPrefs().limits;
}

/** 某个 (引擎, 供应商, 模型) 的用户上限;未设过返回 null。 */
export function readModelContextLimit(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): number | null {
  if (!providerId || !modelId) return null;
  return readPrefs().limits[modelContextLimitKey(agent, providerId, modelId)] ?? null;
}

/** UI 用:这一条是否被用户显式设过(区分「跟随默认」与「设了一个刚好等于默认的值」)。 */
export function isModelContextLimitCustomized(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): boolean {
  if (!providerId || !modelId) return false;
  return modelContextLimitKey(agent, providerId, modelId) in readPrefs().limits;
}

/**
 * 写一条上限。`limit === null` = 恢复默认(删除条目),与「恢复默认 = 删 override」一致。
 * 返回落盘后该条目的有效值(null = 已跟随默认)。
 */
export function writeModelContextLimit(
  agent: AgentKind,
  providerId: string,
  modelId: string,
  limit: number | null,
): number | null {
  return writeModelContextLimits([{ agent, providerId, modelId }], limit);
}

/** Validate first, then persist all harness aliases in a single atomic file write. */
export function writeModelContextLimits(
  targets: readonly { agent: AgentKind; providerId: string; modelId: string }[],
  limit: number | null,
): number | null {
  const next = limit === null ? null : clampLimit(limit);
  if (limit !== null && next === null) throw new Error('invalid context limit');
  store.invalidateIfChanged();
  const limits = { ...store.read().limits };
  for (const target of targets) {
    if (!target.providerId || !target.modelId) throw new Error('invalid context target');
    const key = modelContextLimitKey(target.agent, target.providerId, target.modelId);
    if (next === null) delete limits[key];
    else limits[key] = next;
  }
  if (Object.keys(limits).length > MAX_ENTRIES) throw new Error('context limit capacity exceeded');
  store.writePatch({ limits });
  return next;
}

/** Roll back only this edit if its dependent runtime refresh fails. */
export async function writeModelContextLimitsWithRefresh(
  targets: readonly { agent: AgentKind; providerId: string; modelId: string }[],
  limit: number | null,
  refresh: () => Promise<void>,
): Promise<void> {
  // Capture the original owner's file; an account switch must never restore into
  // the new owner's preferences. Preserve mixed aliases and absent overrides.
  const filePath = ownerScopedUserDataPath('model-context-limit-prefs.json');
  const previous = { ...readModelContextLimits() };
  const written = writeModelContextLimits(targets, limit);
  try {
    await refresh();
  } catch (error) {
    const originalStore = createStore(() => filePath);
    const limits = { ...originalStore.read().limits };
    for (const target of targets) {
      const key = modelContextLimitKey(target.agent, target.providerId, target.modelId);
      // Do not undo a newer edit made outside the serialized IPC writer.
      if ((limits[key] ?? null) !== written) continue;
      if (previous[key] === undefined) delete limits[key];
      else limits[key] = previous[key];
    }
    try {
      originalStore.writePatch({ limits });
    } finally {
      store = createStore(() => ownerScopedUserDataPath('model-context-limit-prefs.json'));
    }
    throw error;
  }
}

/** 清空全部上限 override(供应商级 / 整体「恢复默认」用)。 */
export function resetModelContextLimits(): void {
  store.reset();
}

export const __testing = {
  MIN_LIMIT_TOKENS,
  MAX_LIMIT_TOKENS,
  MAX_ENTRIES,
  invalidate(): void {
    store.invalidateIfChanged();
  },
};
