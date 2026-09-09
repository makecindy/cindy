import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
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
    && ['requestLoadEarlier', 'flushQueuedLoadEarlier', 'scheduleQueuedLoadEarlierFlush'].includes(node.name.getText(source))) {
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
    const compiled = ts.transpileModule([...pagingCallbacks].map(([name, body]) =>
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
