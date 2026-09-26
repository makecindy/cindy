import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the production component's layout/passive callbacks in their real
// order. Only native list/animation APIs are injected; no positioning logic is
// copied into this fixture and no reveal deadline is advanced.
const source = ts.createSourceFile('MessageRenderer.tsx', readFileSync(
  resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(marker: string, bindings: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ['useCallback', 'useLayoutEffect', 'useEffect'].includes(node.expression.getText(source))
      && node.arguments[0]?.getText(source).includes(marker)) expression = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`Missing production callback: ${marker}`);
  const compiled = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}; return callback;`)(...Object.values(bindings));
}
const ref = <T>(current: T) => ({ current });
function fixture(focused: string | null = null, saved?: object) {
  const state = { revealed: false, away: false };
  const bindings: Record<string, any> = {
    initialAnchorDoneRef: ref(false), initialRevealGenerationRef: ref(0),
    initialRevealAnimationRef: ref(null), initialRevealProgress: { setValue: vi.fn() },
    setListRevealed: (value: boolean) => { state.revealed = value; },
    setIsAwayFromBottom: (value: boolean) => { state.away = value; },
    Animated: { timing: () => ({ start: vi.fn(), stop: vi.fn() }) },
    Easing: { step1: 'step1' }, MOBILE_INITIAL_REVEAL_MAX_MS: 300,
    focusedItemKeyRef: ref(focused), reopeningPosition: saved, reopeningAnchorRef: ref(null),
    listData: [{ key: 'older' }, { key: 'latest' }], nearBottomRef: ref(true),
    markProgrammaticScroll: vi.fn(), dragStartOffsetYRef: ref(null),
    listRef: ref({ scrollToIndex: vi.fn(() => Promise.resolve()) }),
    scrollToEndProgrammatically: vi.fn(), reconcileReopeningAnchor: vi.fn(),
    mobileMessageHistoryRowKeyByIdentity: vi.fn(),
    lastAppliedFocusKeyRef: ref(null), userScrollForOlderRef: ref(false), lastAutoLoadEarlierKeyRef: ref(null),
    focusRunKey: focused ? `request:${focused}` : null, focusedItemKey: focused,
  };
  bindings.revealPositionedHistory = callback('if (!initialAnchorDoneRef.current || !animation)', bindings);
  bindings.scrollToIndexProgrammatically = callback('return listRef.current?.scrollToIndex', bindings);
  const layout = () => callback('if (initialAnchorDoneRef.current) return', bindings)();
  const focus = () => callback('if (!focusedItemKey || !focusRunKey)', { ...bindings, listRevealed: state.revealed })();
  return { state, bindings, layout, focus };
}

describe('message entry lifecycle', () => {
  it('positions explicit navigation first and reveals on seek completion without visiting the tail', async () => {
    const h = fixture('older');
    let finish!: () => void;
    h.bindings.listRef.current.scrollToIndex.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    h.layout(); h.focus();
    expect(h.bindings.scrollToEndProgrammatically).not.toHaveBeenCalled();
    expect(h.bindings.listRef.current.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 0, viewPosition: 0.45, animated: false });
    expect(h.state.revealed).toBe(false);
    finish(); await Promise.resolve();
    expect(h.state.revealed).toBe(true);
    h.focus();
    expect(h.bindings.listRef.current.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(h.bindings.nearBottomRef.current).toBe(false);
  });
  it('waits for a missing linked row without first scrolling to the latest row', async () => {
    const h = fixture('not-loaded'); h.layout(); h.focus();
    expect(h.bindings.listRef.current.scrollToIndex).not.toHaveBeenCalled();
    expect(h.bindings.scrollToEndProgrammatically).not.toHaveBeenCalled();
    h.bindings.listData.unshift({ key: 'not-loaded' });
    h.focus(); await Promise.resolve();
    expect(h.state.revealed).toBe(true);
    expect(h.bindings.listRef.current.scrollToIndex).toHaveBeenCalledTimes(1);
  });
  it('does not reveal another teammate from an old asynchronous positioning completion', async () => {
    const h = fixture('older');
    let finish!: () => void;
    h.bindings.listRef.current.scrollToIndex.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    h.layout(); h.focus();
    h.bindings.initialRevealGenerationRef.current++;
    finish(); await Promise.resolve();
    expect(h.state.revealed).toBe(false);
  });
  it('opens normal histories at the latest row once, including a previously empty cache', () => {
    const h = fixture();
    h.bindings.listData = []; h.layout();
    expect(h.state.revealed).toBe(true);
    h.bindings.listData = [{ key: 'latest' }]; h.layout(); h.layout();
    expect(h.bindings.scrollToEndProgrammatically).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.bindings.nearBottomRef.current).toBe(true);
  });
  it('restores deliberate history reading and lets an explicit link override the bookmark', () => {
    const saved = { atEnd: false, anchor: { key: 'older', viewportOffset: 24 } };
    const h = fixture(null, saved); h.layout();
    expect(h.bindings.listRef.current.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 0, viewPosition: 0, viewOffset: 24, animated: false });
    expect(h.bindings.scrollToEndProgrammatically).not.toHaveBeenCalled();
    const linked = fixture('latest', saved); linked.layout(); linked.focus();
    expect(linked.bindings.listRef.current.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, viewPosition: 0.45, animated: false });
  });
});

it('reconciles late attachment, composer and keyboard measurements through the production list callbacks without stealing history reading', async () => {
  const { createMobileTailFollower } = await import('@/session/messageTailFollower');
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  try {
    const metrics = ref({ contentHeight: 1200, offsetY: 356, viewportHeight: 844 });
    const nearBottom = ref(true), readingOlder = ref(false);
    const correct = vi.fn((offset: number) => { metrics.current.offsetY = offset; });
    const follower = createMobileTailFollower({
      read: () => ({ metrics: metrics.current, stickToLatest: nearBottom.current,
        preservingHistory: readingOlder.current, userControllingScroll: false,
        layoutSettleAt: 0, animatedScrollUntil: 0 }),
      seekEnd: vi.fn(), correctOffset: correct,
    });
    const bindings = {
      scrollMetricsRef: metrics, nearBottomRef: nearBottom, readingOlderRef: readingOlder,
      historyPrependTransactionRef: ref(null),
      reconcileReopeningAnchor: vi.fn(), markMobileMvcpSettle: vi.fn(),
      getTailFollower: () => follower, runStickToLatestVerify: () => follower.reconcile(),
    };
    const resize = callback('contentHeight: height', bindings);
    const layout = callback('const viewportHeight = event.nativeEvent.layout.height', bindings);
    resize(390, 1800); // Attachment acquired dimensions after first display.
    expect(correct).toHaveBeenLastCalledWith(956);
    layout({ nativeEvent: { layout: { height: 534 } } }); // Keyboard appears.
    await vi.advanceTimersByTimeAsync(200);
    expect(correct).toHaveBeenLastCalledWith(1266);
    resize(390, 1980); // Expanded composer adds measured space to the same list.
    expect(correct).toHaveBeenLastCalledWith(1446);
    layout({ nativeEvent: { layout: { height: 844 } } });
    await vi.advanceTimersByTimeAsync(200);
    expect(correct).toHaveBeenLastCalledWith(1136);
    nearBottom.current = false;
    correct.mockClear();
    resize(390, 2280); // Later media measurement while deliberately reading older rows.
    readingOlder.current = true;
    resize(390, 3280); // History page prepend.
    layout({ nativeEvent: { layout: { height: 534 } } });
    await vi.advanceTimersByTimeAsync(200);
    expect(correct).not.toHaveBeenCalled();
    follower.reset();
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
