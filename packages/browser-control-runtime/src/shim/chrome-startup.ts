import type { ChildProcess } from 'node:child_process';

/** Keep process errors local while startup waits on preferences or CDP. */
export function monitorChromeStartup(proc: ChildProcess) {
  const { promise: failure, reject } = Promise.withResolvers<never>();
  let rejectFailure: ((error: Error) => void) | undefined = reject;
  // A process can fail between waits; never leave that rejection unobserved.
  void failure.catch(() => {});
  const onError = (error: Error) => rejectFailure?.(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectFailure?.(new Error(`Chrome exited before startup completed (code ${code}, signal ${signal}).`));
  };
  const onClose = () => {
    proc.off('error', onError);
    proc.off('exit', onExit);
    proc.off('close', onClose);
  };
  proc.on('error', onError);
  proc.once('exit', onExit);
  proc.once('close', onClose);

  const wait = <T>(pending: Promise<T>): Promise<T> => Promise.race([failure, pending]);
  return {
    proc,
    async spawned() {
      const { promise, resolve } = Promise.withResolvers<void>();
      proc.once('spawn', resolve);
      try {
        await wait(promise);
      } finally {
        proc.off('spawn', resolve);
      }
    },
    wait,
    async delay(ms: number) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, ms);
      try {
        await wait(promise);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose() {
      rejectFailure = undefined;
      proc.off('exit', onExit);
      // Errors from later kill()/IPC failures must not become uncaught errors.
      // Keep the now-inert error listener only until the process closes.
    },
  };
}
