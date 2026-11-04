import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as autoFollow from '../components/chat/autoFollowIntent';
import { TOP_HISTORY_TRIGGER_PX } from '../components/chat/viewportFillDetect';
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

// Review (#7548): the predicate tests above pass even if MessageStream ignores them. Run the
// production handleScroll callback (extracted and executed, as in focusScrollWindow.test.ts)
// with the real takeover predicate and auto-follow rules: after a settled restoration, a
// layout-stable chained scroll must leave restoration, keep the new position instead of
// snapping back, save it, and resume following once it reaches the bottom. Removing the
// takeover branch from handleScroll makes the first case fail (applyRestore runs instead).
describe('restored reading position handoff through MessageStream.handleScroll', () => {
  const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
    resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
  ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
  const declaration = component.body!.statements.flatMap(node => ts.isVariableStatement(node)
    ? [...node.declarationList.declarations] : []).find(node => node.name.getText(source) === 'handleScroll')!;
  const callback = (declaration.initializer as ts.CallExpression).arguments[0];
  const code = ts.transpileModule(`return (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => undefined });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fixture() {
    const state = { top: 200, height: 4000, width: 800, viewport: 600, anchorTop: 240, anchorHeight: 300 };
    const anchor = { getBoundingClientRect: () => ({ top: state.anchorTop - state.top + 40, height: state.anchorHeight }) } as HTMLElement;
    const el = {
      get scrollTop() { return state.top; },
      get scrollHeight() { return state.height; },
      get clientWidth() { return state.width; },
      get clientHeight() { return state.viewport; },
      getBoundingClientRect: () => ({ top: 40 }),
      contains: (node: HTMLElement) => node === anchor,
    } as unknown as HTMLElement;
    const bindings = {
      // Production decisions under test.
      isRestoredScrollTakeover,
      resolveNearBottomOnScroll: autoFollow.resolveNearBottomOnScroll,
      resolveEffectiveNearBottom: autoFollow.resolveEffectiveNearBottom,
      shouldUnpinOnScrollbarDrag: autoFollow.shouldUnpinOnScrollbarDrag,
      shouldUnpinOnUpIntent: autoFollow.shouldUnpinOnUpIntent,
      shouldBumpSendFollowCancelOnScroll: autoFollow.shouldBumpSendFollowCancelOnScroll,
      TOP_HISTORY_TRIGGER_PX, SCROLL_DIRECTION_DEAD_ZONE_PX: 1,
      RENDER_WINDOW_GROWTH_ITEMS: 80, NO_UNREAD_KEYS: new Set<string>(),
      // A restoration that has settled at scrollTop 200 with a measured anchor.
      scrollRef: { current: el },
      restoringRef: { current: true },
      restoreLoadRef: { current: 'settled' },
      restoredScrollGeometryRef: { current: measureRestoredScrollGeometry(el, anchor) },
      applyRestoreRef: { current: vi.fn() },
      programmaticScrollRef: { current: false },
      programmaticScrollGenerationRef: { current: 0 },
      scrollbarDragStartTopRef: { current: null },
      prevScrollTopRef: { current: 200 },
      prevScrollHeightRef: { current: 0 },
      prevScrollTopAtLoadRef: { current: 0 },
      saveRafRef: { current: null },
      isNearBottomRef: { current: false },
      focusJumpRef: { current: null },
      chipJumpGenerationRef: { current: null },
      chipJumpInProgressRef: { current: false },
      saveScrollSnapshot: vi.fn(), clearChipJumpSuppression: vi.fn(),
      // CI 41649027355: handleScroll now delegates jump visibility to this hook.
      setIsNearBottom: vi.fn(), setUnreadKeys: vi.fn(), updateJumpDown: vi.fn(),
      setFirstVisibleItemKey: vi.fn(), setAnchoredForwardItems: vi.fn(),
      unpinAutoFollowForUserUpIntent: vi.fn(), bumpSendFollowCancelGeneration: vi.fn(),
      finishProgrammaticScroll: vi.fn(), refreshViewportAnchor: vi.fn(),
      triggerUserIntentFill: vi.fn(), expandWindow: vi.fn(), onLoadMore: vi.fn(),
      anchoredForwardItems: 0, firstVisibleItemKey: null, windowAtTop: false,
      windowCoversEnd: true, hasMoreMessages: false, isLoadingMore: false, sessionId: 's',
    };
    const scroll = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as () => void;
    return { state, bindings, scroll };
  }

  it('hands a layout-stable chained scroll to the normal path and follows again at the bottom', () => {
    const { state, bindings, scroll } = fixture();
    state.top = 600; // +400 from an iframe's chained wheel; no layout change
    scroll();
    expect(bindings.applyRestoreRef.current).not.toHaveBeenCalled();
    expect(bindings.restoringRef.current).toBe(false);
    expect(bindings.clearChipJumpSuppression).toHaveBeenCalledOnce();
    expect(bindings.saveScrollSnapshot).toHaveBeenCalled();
    expect(bindings.isNearBottomRef.current).toBe(false);
    state.top = 3400; // keep scrolling down to the end of the conversation
    scroll();
    expect(bindings.isNearBottomRef.current).toBe(true);
    expect(bindings.setIsNearBottom).toHaveBeenLastCalledWith(true);
    // #8548: handleScroll feeds every non-restore scroll into the jump-down
    // visibility hook; both scrolls above take that path (delta 400 / 2800).
    expect(bindings.updateJumpDown).toHaveBeenCalledTimes(2);
    expect(bindings.updateJumpDown).toHaveBeenLastCalledWith(2800, true);
  });

  it('keeps restoring when the layout moved under the anchor', () => {
    const { state, bindings, scroll } = fixture();
    Object.assign(state, { top: 300, height: 4200 });
    scroll();
    expect(bindings.applyRestoreRef.current).toHaveBeenCalledOnce();
    expect(bindings.restoringRef.current).toBe(true);
    expect(bindings.saveScrollSnapshot).not.toHaveBeenCalled();
  });
});
