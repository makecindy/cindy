import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldAutoLoadEarlier } from '@/session/messageScroll';

// Execute the production progress-key calculation and callback, including the early dedupe guard.
const source = ts.createSourceFile('renderer.tsx', readFileSync(
  resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callbackSource = '';
let progressKeySource = '';
const pagingCallbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
    && ['requestLoadEarlier', 'flushQueuedLoadEarlier', 'scheduleQueuedLoadEarlierFlush', 'handoffHistoryPrependToUser', 'scheduleHistoryPrependUserHandoffSettle', 'maybeFinishHistoryPrependTransaction', 'finishHistoryPrependTransaction'].includes(node.name.getText(source))) {
    pagingCallbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'attemptAutoLoadEarlier'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    callbackSource = node.initializer.arguments[0].getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'historyProgressKey'
    && node.initializer) {
    progressKeySource = node.initializer.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);

function fixture() {
  const requestLoadEarlier = vi.fn();
  const bindings = {
    historyActiveRef: { current: true },
    historyPositioningRef: { current: true },
    onLoadEarlier: () => {},
    readingOlderRef: { current: false },
    queuedLoadEarlierRef: { current: false },
    userScrollForOlderRef: { current: false },
    listRevealed: true,
    initialHistoryAutofillRemainingRef: { current: 3 },
    regroupedHistoryContinuationRef: { current: false },
    firstItemKey: 'local-notice',
    loadEarlierProgressKey: 'host-80' as string | null,
    lastAutoLoadEarlierKeyRef: { current: null as string | null },
    listRef: { current: { getState: () => ({ isAtEnd: true, isAtStart: true, isNearStart: true }) } },
    loadEarlierAction: { visible: true, disabled: false },
    shouldAutoLoadEarlier,
    requestLoadEarlier,
  };
  const attempt = () => {
    if (!callbackSource || !progressKeySource) throw new Error('Missing production paging code');
    const compiled = ts.transpileModule(`const historyProgressKey = ${progressKeySource};
const callback = ${callbackSource};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function(...Object.keys(bindings), `${compiled}\nreturn callback;`)(...Object.values(bindings))();
  };
  return { bindings, attempt, requestLoadEarlier };
}

describe('history autofill production callback', () => {
  it('pauses hidden retained lists without consuming the paging budget', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    bindings.historyActiveRef.current = false;
    attempt();
    expect(requestLoadEarlier).not.toHaveBeenCalled();
    expect(bindings.initialHistoryAutofillRemainingRef.current).toBe(3);
    bindings.historyActiveRef.current = true;
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(1);
  });
  it('continues through host pages behind an unchanged first rendered row, within the cold-open budget', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(1);
    bindings.loadEarlierProgressKey = 'host-60';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(2);
    bindings.loadEarlierProgressKey = 'host-40';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(3);
    bindings.loadEarlierProgressKey = 'host-20';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(3);
  });

  it('does not repeat failed/duplicate pages just because streaming changes the first rendered row', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    attempt();
    bindings.firstItemKey = 'changed-render-item';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first rendered row only when no host cursor is available', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    bindings.loadEarlierProgressKey = null;
    attempt();
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(1);
    bindings.firstItemKey = 'earlier-render-item';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it('uses the same cursor progress for user-driven regroup continuation', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    bindings.userScrollForOlderRef.current = true;
    attempt();
    bindings.loadEarlierProgressKey = 'host-60';
    bindings.regroupedHistoryContinuationRef.current = true;
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(2);
    expect(bindings.initialHistoryAutofillRemainingRef.current).toBe(3);
  });
});

describe('history prefetch during a gesture', () => {
  function pagingFixture(appOwnedAnchor: boolean) {
    const frames: Array<() => void> = [];
    const bindings = {
      MOBILE_HISTORY_PREPEND_USES_APP_OWNED_ANCHOR: appOwnedAnchor,
      historyActiveRef: { current: true },
      historyPositioningRef: { current: true },
      onLoadEarlier: vi.fn(),
      beginLoadEarlier: vi.fn(),
      readingOlderRef: { current: false },
      queuedLoadEarlierRef: { current: false },
      queuedLoadEarlierFlushFrameRef: { current: null as number | null },
      userScrollForOlderRef: { current: true },
      nearBottomRef: { current: false },
      setIsAwayFromBottom: vi.fn(),
      isDraggingRef: { current: false },
      isMomentumScrollingRef: { current: false },
      historyTouchStartYRef: { current: null as number | null },
      historyPrependNativeMvcpDisabledRef: { current: false },
      setHistoryPrependNativeMvcpDisabled: vi.fn(),
      requestAnimationFrame: (fn: () => void) => frames.push(fn),
    };
    const compiled = ts.transpileModule([...pagingCallbacks].filter(([name]) => ['requestLoadEarlier', 'flushQueuedLoadEarlier', 'scheduleQueuedLoadEarlierFlush'].includes(name)).map(([name, body]) =>
      `const ${name} = ${body};`).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const callbacks = new Function(...Object.keys(bindings), `${compiled}
return { requestLoadEarlier, flushQueuedLoadEarlier };`)(...Object.values(bindings));
    return { bindings, callbacks, frame: () => frames.shift()?.() };
  }

  it.each(['drag', 'momentum', 'touch'])('starts iOS prefetch without waiting for %s to end', (gesture) => {
    const h = pagingFixture(false);
    h.bindings.isDraggingRef.current = gesture === 'drag';
    h.bindings.isMomentumScrollingRef.current = gesture === 'momentum';
    h.bindings.historyTouchStartYRef.current = gesture === 'touch' ? 100 : null;
    h.callbacks.requestLoadEarlier();
    h.callbacks.requestLoadEarlier();
    h.frame();
    expect(h.bindings.beginLoadEarlier).toHaveBeenCalledTimes(1);
    expect(h.bindings.setHistoryPrependNativeMvcpDisabled).not.toHaveBeenCalled();
    h.callbacks.requestLoadEarlier();
    h.frame();
    expect(h.bindings.beginLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('keeps Android gesture and committed native-anchor handoff protection', () => {
    const h = pagingFixture(true);
    h.bindings.isDraggingRef.current = true;
    h.callbacks.requestLoadEarlier();
    h.frame();
    expect(h.bindings.beginLoadEarlier).not.toHaveBeenCalled();
    expect(h.bindings.setHistoryPrependNativeMvcpDisabled).not.toHaveBeenCalled();
    h.bindings.isDraggingRef.current = false;
    h.callbacks.flushQueuedLoadEarlier();
    expect(h.bindings.setHistoryPrependNativeMvcpDisabled).toHaveBeenCalledWith(true);
    expect(h.bindings.beginLoadEarlier).not.toHaveBeenCalled();
    h.bindings.historyPrependNativeMvcpDisabledRef.current = true;
    h.callbacks.flushQueuedLoadEarlier();
    expect(h.bindings.beginLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('does not start a queued request invalidated before the next frame', () => {
    const h = pagingFixture(false);
    h.callbacks.requestLoadEarlier();
    h.bindings.queuedLoadEarlierRef.current = false;
    h.frame();
    expect(h.bindings.beginLoadEarlier).not.toHaveBeenCalled();
  });
});

// Unit regression: production visibility + paging handlers, with only native anchor
// verification replaced by an explicit ack. The old visibility handler clears the
// gesture but never releases the committed-page handoff or restarts its queued request.
describe('history pagination across interrupted gestures', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function fixture(pageCommitted: boolean, promiseSettled = true, eol = '\n') {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    const transaction = { generation: 1, pageCommitted, promiseSettled, userHandoffPending: false,
      userControlledAfterCommit: false, userControlledDuringRequest: false, anchorStable: false,
      pendingCorrection: null, verifyDeadlineAt: 0, continueAfterRegroup: false, userInitiated: true };
    const bindings: Record<string, any> = {
      historyPositioning: true, historyPositioningRef: { current: true }, historyActiveRef: { current: true },
      MOBILE_HISTORY_PREPEND_USES_APP_OWNED_ANCHOR: true,
      historyPrependTransactionRef: { current: transaction }, historyAnchorVerifyFrameRef: { current: null },
      readingOlderRef: { current: true }, loadingEarlierRef: { current: !promiseSettled },
      isDraggingRef: { current: true }, isMomentumScrollingRef: { current: false },
      historyTouchStartYRef: { current: 100 }, historyTouchTriggeredRef: { current: true }, dragStartOffsetYRef: { current: 500 },
      nearBottomRef: { current: false }, userScrollForOlderRef: { current: true },
      tailFollowerRef: { current: { reset: vi.fn() } }, getTailFollower: () => ({ reconcile: vi.fn() }),
      captureCurrentHistoryAnchor: () => ({ key: 'reading', viewportOffset: 15 }), clearProgrammaticScroll: vi.fn(),
      regroupedHistoryContinuationRef: { current: false }, setHistoryPrependNativeMvcpDisabled: vi.fn(),
      setLoadEarlierEvaluationVersion: vi.fn(), scheduleHistoryAnchorRestore: vi.fn(),
      queuedLoadEarlierRef: { current: false }, queuedLoadEarlierFlushFrameRef: { current: null },
      historyPrependNativeMvcpDisabledRef: { current: true }, onLoadEarlier: vi.fn(), beginLoadEarlier: vi.fn(),
    };
    // Exercise Windows checkouts on every platform, without depending on the
    // host Git core.autocrlf setting. Match the effect independently of whitespace.
    const visibilitySource = ts.createSourceFile('renderer.tsx', source.text.replace(/\r?\n/g, eol),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let visibility = '';
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(visibilitySource) === 'useEffect'
        && node.arguments[0]?.getText(visibilitySource).includes('if (!historyPositioning)')
        && node.arguments[0].getText(visibilitySource).includes('tailFollowerRef.current?.reset()')) {
        visibility = node.arguments[0].getText(visibilitySource);
      }
      ts.forEachChild(node, visit);
    }
    visit(visibilitySource);
    if (!visibility) throw new Error('Missing production visibility effect');
    const compile = ts.transpileModule([...pagingCallbacks].filter(([name]) => name !== 'requestLoadEarlier')
      .map(([name, body]) => `const ${name} = ${body};`).join('\n')
      + `\nreturn { ${[...pagingCallbacks.keys()].filter(name => name !== 'requestLoadEarlier').join(', ')}, visibility: ${visibility} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const callbacks = () => new Function(...Object.keys(bindings), compile)(...Object.values(bindings));
    const setVisible = (value: boolean) => {
      bindings.historyPositioning = value; bindings.historyPositioningRef.current = value;
      bindings.historyActiveRef.current = value;
      callbacks().visibility();
    };
    return { bindings, transaction, callbacks, setVisible };
  }
  it.each([true, false].flatMap(committed => ['\n', '\r\n'].map(eol => ({ committed, eol }))))(
    'resumes a handed-off page after hiding (committed=$committed, eol=$eol)', ({ committed, eol }) => {
    const h = fixture(committed, true, eol);
    h.callbacks().handoffHistoryPrependToUser();
    h.setVisible(false);
    h.callbacks().scheduleHistoryPrependUserHandoffSettle();
    vi.advanceTimersByTime(64);
    expect(h.bindings.scheduleHistoryAnchorRestore).not.toHaveBeenCalled();
    expect(h.bindings.readingOlderRef.current).toBe(true);
    h.setVisible(true); h.setVisible(true);
    vi.advanceTimersByTime(64);
    if (committed) {
      expect(h.transaction.userControlledAfterCommit).toBe(false);
      expect(h.bindings.scheduleHistoryAnchorRestore).toHaveBeenCalledWith(1);
      // Native verification acknowledges the restored reading anchor.
      h.transaction.anchorStable = true;
      h.callbacks().maybeFinishHistoryPrependTransaction(1);
    }
    expect(h.bindings.readingOlderRef.current).toBe(false);
    expect(h.bindings.nearBottomRef.current).toBe(false);
    expect(h.bindings.setHistoryPrependNativeMvcpDisabled).toHaveBeenCalledOnce();
  });
  it('resumes a committed page whose anchor frame was suspended without a gesture handoff', () => {
    const h = fixture(true);
    h.bindings.isDraggingRef.current = false;
    h.bindings.historyTouchStartYRef.current = null;
    const staleFrame = vi.fn();
    h.bindings.historyAnchorVerifyFrameRef.current = requestAnimationFrame(staleFrame);
    h.setVisible(false);
    vi.advanceTimersByTime(64);
    expect(staleFrame).not.toHaveBeenCalled();
    h.setVisible(true);
    expect(h.bindings.scheduleHistoryAnchorRestore).toHaveBeenCalledWith(1);
    h.transaction.anchorStable = true;
    h.callbacks().maybeFinishHistoryPrependTransaction(1);
    expect(h.bindings.readingOlderRef.current).toBe(false);
  });
  it('keeps an in-flight request until it settles after reentry', () => {
    const h = fixture(false, false);
    h.callbacks().handoffHistoryPrependToUser();
    h.setVisible(false); h.setVisible(true);
    vi.advanceTimersByTime(64);
    expect(h.bindings.readingOlderRef.current).toBe(true);
    h.transaction.promiseSettled = true;
    h.bindings.loadingEarlierRef.current = false;
    h.callbacks().scheduleHistoryPrependUserHandoffSettle();
    vi.advanceTimersByTime(64);
    expect(h.bindings.readingOlderRef.current).toBe(false);
  });
  it('restarts an interrupted queued request only after returning, once', () => {
    const h = fixture(false);
    h.bindings.historyPrependTransactionRef.current = null;
    h.bindings.queuedLoadEarlierRef.current = true;
    h.setVisible(false);
    h.callbacks().scheduleQueuedLoadEarlierFlush();
    vi.advanceTimersByTime(64);
    expect(h.bindings.beginLoadEarlier).not.toHaveBeenCalled();
    h.setVisible(true); h.setVisible(true);
    vi.advanceTimersByTime(64);
    expect(h.bindings.beginLoadEarlier).toHaveBeenCalledOnce();
  });
});
