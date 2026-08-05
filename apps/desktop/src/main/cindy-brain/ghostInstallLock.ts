/**
 * 按 ghostId 的**可重入**互斥锁:同一插件的装入 / 更新 / 卸载全程串行。
 *
 * 为什么需要:`GhostMutationCoordinator` 是账户 drain barrier(可并发持有,只保证
 * 切号前排空),**不提供互斥**。同一 ghostId 的市场装入、本地 .cindy 装入 / 更新、
 * 卸载若能交错,"检查目标是否已装 → 落位 → 写溯源"之间的窗口就会被另一条路径插入:
 * 把"更新"降级成"首装带电"、静默覆盖刚装入的同 id 包、或让账本认领一个其实不属于
 * 自己的包(权限差异确认还因审阅时目标不存在而没跑过)。
 *
 * 为什么**可重入**:这块的教训是"给眼前这条路加个 guard"永远漏下一条。锁因此同时
 * 加在三个卡点(`installAndDock`、`installOrUpdateMarketGhostPackage`、
 * `uninstallGhostAndCleanup`)与各调用方的复核段上——外层已持有时内层必须是 no-op,
 * 否则自锁死锁。这样新增装入路径即使忘了取锁,也会在卡点被兜住。
 *
 * 锁序不变量(违反即死锁):
 *   `withMutation(pluginId)` → `SOURCE_MUTATION_KEY` → **ghostId** → `ledgerMutation`
 * 持本锁时不得反向去取来源锁或 pluginId 锁。卸载路径只用 pluginId → ghostId →
 * ledger(不取来源锁),与上面的偏序相容。
 *
 * 仅 main 进程内有效(Electron 单实例)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 当前异步上下文已持有的 ghostId 集合(重入判定依据)。 */
const heldIds = new AsyncLocalStorage<ReadonlySet<string>>();

/** 每个 ghostId 的等待链尾。 */
const locks = new Map<string, Promise<void>>();

/** 当前异步上下文是否已持有该 ghostId 的锁(供卡点断言用)。 */
export function isGhostInstallLockHeld(ghostId: string): boolean {
  return heldIds.getStore()?.has(ghostId) ?? false;
}

export async function withGhostInstallLock<T>(
  ghostId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = heldIds.getStore();
  // 重入:本上下文已持有 → 直接执行。必须在排队之前判定,否则等自己释放 = 自锁。
  if (current?.has(ghostId)) return fn();

  const prev = locks.get(ghostId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = prev.then(() => gate);
  locks.set(ghostId, mine);
  // 轮到自己:等前一笔结束(无论成败)。
  await prev.catch(() => undefined);
  const nextHeld = new Set(current ?? []);
  nextHeld.add(ghostId);
  try {
    return await heldIds.run(nextHeld, fn);
  } finally {
    release();
    // 链尾清理,避免 Map 无界增长(仅当自己仍是最后一笔时删)。
    if (locks.get(ghostId) === mine) locks.delete(ghostId);
  }
}

/** 仅测试用:清空等待链,避免用例间互相影响。 */
export function resetGhostInstallLocksForTest(): void {
  locks.clear();
}
