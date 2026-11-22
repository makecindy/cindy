/**
 * The context window budget bookkeeping of the desktop's maker IPC (register.ts): which budget a live
 * runtime was rebuilt for, and which budget rebuilds are still owed. Moved verbatim out of register.ts
 * (same names; register.ts imports these objects and its writes are unchanged) so the budget
 * reconcile, shared with the Node Host, reads and writes the same two tables.
 */
/**
 * 已按某个预算值重建过活实例的会话：并发通知（双窗口/连点）会带着**同一个终值**进来，
 * 没有这层去重就会对同一值连续冷重建两次。会话关闭（含删除/归档/取消切换）时清理 ——
 * 否则条目常驻内存，且「关掉期间改了预算、重开后再改回旧值」会被旧条目挡掉一次。
 * 模块级而非闭包内：会话关闭的清理在 registerMakerIpc 之外。
 */
export const appliedContextWindowBudgets = new Map<string, number | null>();

/**
 * 已登记、但还没真正落到活实例的预算重建意图。
 *
 * 只在这条集合里重放（发送边界），而不是「dedup 缺失就重放」：任务启动时
 * `applySessionContextWindowBudgetToCreateOpts` 已把偏好预算带给引擎，此时 dedup 里
 * 还没有条目，靠「缺失」判断会误判窗口变化，把刚配置好的实例再关一次
 * （首条直发多等一次冷启动；Greptile P2，2026-10-24）。
 */
export const pendingSessionContextWindowBudgetReconciles = new Set<string>();
