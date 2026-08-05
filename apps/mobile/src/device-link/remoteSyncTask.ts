import { useCallback, useEffect, useRef } from 'react';

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
