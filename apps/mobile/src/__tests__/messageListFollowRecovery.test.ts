import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scroll from '@/session/messageScroll';

// Execute the production callbacks with a fake native scroll surface. Importing the whole
// renderer would require mocking every native message/media component; copying its logic here
// would fail to catch a missing content-size, layout, or gesture recovery entry point.
const source = ts.createSourceFile(
  'MessageRenderer.tsx',
  readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks = new Map<string, string>();
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(source) === 'useCallback') {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);

function callback<T>(name: string, bindings: Record<string, unknown>): T {
  const expression = callbacks.get(name);
  if (!expression) throw new Error(`Missing production callback: ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(
    ...Object.values(bindings),
  ) as T;
}

function harness() {
  const ref = <T,>(current: T) => ({ current });
  const bindings = {
    ...scroll,
    scrollMetricsRef: ref({ contentHeight: 2000, viewportHeight: 800, offsetY: 1200 }),
    nearBottomRef: ref(true),
    readingOlderRef: ref(false),
    isDraggingRef: ref(false),
    isMomentumScrollingRef: ref(false),
    historyTouchStartYRef: ref<number | null>(null),
    historyTouchTriggeredRef: ref(false),
    dragStartOffsetYRef: ref<number | null>(null),
    followVerifyGenerationRef: ref(0),
    followVerifyFrameRef: ref<ReturnType<typeof setTimeout> | null>(null),
    followVerifyTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    followEndPinRecoveryTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    followEndPinStateRef: ref(scroll.createMobileFollowEndPinState()),
    mvcpSettleAtRef: ref(0),
    programmaticAnimatedScrollInFlightRef: ref(false),
    programmaticScrollSettleAtRef: ref(0),
    historyPrependTransactionRef: ref(null),
    refreshPreviousUserTarget: vi.fn(),
    scheduleHistoryPrependUserHandoffSettle: vi.fn(),
    scheduleQueuedLoadEarlierFlush: vi.fn(),
    maybeTriggerHistoryTouch: vi.fn(),
    restoreHistoryAnchorOnce: vi.fn(),
    scheduleHistoryAnchorRestore: vi.fn(),
    markMobileMvcpSettle: () => {
      bindings.mvcpSettleAtRef.current = scroll.mobileMvcpSettleDeadline(
        bindings.mvcpSettleAtRef.current, Date.now(),
      );
    },
    scrollToEndProgrammatically: vi.fn((_animated: boolean) => {
      bindings.scrollMetricsRef.current.offsetY = scroll.mobileMessageListEndOffset(
        bindings.scrollMetricsRef.current,
      );
    }),
  };
  const withGesture = {
    ...bindings,
    isUserControllingScroll: callback<() => boolean>('isUserControllingScroll', bindings),
  };
  const all = {
    ...withGesture,
    runStickToLatestVerify: callback<() => void>('runStickToLatestVerify', withGesture),
  };
  return {
    ...all,
    contentSize: callback<(width: number, height: number) => void>('handleContentSize', all),
    layout: callback<(event: { nativeEvent: { layout: { height: number } } }) => void>('handleListLayout', all),
    dragEnd: callback<() => void>('handleScrollEndDrag', all),
    momentumBegin: callback<() => void>('handleMomentumScrollBegin', all),
    momentumEnd: callback<() => void>('handleMomentumScrollEnd', all),
    touchEnd: callback<(event: { nativeEvent: { pageY: number } }) => void>('handleHistoryTouchEnd', all),
    touchCancel: callback<() => void>('handleHistoryTouchCancel', all),
  };
}

describe('message-list native geometry recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recovers an old long-list offset after shrinking below one screen', () => {
    const h = harness();
    h.contentSize(400, 500);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(h.scrollToEndProgrammatically).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.scrollMetricsRef.current.offsetY).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks a larger viewport even without a content-size event', () => {
    const h = harness();
    h.layout({ nativeEvent: { layout: { height: 1000 } } });
    vi.advanceTimersByTime(500);
    expect(h.scrollMetricsRef.current.offsetY).toBe(1000);
    expect(h.scrollToEndProgrammatically).toHaveBeenCalledTimes(1);
  });

  it('still checks layout when an earlier native scroll event already reported its height', () => {
    const h = harness();
    h.scrollMetricsRef.current.viewportHeight = 1000;
    h.layout({ nativeEvent: { layout: { height: 1000 } } });
    vi.advanceTimersByTime(500);
    expect(h.scrollMetricsRef.current.offsetY).toBe(1000);
  });

  it('does not force-scroll an already aligned short list', () => {
    const h = harness();
    h.scrollMetricsRef.current.offsetY = 0;
    h.contentSize(400, 500);
    vi.advanceTimersByTime(500);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('yields through a long drag and subsequent momentum, then repairs the final overshoot', () => {
    const h = harness();
    h.isDraggingRef.current = true;
    h.historyTouchStartYRef.current = 100;
    h.contentSize(400, 1600);
    vi.advanceTimersByTime(3000);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.dragEnd();
    h.touchEnd({ nativeEvent: { pageY: 100 } });
    h.momentumBegin();
    vi.advanceTimersByTime(3000);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    h.momentumEnd();
    vi.advanceTimersByTime(500);
    expect(h.scrollToEndProgrammatically).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.scrollMetricsRef.current.offsetY).toBe(800);
  });

  it('resumes after a held touch is cancelled without any native drag events', () => {
    const h = harness();
    h.historyTouchStartYRef.current = 100;
    h.contentSize(400, 500);
    vi.advanceTimersByTime(3000);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    h.touchCancel();
    vi.advanceTimersByTime(500);
    expect(h.scrollMetricsRef.current.offsetY).toBe(0);
  });

  it('does not reclaim the viewport after the reader has unpinned follow', () => {
    const h = harness();
    h.nearBottomRef.current = false;
    h.contentSize(400, 500);
    h.layout({ nativeEvent: { layout: { height: 1000 } } });
    h.dragEnd();
    h.momentumEnd();
    vi.advanceTimersByTime(3000);
    expect(h.scrollToEndProgrammatically).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retrying if the native surface never acknowledges a correction', () => {
    const h = harness();
    h.scrollToEndProgrammatically.mockImplementation(() => {});
    h.contentSize(400, 500);
    vi.advanceTimersByTime(3000);
    expect(h.scrollToEndProgrammatically).toHaveBeenCalledTimes(scroll.MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
