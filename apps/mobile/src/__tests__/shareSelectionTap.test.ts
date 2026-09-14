import { describe, expect, it } from 'vitest';
import {
  SHARE_SELECTION_TAP_MAX_DISTANCE,
  SHARE_SELECTION_TAP_MAX_DURATION_MS,
  shareSelectionTapMoved,
  shouldCommitShareSelectionTap,
} from '@/session/shareSelectionTap';

describe('share selection row tap', () => {
  it('keeps a stationary short tap eligible for whole-row selection', () => {
    expect(shareSelectionTapMoved(
      { pageX: 24, pageY: 80 },
      { pageX: 24 + SHARE_SELECTION_TAP_MAX_DISTANCE, pageY: 80 },
    )).toBe(false);
    expect(shouldCommitShareSelectionTap({
      durationMs: SHARE_SELECTION_TAP_MAX_DURATION_MS,
      moved: false,
    })).toBe(true);
  });

  it('does not select after a drag or long press', () => {
    expect(shareSelectionTapMoved(
      { pageX: 24, pageY: 80 },
      { pageX: 24 + SHARE_SELECTION_TAP_MAX_DISTANCE + 1, pageY: 80 },
    )).toBe(true);
    expect(shouldCommitShareSelectionTap({ durationMs: 120, moved: true })).toBe(false);
    expect(shouldCommitShareSelectionTap({
      durationMs: SHARE_SELECTION_TAP_MAX_DURATION_MS + 1,
      moved: false,
    })).toBe(false);
  });
});
