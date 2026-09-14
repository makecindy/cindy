export interface MobileHistoryAnchor {
  key: string;
  /** Stable child identity used when a prepend changes an aggregate row's outer key. */
  identityKey?: string;
  /** Item top relative to the viewport top before older rows are prepended. */
  viewportOffset: number;
  /** Nearby rows captured at the same time, used if a live render group replaces the primary key. */
  fallbacks?: readonly MobileHistoryAnchorCandidate[];
}

export interface MobileHistoryAnchorCandidate {
  key: string;
  /** Stable child identity used when a prepend changes an aggregate row's outer key. */
  identityKey?: string;
  viewportOffset: number;
}

export interface MobileHistoryAnchorCaptureState<ItemT> {
  data: readonly ItemT[];
  positionAtIndex(index: number): number | undefined;
  scroll: number;
  start: number;
  /** Header, content padding, and align-at-end spacer before the data coordinate space. */
  topOffsetAdjustment?: number;
}

export interface MobileHistoryAnchorResolveState {
  positionByKey(key: string): number | undefined;
  /** Resolve a captured child identity to its current top-level row key. */
  keyByIdentity?(identityKey: string): string | undefined;
  /** LegendList can briefly omit a key from its position cache while committing a prepend. */
  data?: readonly { key: string }[];
  positionAtIndex?(index: number): number | undefined;
  /** Header, content padding, and align-at-end spacer before the data coordinate space. */
  topOffsetAdjustment?: number;
}

export interface MobileHistoryAnchorPendingCorrection {
  /** Native scroll-event sequence observed immediately before issuing the correction. */
  requestedAfterNativeScrollSequence: number;
  targetOffset: number;
}

export type MobileHistoryAnchorCorrectionStatus = 'acknowledged' | 'missed' | 'waiting';

export interface MobileHistoryTopOffsetState {
  contentLength: number;
  data: readonly unknown[];
  positionAtIndex(index: number): number | undefined;
  scrollLength: number;
  sizeAtIndex(index: number): number | undefined;
}

const MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES = 8;
const MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES = 24;
const MOBILE_HISTORY_SHORT_LIST_TOLERANCE = 2;

/**
 * Android needs the app-owned prepend transaction because its native MVCP can commit the new cell
 * coordinates before the ScrollView offset. iOS keeps the native path, which applies the data and
 * offset change atomically and must not be followed by imperative app scrolls.
 */
export function mobileHistoryPrependUsesAppOwnedAnchor(platformOS: string): boolean {
  return platformOS === 'android';
}

/**
 * Distinguish LegendList's optimistic internal scroll bookkeeping from a native ScrollView ack.
 * `LegendList.getState().scroll` moves to the requested offset before the native command lands, so
 * only a later `onScroll` sequence can prove that the physical viewport caught up.
 */
export function mobileHistoryAnchorCorrectionStatus(
  correction: MobileHistoryAnchorPendingCorrection,
  state: {
    nativeOffset: number;
    nativeScrollSequence: number;
  },
  tolerance: number,
): MobileHistoryAnchorCorrectionStatus {
  if (state.nativeScrollSequence <= correction.requestedAfterNativeScrollSequence) {
    return 'waiting';
  }
  return Number.isFinite(state.nativeOffset)
    && Number.isFinite(correction.targetOffset)
    && Math.abs(state.nativeOffset - correction.targetOffset) <= Math.max(0, tolerance)
    ? 'acknowledged'
    : 'missed';
}

/**
 * Translate LegendList's data-relative item positions into its raw ScrollView coordinates.
 *
 * LegendList does not expose its align-at-end spacer through `getState()`. For an under-one-screen
 * list every row is measured, so the leading space can be recovered from the content length and
 * the measured end of the final row. Overflowing lists have no align spacer and use the explicit
 * header + content-padding baseline instead.
 */
export function mobileHistoryTopOffsetAdjustment(
  state: MobileHistoryTopOffsetState,
  input: {
    baseTopOffset: number;
    bottomPadding: number;
    footerSize: number;
  },
): number {
  const baseTopOffset = Number.isFinite(input.baseTopOffset)
    ? Math.max(0, input.baseTopOffset)
    : 0;
  if (
    state.data.length === 0
    || !Number.isFinite(state.contentLength)
    || !Number.isFinite(state.scrollLength)
    || state.contentLength > state.scrollLength + MOBILE_HISTORY_SHORT_LIST_TOLERANCE
  ) {
    return baseTopOffset;
  }

  const lastIndex = state.data.length - 1;
  const lastPosition = state.positionAtIndex(lastIndex);
  const lastSize = state.sizeAtIndex(lastIndex);
  if (!Number.isFinite(lastPosition) || !Number.isFinite(lastSize)) return baseTopOffset;

  const footerSize = Number.isFinite(input.footerSize) ? Math.max(0, input.footerSize) : 0;
  const bottomPadding = Number.isFinite(input.bottomPadding)
    ? Math.max(0, input.bottomPadding)
    : 0;
  const measuredLeadingSpace = state.contentLength
    - footerSize
    - bottomPadding
    - (lastPosition as number)
    - (lastSize as number);
  return Number.isFinite(measuredLeadingSpace)
    ? Math.max(baseTopOffset, measuredLeadingSpace)
    : baseTopOffset;
}

