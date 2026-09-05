/**
 * 迁移交互的会话级 settle 桥接注册表。
 *
 * 背景:从 desktop 接管(attached)到 IM 渠道的 pending interaction(permission /
 * ask / plan),其所有权登记在各渠道 turnRunner 闭包内的 `migratedInteractionsBySession`
 * 里。IM `!stop`、session close、detach drain 都在 turnRunner 内部,能直接 settle
 * 这些卡片;但 **Desktop renderer 的 Stop 按钮走的是 maker-ipc 的 ABORT_SESSION**
 * (register.ts),它只清理 desktop 侧 `pendingInteractionResolvers`,而迁移交互早已被
 * `takePendingInteractionsForSession` 从那张表里取走、resolve 也移交给了渠道侧 —
 * 于是 ABORT_SESSION 触达不到渠道卡,卡片继续存活直到各自 10 分钟超时。
 *
 * 这个注册表是一个无依赖叶子模块:turnRunner 在为某 session 登记迁移交互所有权时
 * 注册一个 settle-all 回调(生命周期与该 session 的迁移记录一致,detach 后仍保留),
 * register.ts 在 ABORT_SESSION / input_stop 时按 sessionId 调用它。放在独立模块是为了
 * 不让 maker-ipc/register 反向 import im/shared/turnRunner(turnRunner 已 import
 * register,直接反向引用会形成循环依赖)。
 */

type MigratedInteractionSettler = (reason: string) => void;

/** sessionId → 仍持有该 session 迁移交互的全部渠道 settle-all 回调。 */
const settlers = new Map<string, Set<MigratedInteractionSettler>>();

/**
 * 登记某 session 的迁移交互 settle-all 回调。返回注销函数。
 *
 * 同一 session 可能在旧渠道的迁移卡尚未收口时被另一个渠道接管，因此每个渠道都保留
 * 自己的回调；调用方在自己的迁移记录全部 settle 完后必须调用返回的注销函数，避免
 * Map 无界增长。
 */
export function registerMigratedInteractionSettler(
  sessionId: string,
  settleAll: MigratedInteractionSettler,
): () => void {
  let sessionSettlers = settlers.get(sessionId);
  if (!sessionSettlers) {
    sessionSettlers = new Set();
    settlers.set(sessionId, sessionSettlers);
  }
  sessionSettlers.add(settleAll);
  return () => {
    const current = settlers.get(sessionId);
    if (!current) return;
    current.delete(settleAll);
    if (current.size === 0) settlers.delete(sessionId);
  };
}

/**
 * 由 Desktop ABORT_SESSION / input_stop 调用:立即用 `reason` settle 该 session
 * 上所有尚未收口的迁移交互。没有登记时是 no-op(该 session 当前没有迁移交互,或不经过
 * IM 渠道接管)。幂等。
 */
export function settleMigratedInteractionsForSessionExternal(
  sessionId: string,
  reason: string,
): void {
  const sessionSettlers = settlers.get(sessionId);
  if (!sessionSettlers) return;
  // settle 回调可能同步注销自身，先快照避免迭代期间跳过同 session 的其它渠道。
  for (const settleAll of Array.from(sessionSettlers)) settleAll(reason);
}
