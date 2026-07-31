/**
 * 市场缓存目录的租约与**唯一删除入口**。
 *
 * 为什么单独成模块:这块此前反复出问题,每一轮都是"又发现一个删除点没查租约"
 * ——交换旧目录、清理历史版本、清理暂存目录、移除来源、失败回滚,各自直接
 * `fs.rm`。只要删除动作散落在多个调用点,租约就是"可选的",总会有下一个漏掉的
 * 点。把删除收口到这里,并让 `sources/index.ts` 不再直接调用 `fs.rm`,
 * "删掉正在被读的路径"才从结构上不可能发生,而不是靠每个调用点自觉。
 *
 * 判据只有一条(`overlaps`):目标路径与任何持有中的租约**在任一方向上重叠**时
 * 不删,推迟到最后一个相关租约释放。三种历史事故都落在这一条里:
 * - 清理删掉正在被读的版本目录          → 租约 === 目标
 * - 移除来源整槽递归删,而槽内某版本在读 → 租约在目标之下
 * - 清理删掉 git 的 `<dest>.staging-*`  → 目标在租约"之下"(字符串前缀)
 *
 * 前缀按**字符串**比较而不是路径分段:git clone 的暂存目录是目标的兄弟
 * (`<dest>.staging-<uuid>`),分段比较盖不住它。代价是极端情况下会把名字恰好以
 * 某个租约全文开头的无关目录判成"在用"——后果仅是该目录晚一点被清理(纯磁盘),
 * 永远不会导致误删。
 *
 * 仅在 main 进程内有效(同一 userData 只有一个 main 进程,Electron 单实例)。
 * 按绝对路径为键,因此 owner 隔离由路径自带(`ownerScopedUserDataPath` 已把
 * owner 编进 cloneRoot),也不受"每次操作都新建 MarketSourceManager"影响。
 */
import fs from 'node:fs';

/** 持有中的租约:绝对路径 → 引用数。 */
const leases = new Map<string, number>();

/** 因租约冲突被推迟的删除:绝对路径 → 执行前的最后一道否决条件。 */
const deferred = new Map<string, DeferredRemoval>();

interface DeferredRemoval {
  /** 返回 true 表示放弃删除(例如该版本目录已重新成为 current)。 */
  skipIf?: () => boolean;
  onError?: (error: unknown) => void;
}

/** 两条路径在任一方向上重叠(含相等、互为前缀)。 */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** 是否有持有中的租约与该路径重叠。 */
export function isCachePathLeased(target: string): boolean {
  for (const held of leases.keys()) {
    if (overlaps(held, target)) return true;
  }
  return false;
}

/**
 * 登记一个租约。必须覆盖到该路径的**最后一次使用**为止(例如自定义源安装要
 * 一直持到 `.cindy` 打包完成),否则并发的清理仍能在使用途中把目录抽走。
 */
export function retainCachePath(target: string): void {
  leases.set(target, (leases.get(target) ?? 0) + 1);
}

/** 释放租约;不再有重叠租约时执行被推迟的删除。 */
export function releaseCachePath(target: string): void {
  const remaining = (leases.get(target) ?? 0) - 1;
  if (remaining > 0) {
    leases.set(target, remaining);
    return;
  }
  leases.delete(target);
  drainDeferred();
}

/** 在持有租约的作用域内执行 fn。 */
export async function withCachePath<T>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  retainCachePath(target);
  try {
    return await fn();
  } finally {
    releaseCachePath(target);
  }
}

/**
 * 删除一个缓存路径。**这是本模块外唯一允许的缓存删除方式。**
 *
 * 与任何持有中的租约重叠时不删,而是推迟到最后一个相关租约释放;`skipIf` 在真正
 * 执行前再核对一次(推迟期间事实可能已经变了,例如该版本又成了 current)。
 * 返回是否已就地删除。删除失败只影响磁盘占用,不影响正确性。
 */
export async function removeCachePath(
  target: string,
  options: DeferredRemoval = {},
): Promise<boolean> {
  if (isCachePathLeased(target)) {
    deferred.set(target, options);
    return false;
  }
  deferred.delete(target);
  if (options.skipIf?.()) return false;
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (error) {
    options.onError?.(error);
  }
  return true;
}

/** 执行所有已不再被租约挡住的推迟删除。 */
function drainDeferred(): void {
  for (const [target, options] of [...deferred]) {
    if (isCachePathLeased(target)) continue;
    deferred.delete(target);
    if (options.skipIf?.()) continue;
    void fs.promises.rm(target, { recursive: true, force: true }).catch((error: unknown) => {
      options.onError?.(error);
    });
  }
}

/** 仅测试用:清空租约与推迟队列,避免用例间互相影响。 */
export function resetCacheLeasesForTest(): void {
  leases.clear();
  deferred.clear();
}
