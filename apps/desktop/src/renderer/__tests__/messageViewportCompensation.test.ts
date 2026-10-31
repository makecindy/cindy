import { describe, expect, it } from 'vitest';
import {
  canCompensateMessageHeight,
  isRestoredScrollTakeover,
  measureRestoredScrollGeometry,
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

// #7425: a cross-origin iframe chains scroll without a parent wheel event.
// Existing compensation tests do not distinguish this input from layout settle.
// Unit tier models measured DOM geometry; the Electron probe exercises the real
// MessageStream and native iframe wheel chaining, including the old failure.
describe('restored reading position handoff', () => {
  function setup() {
    const state = { top: 200, height: 4000, width: 800, viewport: 600,
      anchorTop: 240, anchorHeight: 300, connected: true };
    const anchor = { getBoundingClientRect: () => ({
      top: state.anchorTop - state.top + 40, height: state.anchorHeight,
    }) } as HTMLElement;
    const container = {
      get scrollTop() { return state.top; },
      get scrollHeight() { return state.height; },
      get clientWidth() { return state.width; },
      get clientHeight() { return state.viewport; },
      getBoundingClientRect: () => ({ top: 40 }),
      contains: (node: HTMLElement) => node === anchor && state.connected,
    } as HTMLElement;
    return { state, container, previous: measureRestoredScrollGeometry(container, anchor) };
  }

  it.each([-100, 400])('hands off a %i px chained scroll with stable layout', (delta) => {
    const { state, container, previous } = setup();
    state.top += delta;
    expect(isRestoredScrollTakeover(container, previous, true, false)).toBe(true);
    expect(isRestoredScrollTakeover(container, previous, false, false)).toBe(false);
    expect(isRestoredScrollTakeover(container, previous, true, true)).toBe(false);
  });

  it.each([
    { height: 4200 },
    { width: 700 },
    { viewport: 500 },
    { anchorTop: 340 }, // Equal total height can still hide displacement above the anchor.
    { anchorHeight: 350 },
    { connected: false },
  ])('keeps restoring after a layout/anchor change: %j', (change) => {
    const { state, container, previous } = setup();
    Object.assign(state, change, { top: 300 });
    expect(isRestoredScrollTakeover(container, previous, true, false)).toBe(false);
  });

  it('ignores an aligned scroll notification and an absent restoration measurement', () => {
    const { container, previous } = setup();
    expect(isRestoredScrollTakeover(container, previous, true, false)).toBe(false);
    expect(isRestoredScrollTakeover(container, null, true, false)).toBe(false);
  });
});
