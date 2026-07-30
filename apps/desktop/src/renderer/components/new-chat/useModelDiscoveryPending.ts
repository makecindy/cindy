/**
 * useModelDiscoveryPending —— 「打开模型选择器触发的那次模型发现还在途吗」。
 *
 * 为什么需要它:发现不是本地读取 —— ChatGPT 订阅那条要起一个 codex app-server 再 RPC 列模型,
 * 秒级到十几秒。以前这个过程完全静默,列表在用户看完关掉之后才更新,于是「只能看到少数模型,
 * 进一次设置页再回来就全了」——用户以为是设置页刷新的功劳,其实是那几秒没等到。
 *
 * main 侧的 handler 会 await 整轮刷新才 resolve,所以这个 promise 的生命周期就是发现过程本身,
 * 不需要额外的推送通道。抽成 hook 是因为它有真实的并发语义(下面两条),值得单独锁住:
 *
 *   1. **防交错**:快速开关几次时,只有最后一次发起的结果能落回状态 —— 否则先发起的那次
 *      回来会把后发起的那次清成 false,状态行提前消失。
 *   2. **关闭即收起**:面板不可见期间状态行没有意义;但在途的那次仍归它自己收尾,绝不因为
 *      关闭就把 requestId 前移 —— 那会让它回来时清掉下一轮刚开始的状态。
 */

import { useCallback, useRef, useState } from 'react';

export interface ModelDiscoveryPending {
  /** 是否有一次由本 hook 发起、且仍在途的发现。 */
  pending: boolean;
  /** 面板打开时调用:发起一次发现并进入 pending。 */
  begin: (run: () => Promise<unknown>) => void;
  /** 面板关闭时调用:立即收起状态,不影响在途请求的归属。 */
  reset: () => void;
}

export function useModelDiscoveryPending(): ModelDiscoveryPending {
  const [pending, setPending] = useState(false);
  const requestIdRef = useRef(0);

  const begin = useCallback((run: () => Promise<unknown>): void => {
    const requestId = ++requestIdRef.current;
    setPending(true);
    // **同步**发起,不经 Promise.resolve().then(run) 推迟一个微任务:那样会让「打开面板
    // 就发起一次刷新」变成异步,调用方与测试都观察不到当次点击引发的请求(实测回归)。
    let flight: Promise<unknown>;
    try {
      flight = run();
    } catch {
      // run 同步抛(IPC 桥缺失等)→ 不留悬空的 pending。
      if (requestIdRef.current === requestId) setPending(false);
      return;
    }
    void Promise.resolve(flight)
      // 发现失败与发现完成对这个状态行是同一件事:都该收起。失败本身另有归因通道
      // (设置页的「上次获取结果」与 modelDiscoveryFailure),不在这里讲。
      .catch(() => undefined)
      .finally(() => {
        if (requestIdRef.current === requestId) setPending(false);
      });
  }, []);

  const reset = useCallback((): void => {
    setPending(false);
  }, []);

  return { pending, begin, reset };
}
