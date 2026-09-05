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
    ...scrollModel, ...state, listRef: ref({ scrollToEnd }), bottomOverlayHeight: undefined,
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
  return { ...callbacks, state, scrollToEnd, scrollEvent };
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

  it.each([1196, 1194])('preserves a dead-zone drag through a trailing offset of %i after large growth', (trailingOffset) => {
    const h = harness();
    h.handleScrollBeginDrag(h.scrollEvent(1200));
    h.handleScroll(h.scrollEvent(1196));
    h.handleContentSize(400, 2500);
    h.handleScrollEndDrag();
    // The trailing native event may arrive before the release verifier's first frame.
    h.handleScroll(h.scrollEvent(trailingOffset));
    settle();
    expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
    h.handleScroll(h.scrollEvent(1700));
    expect(h.state.nearBottomRef.current).toBe(true);
    h.handleContentSize(400, 2540);
    expect(h.scrollToEnd).toHaveBeenCalledTimes(2);
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
