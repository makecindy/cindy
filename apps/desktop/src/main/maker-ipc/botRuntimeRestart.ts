/** Host-owned restart coordination. A failed/stalled old runtime must never replay input. */
export async function restartBotRuntime(
  sessionId: string,
  assertOwnerCurrent: () => void,
  deps: {
    stopInput(sessionId: string): void;
    /**
     * Stop 之后把队列快照(连同「暂停来源」标记)落盘。
     * 重启报成功之前必须落盘成功:否则进程随后退出时,快照里没有暂停来源,
     * 恢复会把它当成崩溃恢复暂停,外部投递就会重放用户已经收手的请求(#7534)。
     */
    flushStopPersistence?(sessionId: string): Promise<void>;
    withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
    rebuild(sessionId: string, assertCurrent: () => void, signal: AbortSignal): Promise<void>;
    onClosed(sessionId: string): void;
  },
): Promise<void> {
  const controller = new AbortController();
  const assertCurrent = () => {
    assertOwnerCurrent();
    controller.signal.throwIfAborted();
  };
  assertCurrent();
  deps.stopInput(sessionId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Bot restart timed out');
      controller.abort(error);
      reject(error);
    }, 30_000);
  });
  const operation = deps.withSessionLock(sessionId, async () => {
    assertCurrent();
    // 暂停来源先落盘,再重建运行时:重建成功即意味着「用户已收手」这件事是持久的。
    // 落盘失败就让重启失败(explicitStopImpl 同款:失败此时才抛),不带着未落盘的
    // 暂停来源报成功。
    await deps.flushStopPersistence?.(sessionId);
    assertCurrent();
    await deps.rebuild(sessionId, assertCurrent, controller.signal);
    assertCurrent();
    deps.onClosed(sessionId);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    // If the deadline wins, withSessionRestartLock keeps the session fenced
    // until rebuild settles. New work fails promptly; no watchdog can admit
    // a replacement while native close still runs. assertCurrent forbids
    // a late handoff/DB rebuild.
  }
}
