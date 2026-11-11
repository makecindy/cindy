import type { Logger, MakerSessionCloseFacts } from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';

type Timer = ReturnType<typeof setTimeout>;

/**
 * onClose 是否跳过 worktree 释放与暂存附件清理——即这次 close 是不是瞬态重建。
 *
 * transient 由 Maker 在 close 请求入口取样（调用方的抑制窗口此刻一定还在），
 * 不靠 onClose 里的时序；runtime-refresh 本身就是「刷新后重建」语义，不看窗口。
 * suppressedAtEntry 必须由调用方在钩子首个 await 前取样：自关闭（handle 在
 * preflight 中自己退出）不过 Maker 的 close 请求，事实是 unexpected/false，
 * 只能靠这个入口快照兜底。
 */
export function shouldSkipOnCloseSideEffects(
  close: MakerSessionCloseFacts,
  suppressedAtEntry: boolean,
): boolean {
  return close.transient || close.reason === 'runtime-refresh' || suppressedAtEntry;
}

export function createRehydrateCloseSuppression(
  log: Pick<Logger, 'debug' | 'warn'>,
  timeoutMs = 30_000,
) {
  const suppressed = new Map<string, Timer>();
  // app 退出期一刀切抑制:shutdown 触发的批量 onClose 是 fire-and-forget 的,
  // worktree stash/删除会和进程退出竞争,可能删到一半留下半拆状态。退出期跳过
  // 全部重副作用,worktree 原样留在磁盘,下次启动 recoverPool 对账。不可逆——
  // 进程马上就没了,没有"解除抑制"的场景。
  let shutdownSuppressed = false;

  function release(sessionId: string, timer?: Timer): void {
    const current = suppressed.get(sessionId);
    if (!current) return;
    if (timer && current !== timer) return;
    clearTimeout(current);
    suppressed.delete(sessionId);
  }

  async function withSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    release(sessionId);
    const timer = setTimeout(() => {
      if (suppressed.get(sessionId) !== timer) return;
      log.warn('rehydrate suppress timeout, releasing', { sessionId });
      suppressed.delete(sessionId);
    }, timeoutMs);
    suppressed.set(sessionId, timer);
    try {
      return await fn();
    } finally {
      release(sessionId, timer);
    }
  }

  async function runOnCloseSideEffects(
    sessionId: string,
    fn: () => Promise<void>,
    opts?: { skip?: boolean },
  ): Promise<void> {
    if (opts?.skip === true) {
      // 关闭方在 close 请求入口固化的瞬态事实。close 不等 onClose，窗口在本钩子
      // 跑到这里之前就可能已释放，所以只认请求入口的结论，不重查时序。
      log.debug('skip onClose side-effects: transient close', { sessionId });
      return;
    }
    if (shutdownSuppressed) {
      log.debug('skip onClose side-effects during shutdown', { sessionId });
      return;
    }
    // 自关闭（没有走 close 请求）恰好落在窗口内：入口快照已经带了 skip；
    // 这里保留一层兜底，防止调用方没取样就掉到重副作用。
    if (suppressed.has(sessionId)) {
      log.debug('skip onClose side-effects during rehydrate', { sessionId });
      return;
    }
    await fn();
  }

  function suppressAllForShutdown(): void {
    shutdownSuppressed = true;
  }

  function resetForTest(): void {
    for (const timer of suppressed.values()) clearTimeout(timer);
    suppressed.clear();
    shutdownSuppressed = false;
  }

  return {
    withSuppressed,
    runOnCloseSideEffects,
    suppressAllForShutdown,
    resetForTest,
    isSuppressed: (sessionId: string) => suppressed.has(sessionId),
  };
}

export const rehydrateCloseSuppression = createRehydrateCloseSuppression(
  desktopMakerLogger.child('rehydrate-close'),
);

export function withRehydrateCloseSuppressed<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return rehydrateCloseSuppression.withSuppressed(sessionId, fn);
}
