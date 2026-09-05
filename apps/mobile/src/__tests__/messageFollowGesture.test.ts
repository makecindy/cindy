import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scrollModel from '@/session/messageScroll';

// Execute the production callbacks without mounting Markdown/media/native views. Unlike source
// assertions, this harness interleaves touch, native scroll, content-size, timers and frame delivery.
const source = ts.createSourceFile('MessageRenderer.tsx', readFileSync(
  resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const renderer = source.statements.find((node): node is ts.FunctionDeclaration => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageRenderer'
));
const callbackNames = [
  'markProgrammaticScroll', 'clearProgrammaticScroll', 'markMobileMvcpSettle',
  'isUserControllingScroll', 'scrollToEndProgrammatically', 'runStickToLatestVerify',
  'scrollToOffsetProgrammatically', 'scrollToIndexProgrammatically',
  'scrollToBottom', 'handleScroll', 'handleHistoryTouchStart', 'maybeTriggerHistoryTouch',
  'handleHistoryTouchMove', 'handleHistoryTouchEnd', 'handleHistoryTouchCancel',
  'handleScrollBeginDrag', 'handleScrollEndDrag', 'handleMomentumScrollBegin',
  'handleMomentumScrollEnd', 'handleContentSize',
] as const;
type CallbackName = typeof callbackNames[number];
const declarations = renderer!.body!.statements.filter((node) => (
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
    ts.isIdentifier(declaration.name) && callbackNames.includes(declaration.name.text as CallbackName)
  ))
));
const constants = source.statements.filter((node) => (
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
    ts.isIdentifier(declaration.name) && /^MOBILE_PROGRAMMATIC_.*_MS$/.test(declaration.name.text)
  ))
));
const compiled = ts.transpileModule([
  ...constants.map((node) => node.getText(source)),
  ...declarations.map((node) => node.getText(source)),
  `return { ${callbackNames.join(', ')} };`,
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const ref = <T>(current: T) => ({ current });
  const state = {
    nearBottomRef: ref(true), readingOlderRef: ref(false),
    isDraggingRef: ref(false), isMomentumScrollingRef: ref(false),
    historyTouchStartYRef: ref<number | null>(null), historyTouchTriggeredRef: ref(false),
    dragStartOffsetYRef: ref<number | null>(null), userScrollForOlderRef: ref(false),
    lastAutoLoadEarlierKeyRef: ref<string | null>(null),
    programmaticScrollGenerationRef: ref(0), programmaticScrollTimerRef: ref<unknown>(null),
    programmaticScrollInFlightRef: ref(false), programmaticAnimatedScrollInFlightRef: ref(false),
    programmaticScrollSettleAtRef: ref(0), mvcpSettleAtRef: ref(0),
    followVerifyGenerationRef: ref(0), followVerifyFrameRef: ref<unknown>(null),
    followVerifyTimerRef: ref<unknown>(null), followEndPinRecoveryTimerRef: ref<unknown>(null),
    followEndPinStateRef: ref(scrollModel.createMobileFollowEndPinState()),
    historyPrependTransactionRef: ref(null), nativeScrollEventSequenceRef: ref(0),
    shareSelectionActiveRef: ref(false),
    scrollMetricsRef: ref({ contentHeight: 2000, offsetY: 1200, viewportHeight: 800 }),
  };
  const scrollToEnd = vi.fn(() => {
    const metrics = state.scrollMetricsRef.current;
    metrics.offsetY = metrics.contentHeight - metrics.viewportHeight;
  });
  const environment = {
    ...scrollModel, ...state,
    listRef: ref({ scrollToEnd, scrollToOffset: vi.fn(), scrollToIndex: vi.fn() }),
    bottomOverlayHeight: undefined,
    useCallback: (callback: unknown) => callback,
    attemptAutoLoadEarlier: vi.fn(), handoffHistoryPrependToUser: vi.fn(),
    scheduleHistoryPrependUserHandoffSettle: vi.fn(), scheduleQueuedLoadEarlierFlush: vi.fn(),
    refreshPreviousUserTarget: vi.fn(), scheduleStickyShareCheck: vi.fn(),
    scheduleHistoryAnchorRestore: vi.fn(), restoreHistoryAnchorOnce: vi.fn(),
    cancelHistoryPrependTransaction: vi.fn(),
    setIsAwayFromBottom: vi.fn(), setHasNewMessages: vi.fn(), setPreviousUserTarget: vi.fn(),
  };
  const callbacks = new Function(...Object.keys(environment), compiled)(
    ...Object.values(environment),
  ) as Record<CallbackName, (...args: unknown[]) => void>;
  const scrollEvent = (offsetY: number) => ({ nativeEvent: {
    contentSize: { height: state.scrollMetricsRef.current.contentHeight },
    contentOffset: { y: offsetY }, layoutMeasurement: { height: 800 },
  } });
  return {
    ...callbacks, state, scrollToEnd, scrollEvent,
    handleScrollEndDrag: (event = scrollEvent(state.scrollMetricsRef.current.offsetY)) => (
      callbacks.handleScrollEndDrag(event)
    ),
  };
}
const touch = (pageY = 400) => ({ nativeEvent: { pageY } });
const settle = () => vi.advanceTimersByTime(4000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('streaming follow yields to the reader', () => {
  it.each([1196, 1180].flatMap((offset) => ['missing', 'before-verify', 'after-verify'].map((end) => ({ offset, end }))))(
    'releases a cancelled drag at $offset with end event $end', ({ offset, end }) => {
      const h = harness();
      h.handleHistoryTouchStart(touch());
      h.handleScrollBeginDrag(h.scrollEvent(1200));
      h.handleScroll(h.scrollEvent(end === 'missing' ? offset : 1196));
      h.handleContentSize(400, 2500);
      h.handleHistoryTouchCancel();
      h.handleHistoryTouchCancel();
      if (end === 'after-verify') {
        settle();
        expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
        h.scrollToEnd.mockClear();
      }
      if (end !== 'missing') h.handleScrollEndDrag(h.scrollEvent(offset));
      settle();
      expect(h.state.nearBottomRef.current).toBe(offset === 1196);
      expect(h.scrollToEnd).toHaveBeenCalledTimes(offset === 1196 ? 1 : 0);
      expect(h.state.isDraggingRef.current).toBe(false);
      if (end !== 'missing') expect(h.state.dragStartOffsetYRef.current).toBeNull();
    },
  );

  it('consumes a late final sample even after a no-op cancellation verification', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleHistoryTouchCancel();
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScrollEndDrag(h.scrollEvent(1180));
    h.handleContentSize(400, 2500);
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores layout corrections after cancel but consumes the final drag sample', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleContentSize(400, 2500);
    h.handleHistoryTouchCancel();
    h.handleScroll(h.scrollEvent(900));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleScrollEndDrag(h.scrollEvent(1180));
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it.each(['end', 'index'])('discards the cancelled drag sample when explicit %s takes over', (target) => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleHistoryTouchCancel();
    if (target === 'end') h.scrollToBottom();
    else h.scrollToIndexProgrammatically(10, 0.45);
    h.handleScrollEndDrag(h.scrollEvent(1180));
    expect(h.state.nearBottomRef.current).toBe(true);
    if (target === 'end') expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('keeps the cancelled drag sample through automatic offset compensation', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleHistoryTouchCancel();
    h.scrollToOffsetProgrammatically(900, false);
    h.handleScroll(h.scrollEvent(900));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleScrollEndDrag(h.scrollEvent(1180));
    expect(h.state.nearBottomRef.current).toBe(false);
  });

  it('can return to the bottom in the final drag sample after cancellation', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1180));
    h.handleHistoryTouchCancel();
    h.handleScrollEndDrag(h.scrollEvent(1200));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleContentSize(400, 2500);
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('allows native scrolling to take ownership after Android cancels the JS touch', () => {
    const h = harness();
    h.handleHistoryTouchStart(touch());
    h.handleHistoryTouchCancel();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleContentSize(400, 2500);
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScroll(h.scrollEvent(1180));
    h.handleScrollEndDrag();
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('waits for independently reported momentum after cancelling a touch', () => {
    const h = harness();
    h.handleHistoryTouchStart(touch());
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleMomentumScrollBegin();
    h.handleHistoryTouchCancel();
    h.handleContentSize(400, 2500);
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleMomentumScrollEnd();
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps an active drag when another finger touches the list', () => {
    const h = harness();
    h.handleHistoryTouchStart(touch());
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleHistoryTouchStart(touch());
    h.handleContentSize(400, 2500);
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScroll(h.scrollEvent(1180));
    h.handleHistoryTouchEnd(touch());
    h.handleScrollEndDrag();
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves an explicit animated jump when touchEnd precedes onPress: %s', (releaseFirst) => {
    const h = harness();
    h.state.nearBottomRef.current = false;
    h.state.scrollMetricsRef.current.offsetY = 300;
    // Native animation has not landed yet; command dispatch does not acknowledge its offset.
    h.scrollToEnd.mockImplementation(() => {});
    h.handleHistoryTouchStart(touch());
    if (releaseFirst) h.handleHistoryTouchEnd(touch());
    h.scrollToBottom();
    expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
    if (!releaseFirst) h.handleHistoryTouchEnd(touch());
    h.handleContentSize(400, 2200);
    const remaining = h.state.programmaticScrollSettleAtRef.current - Date.now();
    vi.advanceTimersByTime(remaining - 1);
    // Releasing the button and receiving new content must not truncate the animation.
    expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
    h.handleScroll(h.scrollEvent(1400));
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('lets a new upward drag interrupt verification after an explicit animated jump', () => {
    const h = harness();
    h.scrollToBottom();
    h.handleHistoryTouchStart(touch());
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1180));
    h.handleContentSize(400, 2200);
    h.handleHistoryTouchEnd(touch(420));
    h.handleScrollEndDrag();
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('allows an upward drag to unpin while content grows before the first scroll event', () => {
    const h = harness();
    h.handleHistoryTouchStart(touch());
    h.handleContentSize(400, 2040);
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleContentSize(400, 2080);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScroll(h.scrollEvent(1180));
    expect(h.state.nearBottomRef.current).toBe(false);
    h.handleHistoryTouchEnd(touch(420));
    h.handleScrollEndDrag();
    h.handleMomentumScrollBegin();
    h.handleContentSize(400, 2200);
    h.handleMomentumScrollEnd();
    settle();
    h.handleContentSize(400, 2240);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.scrollToBottom();
    expect(h.scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
  });

  it.each(['handleHistoryTouchEnd', 'handleHistoryTouchCancel'] as const)(
    'catches up after %s when output ended during a stationary touch', (release) => {
      const h = harness();
      h.handleHistoryTouchStart(touch());
      h.handleContentSize(400, 2300);
      settle();
      expect(h.scrollToEnd).not.toHaveBeenCalled();
      h[release](touch());
      settle();
      expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(h.state.scrollMetricsRef.current.offsetY).toBe(1500);
    },
  );

  it.each([1196, 1194, 1192, 1190])('applies the cumulative drag threshold to a trailing offset of %i after large growth', (trailingOffset) => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleContentSize(400, 2500);
    h.handleScrollEndDrag(h.scrollEvent(trailingOffset));
    // End-drag carries the final offset even when the matching onScroll is delivered later.
    h.handleScroll(h.scrollEvent(trailingOffset));
    expect(h.state.nearBottomRef.current).toBe(trailingOffset >= 1192);
    settle();
    if (trailingOffset < 1192) {
      expect(h.scrollToEnd).not.toHaveBeenCalled();
      return;
    }
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
    h.handleScroll(h.scrollEvent(1700));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleContentSize(400, 2540);
    expect(h.scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('unpins a trailing drag across momentum-start ordering: %s', (momentumFirst) => {
    const h = harness();
    h.handleHistoryTouchStart(touch());
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleHistoryTouchEnd(touch());
    h.handleScrollEndDrag(h.scrollEvent(1190));
    if (momentumFirst) h.handleMomentumScrollBegin();
    h.handleScroll(h.scrollEvent(1190));
    if (!momentumFirst) h.handleMomentumScrollBegin();
    h.handleMomentumScrollEnd();
    h.handleContentSize(400, 2500);
    settle();
    expect(h.state.nearBottomRef.current).toBe(false);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('retires a completed drag after a no-op release verification', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1200));
    h.handleScrollEndDrag();
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScroll(h.scrollEvent(1190));
    h.handleContentSize(400, 2500);
    settle();
    expect(h.state.nearBottomRef.current).toBe(true);
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it.each([1180, 900])('preserves a short drag through a post-release layout correction to %i', (offset) => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleContentSize(400, 2500);
    h.handleScrollEndDrag(h.scrollEvent(1196));
    // MVCP may correct the visible anchor before the release verifier runs.
    h.handleScroll(h.scrollEvent(offset));
    expect(h.state.nearBottomRef.current).toBe(true);
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false });
    expect(h.state.scrollMetricsRef.current.offsetY).toBe(1700);
  });

  it('can unpin again after returning to the bottom within the same drag', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1180));
    expect(h.state.nearBottomRef.current).toBe(false);
    h.handleScroll(h.scrollEvent(1200));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleScroll(h.scrollEvent(1180));
    expect(h.state.nearBottomRef.current).toBe(false);
  });

  it('forgets the previous drag when an explicit command owns native scroll events', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleScrollEndDrag();
    h.scrollToBottom();
    h.handleScroll(h.scrollEvent(1190));
    expect(h.state.nearBottomRef.current).toBe(true);
  });

  it('measures a new drag from its own starting offset', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleScrollEndDrag();
    h.handleHistoryTouchStart(touch());
    h.handleScrollBeginDrag(h.scrollEvent(1196));
    h.handleScroll(h.scrollEvent(1190));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleScroll(h.scrollEvent(1186));
    expect(h.state.nearBottomRef.current).toBe(false);
  });

  it('pauses already queued verification and waits for momentum to end before catching up', () => {
    const h = harness();
    h.state.scrollMetricsRef.current.contentHeight = 2200;
    h.runStickToLatestVerify();
    h.handleHistoryTouchStart(touch());
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleHistoryTouchEnd(touch());
    h.handleMomentumScrollBegin();
    h.handleContentSize(400, 2300);
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleMomentumScrollEnd();
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the drag dead zone authoritative when the tail grows beyond the distance threshold', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleContentSize(400, 2500);
    h.handleScroll(h.scrollEvent(1194));
    expect(h.state.nearBottomRef.current).toBe(true);
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleScroll(h.scrollEvent(1190));
    expect(h.state.nearBottomRef.current).toBe(false);
    h.handleScrollEndDrag();
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('still unpins a real momentum fling after a short drag', () => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleScrollEndDrag();
    h.handleMomentumScrollBegin();
    h.handleScroll(h.scrollEvent(900));
    expect(h.state.nearBottomRef.current).toBe(false);
    h.handleContentSize(400, 2500);
    h.handleMomentumScrollEnd();
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('blocks a previously scheduled circuit recovery while the finger owns the viewport', () => {
    const h = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) h.handleContentSize(400, i % 2 ? 2100 : 2200);
    expect(h.state.followEndPinRecoveryTimerRef.current).not.toBeNull();
    h.scrollToEnd.mockClear();
    h.handleHistoryTouchStart(touch());
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
    h.handleHistoryTouchEnd(touch());
    settle();
    expect(h.state.scrollMetricsRef.current.offsetY).toBe(1300);
  });

  it('does not resume tail follow while a history page owns the anchor', () => {
    const h = harness();
    h.state.readingOlderRef.current = true;
    h.state.nearBottomRef.current = false;
    h.handleHistoryTouchStart(touch());
    h.handleContentSize(400, 2500);
    h.handleHistoryTouchEnd(touch());
    settle();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });
});
