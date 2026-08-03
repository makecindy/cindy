/**
 * 强更阻断态 —— 模块级单例 + 订阅。
 *
 * 强更不是"弹一次提示",而是**阻断使用**:命中门槛后 root 层不再挂载业务树,只渲染
 * 一个唯一出口是「去更新」的闸门屏(见 app/_layout.tsx)。因此状态不能挂在某个 hook 里
 * (启动检查、设置页手动检查、resume 静默检查三条路径都能命中),必须放模块级共享。
 *
 * **不持久化,只存内存**——这是与 otaReloadGuard 的关键区别,别把两者混为一谈:
 * - otaReloadGuard 挡的是**故障循环**(bundle 装不上却反复 reload),它必须落盘计数,
 *   并且必须自带放弃条件(满 2 次就放弃热更直接进 App);
 * - 本模块是**产品意图**的阻断,不是故障。不落盘本身就是自愈路径:服务端撤回门槛
 *   (发布链 set-mobile-min-version --clear)后,用户下次冷启动即恢复;若落盘,撤回
 *   就再也救不回被误挡的装机。
 * 而"杀进程绕过"并不成立:下次启动会重新拉 /latest 并立刻命中同一个门槛。
 *
 * 四层保证"不会把人永久挡在门外":
 * 1. 拉不到 /latest(离线 / 超时 / 5xx)→ 调用方 fail-open,不进入阻断态;
 * 2. 拿不到可跳转的安装地址 → 不进入阻断态(见 promptBundleUpdate),不造无出口的屏;
 * 3. 门槛必须 ≤ 该 record 宣告的 version(发布链 assertMinVersionUsable fail closed),
 *    所以装上被广播的那个版本必然解除阻断;
 * 4. 阻断期间业务树整体不挂载 —— resume 检查也随之停摆,所以阻断屏自带一次
 *    "回前台重新核对"(见 forcedUpdateRecheck):服务端撤回门槛后不必杀进程冷启动,
 *    切出去再回来即自动解除。
 */
import { useSyncExternalStore } from 'react';

/** 阻断屏需要的目标信息(evaluateBundleUpdate 的 target 子集)。 */
export interface ForcedUpdateTarget {
  version: string;
  runtimeVersion: string;
  installUrl: string;
  itmsUrl: string;
  releaseNotes?: string;
}

let forcedTarget: ForcedUpdateTarget | null = null;
/**
 * 每次目标真正变化(含解除)自增。用于 compare-and-set:
 * 检查是异步的,一次检查发起后到落地前,别的路径(启动检查的迟到响应、阻断屏重挂后的
 * 新一轮核对)可能已经写入更新的观察。带着"发起时的 revision"回来的旧结论必须作废,
 * 否则会出现「旧响应清掉新版强更状态」——业务树在最新观察仍要求强更时重新挂载。
 */
let revision = 0;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  // 单个订阅者异常不能影响其它订阅者(与 canaryChannelStore 同口径)。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function isSameTarget(a: ForcedUpdateTarget | null, b: ForcedUpdateTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.version === b.version
    && a.runtimeVersion === b.runtimeVersion
    && a.installUrl === b.installUrl
    && a.itmsUrl === b.itmsUrl
    && a.releaseNotes === b.releaseNotes;
}

/**
 * 进入强更阻断态。幂等:同一目标重复调用不通知订阅者(三条检查路径都可能反复命中,
 * 尤其 resume 每 5 分钟一次;不做等值判断会引发无意义重渲染)。
 *
 * expectedRevision 可选:传入则做 compare-and-set —— 只有 store 自本次检查发起以来
 * 没被更新的观察改写过才生效。首次进入(promptBundleUpdate)不传,它就是最新观察。
 */
export function enterForcedUpdate(target: ForcedUpdateTarget, expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== revision) return;
  if (isSameTarget(forcedTarget, target)) {
    // 不带 expectedRevision 的调用代表**另一条检查路径的一次新观察**落地。即使目标等值、
    // 没有状态变化,也必须推进 revision:否则在途重新核对基于旧 revision 得出的"解除"
    // 结论仍能通过 compare-and-clear,把最新观察仍要求强更的阻断态清掉。
    // 不通知订阅者 —— 状态确实没变,幂等语义不受影响。
    if (expectedRevision === undefined) revision += 1;
    return;
  }
  forcedTarget = target;
  revision += 1;
  notifyListeners();
}

/**
 * 解除阻断态(生产入口,不是测试专用)。
 * 唯一调用方是阻断屏的重新核对:**成功**拉到 /latest 且判定不再强更时才解除
 * —— 不能在拉取失败时解除,否则断网就能绕过强更。
 *
 * expectedRevision 可选:传入则做 compare-and-clear —— 本次核对发起后若有更新的观察
 * 写入了强更目标,这条旧结论作废,不得把用户放进业务树。
 */
export function clearForcedUpdate(expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== revision) return;
  if (forcedTarget === null) return;
  forcedTarget = null;
  revision += 1;
  notifyListeners();
}

/** 当前 revision;检查发起时读一次,落地时回传做 compare-and-set。 */
export function getForcedUpdateRevision(): number {
  return revision;
}

/** 当前阻断目标;null = 未命中强更。 */
export function getForcedUpdateTarget(): ForcedUpdateTarget | null {
  return forcedTarget;
}

/** 订阅阻断态变化;返回取消订阅函数。 */
export function subscribeForcedUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** root 层消费:命中强更时返回目标,用于渲染阻断屏。 */
export function useForcedUpdate(): ForcedUpdateTarget | null {
  return useSyncExternalStore(subscribeForcedUpdate, getForcedUpdateTarget, getForcedUpdateTarget);
}

export const __testing = {
  reset(): void {
    forcedTarget = null;
    revision = 0;
    listeners.clear();
  },
};
