import { setImmediate } from 'node:timers/promises';

/** FIFO, concurrency one. Yield between jobs so a batch does not monopolize Main. */
function serialQueue() {
  let tail = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      await setImmediate();
      return task();
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

// Session shutdown must be queued before taking route locks. The lower queue is
// shared with pool eviction and cross-database retries; neither queue is reentrant.
export const queueSessionWorktreeRecycle = serialQueue();
export const withWorktreeRecycleSlot = serialQueue();
