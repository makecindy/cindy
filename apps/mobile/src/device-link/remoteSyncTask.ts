import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { withTransientRemoteRetry } from './remoteRetry';

export interface RemoteSyncRunner {
  run(): Promise<void>;
  isRunning(): boolean;
}

export interface RemoteSyncReopenCoordinator {
  captureVersion(): number;
  reopenAfter(failedAtVersion: number): Promise<void>;
}

/**
 * 同一轮 session sync 按「故障发生时看到的恢复版本」合并 peer 重开。
 * 同一旧代上错峰返回的失败共用一次 reopen；reopen 后真正发出的请求若再次失败，
 * 会携带新版本触发下一次 reopen。失败的 reopen 不推进版本，允许后续继续自愈。
 */
export function createRemoteSyncReopenCoordinator(
  reopen: () => Promise<void>,
): RemoteSyncReopenCoordinator {
  let successfulVersion = 0;
  let recovery: {
    coveredFailureVersion: number;
    promise: Promise<void>;
  } | null = null;

  return {
    captureVersion: () => successfulVersion,
    reopenAfter(failedAtVersion): Promise<void> {
      if (recovery && recovery.coveredFailureVersion >= failedAtVersion) {
        return recovery.promise;
      }
      const nextVersion = successfulVersion + 1;
      const attempt = Promise.resolve().then(reopen).then(() => {
        successfulVersion = nextVersion;
      });
      const entry = { coveredFailureVersion: failedAtVersion, promise: attempt };
      recovery = entry;
      void attempt.catch(() => {
        if (recovery === entry) recovery = null;
      });
      return attempt;
    },
  };
}

/**
 * Coalesces repeated resync triggers into one in-flight run plus at most one
 * follow-up run. This matches mobile foreground/reconnect behavior where
 * pull-to-refresh, status changes, and push reseed can fire close together.
 */
