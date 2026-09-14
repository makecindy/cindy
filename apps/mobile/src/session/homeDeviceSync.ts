export const HOME_DEVICE_SYNC_CONCURRENCY = 6;

export interface HomeDeviceSyncCandidate {
  canOpen: boolean;
  deviceId: string;
}

type HomeDeviceSyncTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Shared Home device-work limiter. Separate list/reseed/schedule/project-order triggers all
 * enter the same pool, so overlapping effects cannot each create their own six-device burst.
 */
export class HomeDeviceSyncLimiter {
  private readonly maxConcurrent: number;
  private readonly foregroundQueue: HomeDeviceSyncTask<unknown>[] = [];
  private readonly backgroundQueue: HomeDeviceSyncTask<unknown>[] = [];
  private active = 0;

  constructor(maxConcurrent: number = HOME_DEVICE_SYNC_CONCURRENCY) {
    this.maxConcurrent = normalizeConcurrency(maxConcurrent);
  }

  run<T>(
    task: () => Promise<T>,
    priority: 'foreground' | 'background' = 'background',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queued: HomeDeviceSyncTask<T> = { run: task, resolve, reject };
      const queue = priority === 'foreground' ? this.foregroundQueue : this.backgroundQueue;
      queue.push(queued as HomeDeviceSyncTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const task = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
      if (!task) return;
      this.active += 1;
      let promise: Promise<unknown>;
      try {
        promise = task.run();
      } catch (error) {
        this.active -= 1;
        task.reject(error);
        continue;
      }
      void promise.then(task.resolve, task.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

/**
 * 首页列表级同步范围：
 * - “所有任务”同步全部当前可控制设备；
 * - 单设备筛选只同步该设备；
 * - 不可控制设备只保留设备清单 / presence，不发列表级请求。
 */
export function resolveHomeDeviceSyncIds(
  devices: readonly HomeDeviceSyncCandidate[],
  selectedDeviceId: string | null,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    if (!device.canOpen || !device.deviceId || seen.has(device.deviceId)) continue;
    if (selectedDeviceId && device.deviceId !== selectedDeviceId) continue;
    seen.add(device.deviceId);
    ids.push(device.deviceId);
  }
  return ids;
}

export interface HomeDeviceSyncScopeDiff {
  acquire: string[];
  release: string[];
}

/** Returns the owner changes needed to move an existing list subscription set to `desired`. */
export function diffHomeDeviceSyncScope(
  current: ReadonlySet<string>,
  desired: readonly string[],
): HomeDeviceSyncScopeDiff {
  const desiredSet = new Set(desired);
  return {
    acquire: desired.filter((deviceId) => !current.has(deviceId)),
    release: [...current].filter((deviceId) => !desiredSet.has(deviceId)),
  };
}

/**
 * Runs per-device home work with a shared, bounded worker pool while preserving result order.
 * Peer failures remain values owned by the caller; one slow peer occupies only its own worker.
 */
export async function runHomeDeviceSyncBatch<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R>,
  maxConcurrent: number = HOME_DEVICE_SYNC_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];
  const normalizedMaxConcurrent = normalizeConcurrency(maxConcurrent);
  const concurrency = Math.min(normalizedMaxConcurrent, items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        // An unexpected caller error must not strand devices still queued behind this
        // worker. Drain the batch, then preserve the original rejection semantics.
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }));
  if (failed) throw firstError;
  return results;
}

function normalizeConcurrency(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : HOME_DEVICE_SYNC_CONCURRENCY;
}
