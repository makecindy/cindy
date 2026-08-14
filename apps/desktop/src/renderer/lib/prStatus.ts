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
