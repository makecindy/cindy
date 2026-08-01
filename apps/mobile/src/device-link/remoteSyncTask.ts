import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export interface RemoteSyncRunner {
  run(): Promise<void>;
  isRunning(): boolean;
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
 * Session sync coordinator:同一时刻最多一轮网络读取,被动触发合并成至多一轮 follow-up。
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

  const drain = async (): Promise<void> => {
    let firstError: unknown = null;
    while (pending) {
      const next = pending;
      pending = null;
      const capturedGeneration = generation;
      try {
        await task({
          reasons: [...next.reasons],
          replaceMessages: next.replaceMessages,
          isStale: () => generation !== capturedGeneration,
        });
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== null) throw firstError;
  };

  return {
    setContext(nextContextKey: string): void {
      if (contextKey === nextContextKey) return;
      contextKey = nextContextKey;
      generation += 1;
      // 旧 identity 尚未执行的 follow-up 没有提交资格;新 identity 的调用方会立即 request。
      pending = null;
    },
    request(request: RemoteSyncRequest): Promise<void> {
      if (request.replaceMessages === true) {
        // 权威替换必须让已经发出的普通窗口读取失效,并独占下一轮 pending options。
        generation += 1;
        pending = null;
      }
      pending = mergeRemoteSyncRequest(pending, request);
      if (inFlight) return inFlight;
      inFlight = drain().finally(() => {
        inFlight = null;
      });
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

  return useCallback(
    (request: RemoteSyncRequest) => coordinatorRef.current?.request(request) ?? Promise.resolve(),
    [],
  );
}
