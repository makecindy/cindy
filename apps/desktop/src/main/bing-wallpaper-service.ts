import type { BingWallpaperImage, BingWallpaperStatus } from '../shared/bingWallpaper.js';
import type { BingWallpaperCache } from './bing-wallpaper-settings.js';
import { BingWallpaperRequestError, type BingImageMetadata } from './bing-wallpaper-source.js';

const HOUR = 60 * 60 * 1000;
const MIN_CHECK_INTERVAL = 60_000;
const RETRY_DELAYS = [MIN_CHECK_INTERVAL, 15 * 60_000, HOUR, 6 * HOUR];

/** One profile-wide update loop. Network/decoding never hold the media publication lock. */
export interface BingWallpaperServiceDeps {
  activeMarket(): string | null;
  readCache(): BingWallpaperCache;
  validate(image: BingWallpaperImage): Promise<boolean>;
  metadata(market: string, signal: AbortSignal): Promise<BingImageMetadata>;
  image(metadata: BingImageMetadata, signal: AbortSignal): Promise<Buffer>;
  publish(
    metadata: BingImageMetadata,
    bytes: Buffer | null,
    checkedAt: number,
    nextCheckAt: number,
    isCurrent: () => boolean,
    expectedCache: BingWallpaperCache,
  ): Promise<void>;
  status(status: BingWallpaperStatus): void;
  now?: () => number;
  jitter?: () => number;
}

export function createBingWallpaperService(deps: BingWallpaperServiceDeps) {
  const now = deps.now ?? Date.now;
  let market: string | null = null;
  let epoch = 0;
  let disposed = false;
  let pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAttemptAt = 0;
  let lastAttemptAt = -Infinity;
  let lastCheckAt = -Infinity;
  let failures = 0;
  let lastStatus: BingWallpaperStatus = 'idle';
  let lastFailureStatus: Extract<BingWallpaperStatus, 'stale' | 'failed'> | null = null;

  function status(value: BingWallpaperStatus) {
    if (lastStatus === value) return;
    lastStatus = value;
    deps.status(value);
  }
  function schedule() {
    clearTimeout(timer);
    // Preferences can also change through migration, outside the IPC callbacks.
    // A cancelled check must not keep revalidating an inactive cache every second.
    if (!market || disposed || pending || deps.activeMarket() !== market) return;
    // Bound stale future timestamps after wall-clock changes; no short polling loop.
    const delay = Math.min(
      6 * HOUR,
      Math.max(1000, Math.max(nextAttemptAt, lastAttemptAt + MIN_CHECK_INTERVAL) - now()),
    );
    timer = setTimeout(() => {
      void check();
    }, delay);
    timer.unref?.();
  }
  function nextNormalCheck(at: number) {
    const midnight = new Date(at);
    midnight.setHours(24, 5, 0, 0);
    const jitter = Math.min(1, Math.max(0, (deps.jitter ?? Math.random)())) * 60_000;
    return Math.floor(Math.min(at + 6 * HOUR, midnight.getTime()) + jitter);
  }
  async function check(force = false): Promise<void> {
    if (disposed || !market || pending) return pending ?? undefined;
    const at = now();
    if (at < lastCheckAt) {
      lastAttemptAt = -Infinity;
      nextAttemptAt = 0;
    }
    // Cache hits and deadline-gated checks also establish a wall-clock baseline.
    lastCheckAt = at;
    if (
      ((!force || failures > 0) && at < nextAttemptAt) ||
      at - lastAttemptAt < MIN_CHECK_INTERVAL
    ) {
      schedule();
      return;
    }
    const runMarket = market;
    const generation = epoch;
    const abort = new AbortController();
    controller = abort;
    const current = () =>
      !disposed &&
      generation === epoch &&
      !abort.signal.aborted &&
      deps.activeMarket() === runMarket;
    // Defer execution until pending is assigned: synchronous status broadcasts can reconcile.
    pending = Promise.resolve()
      .then(async () => {
        let valid = false;
        try {
          const cache = deps.readCache();
          valid = !!cache.current && (await deps.validate(cache.current));
          if (!current()) return;
          if (
            !force &&
            valid &&
            cache.current?.market === runMarket &&
            cache.nextCheckAt > at &&
            cache.checkedAt <= at
          ) {
            nextAttemptAt = Math.min(cache.nextCheckAt, at + 6 * HOUR);
            failures = 0;
            lastFailureStatus = null;
            status('ready');
            return;
          }
          lastAttemptAt = at;
          status('loading');
          const metadata = await deps.metadata(runMarket, abort.signal);
          if (!current()) return;
          const bytes =
            valid && cache.current?.imageKey === metadata.imageKey
              ? null
              : await deps.image(metadata, abort.signal);
          if (!current()) return;
          const checkedAt = now();
          const nextCheckAt = nextNormalCheck(checkedAt);
          await deps.publish(metadata, bytes, checkedAt, nextCheckAt, current, cache);
          if (!current()) return;
          failures = 0;
          lastFailureStatus = null;
          nextAttemptAt = nextCheckAt;
          status('ready');
        } catch (error) {
          if (!current()) return;
          const retry = RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)];
          const serverDelay =
            error instanceof BingWallpaperRequestError && Number.isFinite(error.retryAfterMs)
              ? error.retryAfterMs
              : 0;
          nextAttemptAt = now() + Math.max(retry, serverDelay);
          lastFailureStatus = valid ? 'stale' : 'failed';
          status(lastFailureStatus);
        }
      })
      .finally(() => {
        pending = null;
        if (controller === abort) controller = null;
        if (!disposed && market && generation !== epoch) void check();
        else schedule();
      });
    return pending;
  }
  return {
    reconcile(): void {
      if (disposed) return;
      const next = deps.activeMarket();
      if (next !== market) {
        market = next;
        epoch++;
        controller?.abort();
        clearTimeout(timer);
        if (!market) status('idle');
        else if (failures === 0) nextAttemptAt = Math.min(nextAttemptAt, now());
      }
      if (market) {
        if (failures > 0 && now() < nextAttemptAt && lastFailureStatus)
          status(lastFailureStatus);
        void check();
      }
    },
    refresh: () => check(true),
    dispose(): void {
      disposed = true;
      epoch++;
      controller?.abort();
      clearTimeout(timer);
    },
  };
}