function findClosestMobileHistoryAnchorIndex<ItemT>(
  state: MobileHistoryAnchorCaptureState<ItemT>,
): number | null {
  if (Number.isInteger(state.start) && state.start >= 0 && state.start < state.data.length) {
    return state.start;
  }

  // Item positions are monotonic. When LegendList has not published `start` yet, locate the
  // viewport with O(log n) position reads instead of scanning the whole retained history.
  let lower = 0;
  let upper = state.data.length - 1;
  let closestIndex: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  while (lower <= upper) {
    const index = Math.floor((lower + upper) / 2);
    const position = state.positionAtIndex(index);
    if (!Number.isFinite(position)) break;
    const dataScroll = state.scroll - (state.topOffsetAdjustment ?? 0);
    const distance = Math.abs((position as number) - dataScroll);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
    if ((position as number) < dataScroll) lower = index + 1;
    else upper = index - 1;
  }
  return closestIndex;
}

/**
 * Capture the first visible row in LegendList's own coordinate space.
 *
 * Native `contentOffset` is deliberately not used here: during a prepend,
 * Android may report the old physical offset while LegendList has already
 * moved its item positions to the new data coordinates.
 */
export function captureMobileHistoryAnchor<ItemT>(
  state: MobileHistoryAnchorCaptureState<ItemT>,
  keyOf: (item: ItemT) => string,
  identityOf?: (item: ItemT) => string | undefined,
): MobileHistoryAnchor | null {
  if (!Number.isFinite(state.scroll)) return null;
  const topOffsetAdjustment = Number.isFinite(state.topOffsetAdjustment)
    ? state.topOffsetAdjustment as number
    : 0;

  const closestIndex = findClosestMobileHistoryAnchorIndex(state);
  if (closestIndex === null) return null;
  const candidates: MobileHistoryAnchorCandidate[] = [];
  const seenKeys = new Set<string>();
  let positionProbes = 0;
  for (
    let distance = 0;
    candidates.length < MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES
      && positionProbes < MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES;
    distance++
  ) {
    const indices = distance === 0
      ? [closestIndex]
      : [closestIndex + distance, closestIndex - distance];
    let hasIndexInRange = false;
    for (const index of indices) {
      if (index < 0 || index >= state.data.length) continue;
      hasIndexInRange = true;
      if (positionProbes >= MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES) break;
      positionProbes += 1;
      const key = keyOf(state.data[index]);
      const position = state.positionAtIndex(index);
      if (!key || seenKeys.has(key) || !Number.isFinite(position)) continue;
      seenKeys.add(key);
      const identityKey = identityOf?.(state.data[index]);
      candidates.push({
        key,
        ...(identityKey && identityKey !== key ? { identityKey } : {}),
        viewportOffset: (position as number) + topOffsetAdjustment - state.scroll,
      });
      if (
        candidates.length >= MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES
        || positionProbes >= MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES
      ) break;
    }
    if (!hasIndexInRange) break;
  }
  if (candidates.length === 0) return null;

  const startKey = keyOf(state.data[closestIndex]);
  candidates.sort((left, right) => {
    if (left.key === startKey) return -1;
    if (right.key === startKey) return 1;
    return Math.abs(left.viewportOffset) - Math.abs(right.viewportOffset);
  });

  const [primary, ...fallbacks] = candidates.slice(0, MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES);
  return {
    ...primary,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

/** Resolve the non-animated scroll offset that keeps the captured row in place. */
export function resolveMobileHistoryAnchorOffset(
  anchor: MobileHistoryAnchor,
  state: MobileHistoryAnchorResolveState,
): number | null {
  const candidates: readonly MobileHistoryAnchorCandidate[] = [anchor, ...(anchor.fallbacks ?? [])];
  for (const candidate of candidates) {
    let currentKey = candidate.key;
    let position = state.positionByKey(currentKey);
    if (
      !Number.isFinite(position)
      && state.data
      && state.positionAtIndex
    ) {
      const index = state.data.findIndex((item) => item.key === currentKey);
      if (index >= 0) position = state.positionAtIndex(index);
    }
    // Most prepends preserve the outer row key. Only scan aggregate children after both of
    // LegendList's direct-key paths miss, keeping the per-frame settle verifier O(1) normally.
    if (!Number.isFinite(position) && candidate.identityKey && state.keyByIdentity) {
      const replacementKey = state.keyByIdentity(candidate.identityKey);
      if (replacementKey) {
        currentKey = replacementKey;
        position = state.positionByKey(currentKey);
        if (
          !Number.isFinite(position)
          && state.data
          && state.positionAtIndex
        ) {
          const index = state.data.findIndex((item) => item.key === currentKey);
          if (index >= 0) position = state.positionAtIndex(index);
        }
      }
    }
    if (Number.isFinite(position)) {
      const topOffsetAdjustment = Number.isFinite(state.topOffsetAdjustment)
        ? state.topOffsetAdjustment as number
        : 0;
      return Math.max(
        0,
        (position as number) + topOffsetAdjustment - candidate.viewportOffset,
      );
    }
  }
  return null;
}

export function isMobileHistoryAnchorSettled(
  currentOffset: number,
  targetOffset: number,
  previousTargetOffset: number | null,
  tolerance: number,
): boolean {
  return Number.isFinite(currentOffset)
    && Number.isFinite(targetOffset)
    && previousTargetOffset !== null
    && Math.abs(currentOffset - targetOffset) <= tolerance
    && Math.abs(previousTargetOffset - targetOffset) <= tolerance;
}
