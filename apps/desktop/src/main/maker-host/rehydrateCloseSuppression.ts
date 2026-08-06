import type { Logger } from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';

type Timer = ReturnType<typeof setTimeout>;

export function createRehydrateCloseSuppression(
  log: Pick<Logger, 'debug' | 'warn'>,
  timeoutMs = 30_000,
) {
  const suppressed = new Map<string, Timer>();
  // Active Orca send 里的 runtime replacement close 需要比通用 onClose 抑制更窄的
  // 标记：旧 Session 关闭时仍要跑凭证切换、Git snapshot 等常规清理，唯独不能把
  // 正在驱动这次重建的 input coordinator transaction 当成真正会话关闭而取消。
  // 用 depth 而不是 Set，避免同一 session 的嵌套 helper 提前释放外层标记。
  const inputPreservingRuntimeReplacementCloseDepth = new Map<string, number>();
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

  async function withInputPreservingRuntimeReplacementClose<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const depth = inputPreservingRuntimeReplacementCloseDepth.get(sessionId) ?? 0;
    inputPreservingRuntimeReplacementCloseDepth.set(sessionId, depth + 1);
    try {
      return await fn();
    } finally {
      const current = inputPreservingRuntimeReplacementCloseDepth.get(sessionId) ?? 1;
      if (current <= 1) inputPreservingRuntimeReplacementCloseDepth.delete(sessionId);
      else inputPreservingRuntimeReplacementCloseDepth.set(sessionId, current - 1);
    }
  }

  function runInputCoordinatorSessionClosed(sessionId: string, fn: () => void): void {
    if ((inputPreservingRuntimeReplacementCloseDepth.get(sessionId) ?? 0) > 0) {
      log.debug('skip input coordinator close during runtime replacement', { sessionId });
      return;
    }
    fn();
  }

  async function runOnCloseSideEffects(
    sessionId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
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
    inputPreservingRuntimeReplacementCloseDepth.clear();
    shutdownSuppressed = false;
  }

  return {
    withSuppressed,
    withInputPreservingRuntimeReplacementClose,
    runInputCoordinatorSessionClosed,
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

export function withInputPreservingRuntimeReplacementClose<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return rehydrateCloseSuppression.withInputPreservingRuntimeReplacementClose(sessionId, fn);
}
