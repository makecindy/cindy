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
 * 字符串比较是**大小写敏感**的,而 Windows/macOS 文件系统通常不敏感。这里安全的
 * 前提是:所有缓存路径都由同一套代码派生(ownerScopedUserDataPath + marketCloneSlug,
 * slug 全小写),同一目录永远以同一写法出现。新调用方不得传入手工拼写或改过大小写
 * 的路径。
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

/**
 * 已经启动、尚未结束的删除:绝对路径 → 该删除的 Promise。
 * `skipIf` 只能挡住"还没开始"的删除;已经在跑的那笔必须能被复用方等到,否则它会
 * 落在刚重建出来的内容上(见 `settleCachePathRemovals`)。
 */
const inFlight = new Map<string, Promise<void>>();

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
  await runRemoval(target, options);
  return true;
}

/**
 * 真正执行删除,并把它登记进 `inFlight`。
 *
 * 登记是必需的:`skipIf` 只在**启动前**核对一次,一旦 rm 开始跑,调用方就再也无法
 * 取消或等待它。旧槽删除正在途中、而重新添加同名同源的来源刚好把新版本落进同一个
 * 槽,那笔在途删除就会把新内容删掉(配置有效但来源持续报缓存缺失)。要复用某个路径
 * 的调用方必须先 `settleCachePathRemovals` 等它结束。
 */
async function runRemoval(target: string, options: DeferredRemoval): Promise<void> {
  const task = fs.promises
    // maxRetries/retryDelay:Windows 上 AV/索引器/云同步持句柄会让 rm 抛
    // EBUSY/EPERM/ENOTEMPTY,libuv 原生重试即可,不必自建循环。
    .rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    .catch((error: unknown) => {
      options.onError?.(error);
    });
  inFlight.set(target, task);
  try {
    await task;
  } finally {
    if (inFlight.get(target) === task) inFlight.delete(target);
  }
}

/**
 * 等待与该路径重叠的在途删除全部结束。**复用一个刚被删除过的路径前必须调用**
 * (例如移除来源后重新添加同名同源会复用同一个缓存槽)。
 *
 * 循环是因为等待期间可能又有租约释放、触发新的推迟删除;上限只是防御性兜底,
 * 正常情况下一两轮就空了。
 */
export async function settleCachePathRemovals(target: string): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    const pending = [...inFlight]
      .filter(([path]) => overlaps(path, target))
      .map(([, task]) => task);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

/** 执行所有已不再被租约挡住的推迟删除。 */
function drainDeferred(): void {
  for (const [target, options] of [...deferred]) {
    if (isCachePathLeased(target)) continue;
    deferred.delete(target);
    if (options.skipIf?.()) continue;
    // 释放路径是同步的,这里不能 await;但删除会登记进 inFlight,复用方能等到它。
    void runRemoval(target, options);
  }
}

/** 仅测试用:清空租约与推迟队列,避免用例间互相影响。 */
export function resetCacheLeasesForTest(): void {
  leases.clear();
  deferred.clear();
  inFlight.clear();
}
