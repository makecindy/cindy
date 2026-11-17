import type { ChildProcess } from 'node:child_process';

const STDERR_DRAIN_TIMEOUT_MS = 250;

/** Keep process errors local while startup waits on preferences or CDP. */
export function monitorChromeStartup(proc: ChildProcess, wrapped = false) {
  const { promise: failure, reject } = Promise.withResolvers<never>();
  let rejectFailure: ((error: Error) => void) | undefined = reject;
  // A process can fail between waits; never leave that rejection unobserved.
  void failure.catch(() => {});
  const onError = (error: Error) => rejectFailure?.(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectFailure?.(Object.assign(
      new Error(`Chrome exited before startup completed (code ${code}, signal ${signal}).`),
      { exitCode: code, signal },
    ));
  };
  const onClose = () => {
    proc.off('error', onError);
    proc.off('exit', onExit);
    proc.off('close', onClose);
  };
  proc.on('error', onError);
  proc.once('exit', onExit);
  proc.once('close', onClose);
  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => stderrChunks.push(chunk);
  proc.stderr?.on('data', onStderr);

  const wait = <T>(pending: Promise<T>): Promise<T> => Promise.race([failure, pending]);
  return {
    proc,
    wrapped,
    readStderr() {
      return Buffer.concat(stderrChunks).toString('utf8');
    },
    async drainStderr() {
      const stderr = proc.stderr;
      // A spawn ENOENT has no process or diagnostic pipe to wait for.
      // Live-process errors also must not wait for a future process exit.
      if (
        proc.pid == null || (proc.exitCode == null && proc.signalCode == null) ||
        !stderr || stderr.readableEnded || stderr.destroyed
      ) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, STDERR_DRAIN_TIMEOUT_MS);
      const onComplete = () => resolve();
      stderr.once('end', onComplete);
      stderr.once('close', onComplete);
      stderr.once('error', onComplete);
      try {
        await promise;
      } finally {
        clearTimeout(timer);
        stderr.off('end', onComplete);
        stderr.off('close', onComplete);
        stderr.off('error', onComplete);
      }
    },
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
      proc.stderr?.off('data', onStderr);
      stderrChunks.length = 0;
      // Errors from later kill()/IPC failures must not become uncaught errors.
      // Keep the now-inert error listener only until the process closes.
    },
  };
}
