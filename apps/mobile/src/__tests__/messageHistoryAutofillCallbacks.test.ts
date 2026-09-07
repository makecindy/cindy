import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { shouldAutoLoadEarlier } from '@/session/messageScroll';

// Execute the production callback so its early dedupe guard and its helper input are both tested.
const source = ts.createSourceFile('renderer.tsx', readFileSync(
  resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callbackSource = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'attemptAutoLoadEarlier'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    callbackSource = node.initializer.arguments[0].getText(source);
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
    historyProgressKey: 'host-80',
    lastAutoLoadEarlierKeyRef: { current: null as string | null },
    listRef: { current: { getState: () => ({ isAtEnd: true, isAtStart: true, isNearStart: true }) } },
    loadEarlierAction: { visible: true, disabled: false },
    shouldAutoLoadEarlier,
    requestLoadEarlier,
  };
  const attempt = () => {
    if (!callbackSource) throw new Error('Missing production callback');
    const compiled = ts.transpileModule(`const callback = ${callbackSource};`, {
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
    bindings.historyProgressKey = 'host-60';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(2);
    bindings.historyProgressKey = 'host-40';
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(3);
    bindings.historyProgressKey = 'host-20';
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

  it('uses the same cursor progress for user-driven regroup continuation', () => {
    const { bindings, attempt, requestLoadEarlier } = fixture();
    bindings.userScrollForOlderRef.current = true;
    attempt();
    bindings.historyProgressKey = 'host-60';
    bindings.regroupedHistoryContinuationRef.current = true;
    attempt();
    expect(requestLoadEarlier).toHaveBeenCalledTimes(2);
    expect(bindings.initialHistoryAutofillRemainingRef.current).toBe(3);
  });
});
