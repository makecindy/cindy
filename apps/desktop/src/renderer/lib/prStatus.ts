/**
 * prStatus — PR 状态展示的共享原语(聊天顶栏 + 侧栏徽标共用)。
 * ---------------------------------------------------------------------------
 * 单独成模块是为了斩断 useSessionGitContext ↔ PrRefsContext 的循环导入:
 * 顶栏 hook 消费共享缓存(PrRefsContext),缓存又需要这些常量——常量放任一侧
 * 都会成环(HMR 下曾以 `PR_STATUS_REFRESH_INTERVAL_MS is not defined` 的 TDZ
 * 崩溃现形)。本模块零依赖,两边都从这里 import;useSessionGitContext 保留
 * re-export 兼容存量 import 方。
 */

/** 只对最近的几条 PR 引用查状态(徽标也只展示这几条)。 */
export const MAX_STATUS_QUERIES = 3;

/**
 * PR 状态的兜底刷新周期——聊天顶栏与侧栏徽标(PrRefsContext)共用同一节拍。
 * GitHub 侧 open→merged / review 评论 resolve 这类变化不会产生本地
 * pr-refs-changed 事件,只靠初次加载会一直显示旧状态。取值刻意 > main 侧
 * 60s TTL,保证每次 tick 都真的打到远端。
 */
export const PR_STATUS_REFRESH_INTERVAL_MS = 90_000;

/** statuses 缓存的 key:`owner/repo#N`(小写 owner/repo)。 */
export function prStatusKey(ref: { owner: string; repo: string; prNumber: number }): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.prNumber}`;
}

/** 本机可操作的 gh 失败:徽标点击会引导安装/登录。 */
const ACTIONABLE_PR_FAILURE = new Set(['gh-missing', 'gh-not-logged-in']);

/**
 * PrRefsContext 按 PR 键共享状态,本机查询与 device-link 查询会写同一格。
 *   - 失败不得覆盖已有成功(徽标不能随两端轮询来回降级)
 *   - 不可操作失败(no-token / fetch-failed / not-found)不得覆盖可操作失败
 *     (远端归一后的 no-token 不能把本机 gh-missing 的安装引导抹掉)
 * 成功态与可操作失败都可以覆盖不可操作失败(本机轮询恢复引导)。
 */
export function shouldApplyPrStatus(
  prev: { ok: boolean; reason?: string } | undefined,
  next: { ok: boolean; reason?: string },
): boolean {
  if (!prev) return true;
  if (prev.ok && !next.ok) return false;
  const prevActionable = !prev.ok && ACTIONABLE_PR_FAILURE.has(prev.reason ?? '');
  const nextActionable = !next.ok && ACTIONABLE_PR_FAILURE.has(next.reason ?? '');
  if (prevActionable && !next.ok && !nextActionable) return false;
  return true;
}
