export interface OrcaUiAssignmentHistoryGate {
  /** 等到目标 Lead 至少有一条 snapshot 之后的 user 消息可查询。 */
  waitUntilQueryable(leadSessionId: string, snapshotBeforeMs: number): Promise<boolean>;
  /** 用户消息落库后通知等待者；调用点必须位于 durable persist 回调。 */
  notifyUserMessagePersisted(leadSessionId: string): void;
}

export interface OrcaUiAssignmentDispatchClaims {
  /** 同一份 UI assignment 在 Main 进程生命周期内只执行一次，并发调用共享同一结果。 */
  runOnce<T>(
    params: { leadSessionId: string; workerSessionId: string; snapshotBeforeMs: number },
    dispatch: () => Promise<T>,
  ): Promise<T>;
}

export function createOrcaUiAssignmentDispatchClaims(): OrcaUiAssignmentDispatchClaims {
  const claims = new Map<string, Promise<unknown>>();

  return {
    runOnce(params, dispatch) {
      const key = JSON.stringify([
        params.leadSessionId,
        params.workerSessionId,
        params.snapshotBeforeMs,
      ]);
      const existing = claims.get(key);
      if (existing) return existing as ReturnType<typeof dispatch>;

      // 先登记 promise，再在 microtask 中派发，避免同一事件循环内的两个窗口都穿透。
      // 已完成的 claim 也刻意保留：结果不确定时，重试仍不能冒险重复投递。
      const claimed = Promise.resolve().then(dispatch);
      claims.set(key, claimed);
      return claimed;
    },
  };
}

export function createOrcaUiAssignmentHistoryGate(deps: {
  hasUserMessageSince: (leadSessionId: string, snapshotBeforeMs: number) => Promise<boolean>;
  timeoutMs?: number;
}): OrcaUiAssignmentHistoryGate {
  const waiters = new Map<string, Set<() => void>>();
  const timeoutMs = deps.timeoutMs ?? 30_000;

  const removeWaiter = (leadSessionId: string, resolve: () => void) => {
    const current = waiters.get(leadSessionId);
    current?.delete(resolve);
    if (current?.size === 0) waiters.delete(leadSessionId);
  };

  return {
    async waitUntilQueryable(leadSessionId, snapshotBeforeMs) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        let notify!: () => void;
        const persisted = new Promise<void>((resolve) => {
          notify = resolve;
        });
        const current = waiters.get(leadSessionId) ?? new Set<() => void>();
        current.add(notify);
        waiters.set(leadSessionId, current);

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // 先登记 waiter 再查 DB：消息若恰在查询期间落库，通知不会丢；若更早已落库，
          // 查询直接命中。notify 只是“值得复查”的提示，不是可查询性的证据——同 session
          // 的其它消息也会触发通知，且 clear/rewind 可能紧跟在 durable write 之后。
          if (await deps.hasUserMessageSince(leadSessionId, snapshotBeforeMs)) return true;
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) return false;
          const notified = await Promise.race([
            persisted.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), remainingMs);
            }),
          ]);
          if (!notified) {
            // deadline 边沿再查一次，覆盖 commit 与 timeout 同拍、通知尚未执行的情况。
            return deps.hasUserMessageSince(leadSessionId, snapshotBeforeMs);
          }
        } finally {
          if (timer) clearTimeout(timer);
          removeWaiter(leadSessionId, notify);
        }
        // 被通知后重新登记 waiter + 查 DB；绝不把 callback 本身当成历史可见性。
      }
    },

    notifyUserMessagePersisted(leadSessionId) {
      for (const resolve of waiters.get(leadSessionId) ?? []) resolve();
    },
  };
}
