import { describe, expect, it } from 'vitest';
import {
  canCompensateMessageHeight,
  rememberedItemIntrinsicSize,
  viewportAnchorCorrection,
} from '../components/chat/messageViewportCompensation';

describe('measured message height compensation', () => {
  it('reuses the measured offscreen size without fixing the actual content height', () => {
    expect(rememberedItemIntrinsicSize(454, 720, 720)).toBe('auto 454px');
    expect(rememberedItemIntrinsicSize(454, 720, 580)).toBeUndefined();
    expect(rememberedItemIntrinsicSize(undefined, 720, 720)).toBeUndefined();
    expect(rememberedItemIntrinsicSize(454, 720, NaN)).toBeUndefined();
    for (const height of [0, -1, NaN, Infinity]) {
      expect(rememberedItemIntrinsicSize(height, 720, 720)).toBeUndefined();
    }
  });
  it.each([177, -141, 320])(
    'preserves the visible message after a %i px card/work-group resize',
    (growth) => {
      const containerTop = 46,
        offset = 28;
      let scrollTop = 600;
      const anchorDocumentTop = scrollTop + containerTop - offset + growth;
      const correct = () => {
        scrollTop += viewportAnchorCorrection(containerTop, anchorDocumentTop - scrollTop, offset);
      };
      correct();
      expect(anchorDocumentTop - scrollTop).toBe(containerTop - offset);
      const after = scrollTop;
      correct();
      expect(scrollTop).toBe(after);
    },
  );

  it('does not add the delta again when the browser already preserved the anchor', () => {
    expect(viewportAnchorCorrection(46, 18, 28)).toBe(0);
    expect(viewportAnchorCorrection(46, 18.4, 28)).toBe(0);
    expect(viewportAnchorCorrection(46, 118, 28)).toBe(100);
  });

  const idle = {
    restoring: false,
    nearBottom: false,
    programmatic: false,
    loadingMore: false,
    pendingPrepend: false,
    pendingUserScroll: false,
    dragging: false,
    expanding: false,
  };
  it('compensates while reading without taking over another scroll operation', () => {
    expect(canCompensateMessageHeight(idle)).toBe(true);
    for (const key of Object.keys(idle)) {
      expect(canCompensateMessageHeight({ ...idle, [key]: true }), key).toBe(false);
    }
  });
});
