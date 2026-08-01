/**
 * 按 ghostId 的真正互斥锁。
 *
 * `GhostMutationCoordinator` 是账户 drain barrier(可并发持有,只保证切号前排空),
 * **不提供互斥**:同一 ghostId 的市场装入、本地 .cindy 装入 / 更新、卸载可以交错,
 * "检查目标是否已装 → 落位"之间的窗口会被另一条路径插入(把"更新"降级成
 * "首装带电",或静默覆盖刚装入的同 id 包,并绕过审阅时因目标不存在而跳过的权限
 * 确认)。这里补上按 id 串行:同一 ghostId 的这些操作全程排队,不同 id 仍并行。
 *
 * 不可重入:同一逻辑操作只在**最外层**获取一次(市场路径由 service 的提交段获取,
 * installAndDock / manager.update 内部不再获取),因此无自锁死锁。仅 main 进程内
 * 有效(Electron 单实例)。
 */
const locks = new Map<string, Promise<void>>();

export async function withGhostInstallLock<T>(
  ghostId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(ghostId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = prev.then(() => gate);
  locks.set(ghostId, mine);
  // 轮到自己:等前一笔结束(无论成败)。
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // 链尾清理,避免 Map 无界增长(仅当自己仍是最后一笔时删)。
    if (locks.get(ghostId) === mine) locks.delete(ghostId);
  }
}
