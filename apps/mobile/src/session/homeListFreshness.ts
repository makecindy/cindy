/**
 * Decides which devices' Home task lists are still trustworthy when the user comes back to Home.
 *
 * Home keeps its `sessions` subscription while another page covers it, so incremental pushes keep
 * the mirror current. A device is only re-pulled in full when something says a push may have been
 * missed since its last successful list pull:
 * - a reseed request (task created elsewhere, unknown-session patch, or the device-link recovery
 *   replay that follows a peer reset / reconnect / foreground return);
 * - the device left the sync scope, failed, or went offline;
 * - an app-wide reset such as going to the background.
 *
 * Tokens are captured when a pull starts, so a reseed that lands while the request is in flight
 * leaves the device stale even if that older response is applied successfully.
 */
export interface HomeListFreshnessToken {
  readonly epoch: number;
  readonly invalidation: number;
}

export interface HomeListFreshness {
  /** Capture before reading the list; pass it back to `markFresh` after applying the response. */
  capture(deviceId: string): HomeListFreshnessToken;
  markFresh(deviceId: string, token: HomeListFreshnessToken): void;
  /** True when nothing has invalidated the device since its last successful full pull. */
  isFresh(deviceId: string): boolean;
  invalidate(deviceId: string): void;
  invalidateAll(): void;
  clear(): void;
}

export function createHomeListFreshness(): HomeListFreshness {
  let epoch = 0;
  const invalidations = new Map<string, number>();
  const fresh = new Map<string, HomeListFreshnessToken>();
  const tokenFor = (deviceId: string): HomeListFreshnessToken => ({
    epoch,
    invalidation: invalidations.get(deviceId) ?? 0,
  });
  const isCurrent = (deviceId: string, token: HomeListFreshnessToken) => {
    const current = tokenFor(deviceId);
    return token.epoch === current.epoch && token.invalidation === current.invalidation;
  };
  return {
    capture: tokenFor,
    markFresh(deviceId, token) {
      if (isCurrent(deviceId, token)) fresh.set(deviceId, token);
      else fresh.delete(deviceId);
    },
    isFresh(deviceId) {
      const record = fresh.get(deviceId);
      return record !== undefined && isCurrent(deviceId, record);
    },
    invalidate(deviceId) {
      invalidations.set(deviceId, (invalidations.get(deviceId) ?? 0) + 1);
      fresh.delete(deviceId);
    },
    invalidateAll() {
      epoch += 1;
      fresh.clear();
    },
    clear() {
      epoch += 1;
      invalidations.clear();
      fresh.clear();
    },
  };
}

/**
 * How long Home may stay covered and still reuse its live mirror on return. Pushes keep flowing
 * meanwhile; the limit only bounds how long an undetected gap could stay on screen.
 */
export const HOME_LIST_FOCUS_REUSE_MAX_MS = 10 * 60_000;

export type HomeListFocusReturnPlan =
  | { kind: 'full' }
  | { kind: 'refill'; deviceIds: string[] };

/**
 * What a return to Home should fetch. A short stay away after a completed sync only refills the
 * devices whose list may have missed a push. A long stay, no completed sync yet, or a background /
 * reconnect while away falls back to the full device-list + per-device reload.
 */
export function planHomeListFocusReturn(input: {
  /** Set when the app went to the background or the relay reconnected while Home was covered. */
  forceFull: boolean;
  blurredAt: number | null;
  lastSyncedAt: number | null;
  now: number;
  deviceIds: readonly string[];
  freshness: HomeListFreshness;
}): HomeListFocusReturnPlan {
  const awayMs = input.blurredAt === null ? null : input.now - input.blurredAt;
  if (
    input.forceFull
    || awayMs === null
    || input.lastSyncedAt === null
    || awayMs < 0
    || awayMs >= HOME_LIST_FOCUS_REUSE_MAX_MS
  ) return { kind: 'full' };
  return {
    kind: 'refill',
    deviceIds: input.deviceIds.filter((deviceId) => !input.freshness.isFresh(deviceId)),
  };
}
