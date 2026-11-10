import type { Logger } from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';

type Timer = ReturnType<typeof setTimeout>;

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
    opts?: { forceSkip?: boolean },
  ): Promise<void> {
    if (opts?.forceSkip === true) {
      // 关闭方在首个 await 前取样的抑制态:Maker.close 不等 onClose,调用方的
      // 窗口可能在本钩子跑到这里之前就已释放 —— 时序上必须信入口取样,不能重查。
      log.debug('skip onClose side-effects: suppression captured at close entry', { sessionId });
      return;
    }
    if (shutdownSuppressed) {
      log.debug('skip onClose side-effects during shutdown', { sessionId });
      return;
    }
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
