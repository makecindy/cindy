/** Small drag slop: enough for finger jitter, below an intentional scroll gesture. */
export const SHARE_SELECTION_TAP_MAX_DISTANCE = 8;
/** Finish before React Native's default 500 ms long-press boundary. */
export const SHARE_SELECTION_TAP_MAX_DURATION_MS = 450;

export interface ShareSelectionTapPoint {
  pageX: number;
  pageY: number;
}

export function shareSelectionTapMoved(
  start: ShareSelectionTapPoint,
  current: ShareSelectionTapPoint,
): boolean {
  return Math.hypot(current.pageX - start.pageX, current.pageY - start.pageY)
    > SHARE_SELECTION_TAP_MAX_DISTANCE;
}

export function shouldCommitShareSelectionTap(input: {
  durationMs: number;
  moved: boolean;
}): boolean {
  return !input.moved
    && input.durationMs >= 0
    && input.durationMs <= SHARE_SELECTION_TAP_MAX_DURATION_MS;
}