export function createRemoteSyncRunner(task: () => Promise<void>): RemoteSyncRunner {
  let inFlight: Promise<void> | null = null;
  let runAgain = false;

  async function drain(): Promise<void> {
    do {
      runAgain = false;
      await task();
    } while (runAgain);
  }

  return {
    run(): Promise<void> {
      if (inFlight) {
        runAgain = true;
        return inFlight;
      }
      inFlight = drain().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isRunning(): boolean {
      return !!inFlight;
    },
  };
}

export function useRemoteSyncTask(task: () => Promise<void>): () => Promise<void> {
  const taskRef = useRef(task);
  const runnerRef = useRef<RemoteSyncRunner | null>(null);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  if (!runnerRef.current) {
    runnerRef.current = createRemoteSyncRunner(() => taskRef.current());
  }

  return useCallback(() => runnerRef.current?.run() ?? Promise.resolve(), []);
}

export interface RemoteSyncRequest {
  reason: string;
  /** 权威整窗替换(如 rewind commit):使当前在途普通读取失效,并在后续轮次胜出。 */
  replaceMessages?: boolean;
}

export interface RemoteSyncRun {
  reasons: readonly string[];
  replaceMessages: boolean;
  /** 请求发起后 sync identity / 权威替换发生变化时,旧结果不得再提交。 */
  isStale(): boolean;
  signal: AbortSignal;
  /** A successful snapshot may cover a notification queued while it was starting. */
  satisfy(reason: string): void;
}

/** Cancels the local wait; late transport replies remain fenced by isStale/authority. */
export function waitForRemoteSync<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Remote sync superseded'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Remote sync superseded'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      operation().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

/** Invalidation interrupts both an in-flight read and retry backoff, without reopening a stale peer. */
export function retryRemoteSyncRead<T>(run: Pick<RemoteSyncRun, 'signal' | 'isStale'>, read: () => Promise<T>): Promise<T> {
  return waitForRemoteSync(run.signal, () => withTransientRemoteRetry(() => {
    if (run.isStale()) throw new Error('Remote sync superseded');
    return waitForRemoteSync(run.signal, read);
  }));
}

export interface RemoteSyncCoordinator {
  setContext(contextKey: string): void;
  request(request: RemoteSyncRequest): Promise<void>;
  isRunning(): boolean;
}

interface PendingRemoteSync {
  reasons: Set<string>;
  replaceMessages: boolean;
}

function mergeRemoteSyncRequest(
  current: PendingRemoteSync | null,
  request: RemoteSyncRequest,
): PendingRemoteSync {
  const next = current ?? { reasons: new Set<string>(), replaceMessages: false };
  next.reasons.add(request.reason);
  next.replaceMessages = next.replaceMessages || request.replaceMessages === true;
  return next;
}

/**
 * Session sync coordinator:同一时刻最多一轮有效读取,被动触发合并成至多一轮 follow-up。
 * context 变化会使旧轮次失效;权威整窗替换还会立即废弃同 context 的旧普通读取,
 * 防止 rewind 后迟到的 reopen 结果把已删除消息重新写回。
 */
export function createRemoteSyncCoordinator(
  task: (run: RemoteSyncRun) => Promise<void>,
): RemoteSyncCoordinator {
  let contextKey: string | null = null;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let pending: PendingRemoteSync | null = null;
  let controller: AbortController | null = null;

  const drain = async (): Promise<void> => {
    let firstError: unknown = null;
    while (pending) {
      const next = pending;
      pending = null;
      // A sibling of a failed Promise.all may still be settling when the next
      // run starts, even without a connection change. It cannot commit over it.
      const capturedGeneration = ++generation;
      const runController = new AbortController();
      controller = runController;
      try {
        const run: RemoteSyncRun = {
          reasons: [...next.reasons],
          replaceMessages: next.replaceMessages,
          isStale: () => generation !== capturedGeneration || runController.signal.aborted,
          signal: runController.signal,
          satisfy(reason) {
            if (generation !== capturedGeneration || !pending) return;
            pending.reasons.delete(reason);
            if (pending.reasons.size === 0 && !pending.replaceMessages) pending = null;
          },
        };
        // Start synchronously so callers can enqueue a follow-up in this same turn.
        const result = task(run);
        void result.catch(() => undefined);
        await waitForRemoteSync(runController.signal, () => result);
      } catch (error) {
        const cancelled = runController.signal.aborted;
        runController.abort();
        if (!cancelled && generation === capturedGeneration) firstError ??= error;
      } finally {
        if (controller === runController) controller = null;
      }
    }
    if (firstError !== null) throw firstError;
  };

  return {
    setContext(nextContextKey: string): void {
      if (contextKey === nextContextKey) return;
      contextKey = nextContextKey;
      generation += 1;
      controller?.abort();
      // 旧 identity 尚未执行的 follow-up 没有提交资格;新 identity 的调用方会立即 request。
      pending = null;
    },
    request(request: RemoteSyncRequest): Promise<void> {
      if (request.replaceMessages === true) {
        // 权威替换必须让已经发出的普通窗口读取失效,并独占下一轮 pending options。
        generation += 1;
        controller?.abort();
        pending = null;
      }
      pending = mergeRemoteSyncRequest(pending, request);
      if (inFlight) return inFlight;
      inFlight = drain().finally(() => {
        inFlight = null;
      });
      // Passive refresh callers intentionally do not await. Observe the rejection
      // without changing the promise returned to rewind/navigation callers.
      void inFlight.catch(() => undefined);
      return inFlight;
    },
    isRunning(): boolean {
      return inFlight !== null;
    },
  };
}

export function useRemoteSyncCoordinator(
  task: (run: RemoteSyncRun) => Promise<void>,
  contextKey: string,
): (request: RemoteSyncRequest) => Promise<void> {
  const taskRef = useRef(task);
  const coordinatorRef = useRef<RemoteSyncCoordinator | null>(null);
  coordinatorRef.current ??= createRemoteSyncCoordinator((run) => taskRef.current(run));
  useLayoutEffect(() => {
    taskRef.current = task;
    coordinatorRef.current?.setContext(contextKey);
  }, [contextKey, task]);
  useEffect(() => () => coordinatorRef.current?.setContext('unmounted'), []);

  return useCallback(
    (request: RemoteSyncRequest) => coordinatorRef.current?.request(request) ?? Promise.resolve(),
    [],
  );
}
