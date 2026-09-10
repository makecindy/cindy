/** Host-owned restart coordination. A failed/stalled old runtime must never replay input. */
export async function restartBotRuntime(
  sessionId: string,
  assertOwnerCurrent: () => void,
  deps: {
    stopInput(sessionId: string): void;
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
    await deps.rebuild(sessionId, assertCurrent, controller.signal);
    assertCurrent();
    deps.onClosed(sessionId);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    // If the deadline won, the original close keeps its workspace-preservation
    // scope until it settles. assertCurrent forbids a late handoff/DB rebuild.
  }
}
