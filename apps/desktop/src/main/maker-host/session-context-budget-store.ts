/**
 * session-context-budget-store —— 「任务级工作上下文预算」的持久化（main 侧唯一真源）。
 *
 * File: <owner-scoped userData>/session-context-budget-prefs.json
 * 形态: { budgets: { "<sessionId>": 262144 } }
 *
 * ## 这个设置解决什么
 *
 * 自动压缩的触发是「已用 token / 上下文窗口 ≥ 阈值百分比」。`model-context-limit-store`
 * 已经让用户能给**单个模型**设分母上限；本 store 把同一个分母收到**单个任务**上：
 * 分档计费的路由可以选更便宜的价带，不分档的路由可以直接省 token。
 *
 * ## 为什么不落库（sessions 表加列）
 *
 * 与 `model-context-limit-store` / `compaction-settings-store` 同一条理由：这是**用户偏好**，
 * 不是会话事实。它不参与任何查询、不需要索引、不需要与消息表同事务；而加列要走迁移链 ——
 * 迁移一旦写进 `migration_history` 与运行时 manifest 身份，**用旧包（或官方包）打开同一个库
 * 就会因身份不符 fail closed**。偏好文件没有这个代价：不认识它的宿主照常打开库，只是不生效。
 *
 * ## 为什么不放 renderer localStorage
 *
 * 同 `model-context-limit-store`：它参与**运行期判定**（启动/切模时收敛下发窗口），判定发生在
 * main，renderer 窗口可能根本不存在（MCP / IM / 定时任务起的会话）。
 *
 * ## 语义
 *
 * - 只存用户显式设过的条目；缺席 = 跟随模型默认（等价于 `contextWindowBudget = null`）。
 * - 「恢复默认」= 删除条目（不是写一份当前默认的快照），所以目录把窗口调整后，没自定义过的
 *   任务直接吃新默认；`isSessionContextWindowBudgetCustomized()` 让 UI 能区分这两种状态。
 * - 存的是**用户请求值**，不是收敛后的有效窗口：有效窗口在运行期按目标路由重新收敛
 *   （`resolveConfiguredContextWindow`），这样跨模型/跨来源的 fork 与切模都不会残留越界值。
 */

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('session-context-budget');

/** 与 model-context-limit 同口径：低于此值的预算等于让任务不可用 —— 视为误输入。 */
const MIN_BUDGET_TOKENS = 1_000;
/** 只挡量级荒谬的误输入；真正的上界由运行期按目录上限与模型级上限收敛。 */
const MAX_BUDGET_TOKENS = 100_000_000;
/**
 * 条目总量硬上限（深防线）。任务数会随使用增长，正常路径有 IPC 边界校验与删除路径的清理，
 * 这里兜的是「绕过 IPC 直改文件 / 未来新增写入口漏校验」，防止这份同步读写的 JSON
 * 无界膨胀拖死 main。超限时按遍历序丢弃（= 跟随默认，无副作用）。
 */
const MAX_ENTRIES = 16_384;

export interface SessionContextBudgetPrefs {
  budgets: Record<string, number>;
}

const DEFAULTS: SessionContextBudgetPrefs = { budgets: {} };

function clampBudget(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_BUDGET_TOKENS) return null;
  return Math.min(MAX_BUDGET_TOKENS, rounded);
}

/** 只收「非空 sessionId + 可 clamp 成合法 token 数」的条目；其它形态一律丢弃 = 跟随默认。 */
function sanitizeBudgets(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    let kept = 0;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!key) continue;
      const budget = clampBudget(value);
      if (budget === null) continue;
      if (kept >= MAX_ENTRIES) {
        log.warn('session context budget prefs truncated at hard cap on read', { cap: MAX_ENTRIES });
        break;
      }
      out[key] = budget;
      kept += 1;
    }
  }
  return out;
}

function normalize(raw: unknown): SessionContextBudgetPrefs {
  if (!raw || typeof raw !== 'object') return { budgets: {} };
  return { budgets: sanitizeBudgets((raw as { budgets?: unknown }).budgets) };
}

const createStore = (filePath: () => string) => createOverrideSettingsFile<SessionContextBudgetPrefs>({
  filePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'session-context-budget',
  maxBytes: 1_048_576,
  preserveUnreadableFile: true,
});

const store = createStore(() => ownerScopedUserDataPath('session-context-budget-prefs.json'));

function readPrefs(): SessionContextBudgetPrefs {
  // 与 model-context-limit 一致：mtime 守卫让「直接手改文件」在下一次读取生效。
  store.invalidateIfChanged();
  return store.read();
}

/** 某个任务保存的原始预算（tokens）；未自定义返回 null。 */
export function readSessionContextWindowBudget(sessionId: string): number | null {
  if (!sessionId) return null;
  return readPrefs().budgets[sessionId] ?? null;
}

/** UI 用：这一条是否被用户显式设过（区分「跟随默认」与「设了一个刚好等于默认的值」）。 */
export function isSessionContextWindowBudgetCustomized(sessionId: string): boolean {
  if (!sessionId) return false;
  return sessionId in readPrefs().budgets;
}

/**
 * 写一个任务的预算。`tokens === null` = 恢复默认（删除条目），与「恢复默认 = 删 override」一致。
 * 返回落盘后的有效值（null = 已跟随默认）。
 */
export function writeSessionContextWindowBudget(sessionId: string, tokens: number | null): number | null {
  if (!sessionId) throw new Error('invalid session id');
  const next = tokens === null ? null : clampBudget(tokens);
  if (tokens !== null && next === null) throw new Error('invalid context window budget');
  store.invalidateIfChanged();
  const budgets = { ...store.read().budgets };
  if (next === null) delete budgets[sessionId];
  else budgets[sessionId] = next;
  if (Object.keys(budgets).length > MAX_ENTRIES) throw new Error('session context budget capacity exceeded');
  store.writePatch({ budgets });
  return next;
}

/**
 * 任务被硬删除后清掉它的条目（软删除保留行，条目仍会随 restore 复用，故不清理）。
 * 返回是否真的删掉了一条。
 */
export function pruneSessionContextWindowBudget(sessionId: string): boolean {
  if (!sessionId) return false;
  store.invalidateIfChanged();
  const budgets = store.read().budgets;
  if (!(sessionId in budgets)) return false;
  const next = { ...budgets };
  delete next[sessionId];
  store.writePatch({ budgets: next });
  return true;
}

/**
 * fork 继承：把源任务的条目复制给新任务（源未自定义时不动新任务）。
 * 继承的是**用户请求值**，启动/切模时仍按目标路由重新收敛，所以跨模型 fork 不会
 * 残留超出目标上限的值。
 */
export function copySessionContextWindowBudget(
  sourceSessionId: string,
  targetSessionId: string,
): number | null {
  const budget = readSessionContextWindowBudget(sourceSessionId);
  if (budget === null) return null;
  return writeSessionContextWindowBudget(targetSessionId, budget);
}
