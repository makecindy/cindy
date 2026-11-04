import { DeviceLinkError } from '@cindy/device-link';

/**
 * Returning to the foreground makes every mounted roster, card and home row refresh at once.
 * The per-peer InvokeScheduler allows 12 at a time for each computer, so several computers can
 * deliver hundreds of responses while the JS thread is also restoring the open task. These
 * refresh reads are spread out across all computers instead; anything else keeps its own path.
 */
const LOW_PRIORITY_READ_CHANNELS: ReadonlySet<string> = new Set([
  'git-context:pr-refs:list',
  'git-context:pr-status',
  'maker:remote-resources:manifest',
  'maker:remote-resources:list',
]);

export const LOW_PRIORITY_READ_MAX_ACTIVE = 4;
const MAX_QUEUED = 256;
/**
 * How long a read may wait for a slot. InvokeScheduler's own expiry only starts once a task
 * runs, so without this a backlog of slow reads would keep an expired refresh queued indefinitely.
 */
export const LOW_PRIORITY_READ_MAX_WAIT_MS = 15_000;

export function isLowPriorityRead(channel: string): boolean {
  return LOW_PRIORITY_READ_CHANNELS.has(channel);
}

interface QueuedRead {
  key: string | null;
  task: () => Promise<unknown>;
  enqueuedAt: number;
  expiry: ReturnType<typeof setTimeout> | undefined;
  waiters: { resolve(value: unknown): void; reject(reason: unknown): void }[];
}

export interface LowPriorityReadGate {
  /**
   * A `key` joins an identical read that has not been dispatched yet. Joining one already on the
   * wire could hand back a snapshot taken before the change this caller is refreshing for, so an
   * in-flight read is never shared. Pass null when the task has caller-specific cancellation.
   * Joined callers receive the same result object, as useRemoteCompanionQuery's cards already do;
   * consumers of these channels normalize or copy it rather than mutating it.
   */
  run<T>(key: string | null, task: () => Promise<T>): Promise<T>;
}

export function createLowPriorityReadGate(
  maxActive = LOW_PRIORITY_READ_MAX_ACTIVE,
  maxWaitMs = LOW_PRIORITY_READ_MAX_WAIT_MS,
  now: () => number = Date.now,
): LowPriorityReadGate {
  const queue: QueuedRead[] = [];
  const queuedByKey = new Map<string, QueuedRead>();
  let active = 0;

  const expiredError = () => new DeviceLinkError('BACKPRESSURE', 'low-priority read waited too long for a slot');
  const leaveQueue = (read: QueuedRead) => {
    clearTimeout(read.expiry);
    if (read.key !== null && queuedByKey.get(read.key) === read) queuedByKey.delete(read.key);
  };
  const expire = (read: QueuedRead) => {
    const index = queue.indexOf(read);
    if (index >= 0) queue.splice(index, 1);
    leaveQueue(read);
    for (const waiter of read.waiters) waiter.reject(expiredError());
  };

  const drain = () => {
    while (active < maxActive && queue.length > 0) {
      const read = queue.shift()!;
      leaveQueue(read);
      // The timer normally fires first; this covers a timer delayed by a busy JS thread.
      if (now() - read.enqueuedAt >= maxWaitMs) {
        for (const waiter of read.waiters) waiter.reject(expiredError());
        continue;
      }
      active += 1;
      void Promise.resolve()
        .then(read.task)
        .then(
          (value) => { for (const waiter of read.waiters) waiter.resolve(value); },
          (error: unknown) => { for (const waiter of read.waiters) waiter.reject(error); },
        )
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run<T>(key: string | null, task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const waiter = { resolve: resolve as (value: unknown) => void, reject };
        const joined = key === null ? undefined : queuedByKey.get(key);
        if (joined) {
          joined.waiters.push(waiter);
          return;
        }
        if (queue.length >= MAX_QUEUED) {
          reject(new DeviceLinkError('BACKPRESSURE', 'too many low-priority reads queued'));
          return;
        }
        const read: QueuedRead = { key, task, enqueuedAt: now(), expiry: undefined, waiters: [waiter] };
        read.expiry = setTimeout(() => expire(read), maxWaitMs);
        queue.push(read);
        if (key !== null) queuedByKey.set(key, read);
        drain();
      });
    },
  };
}
