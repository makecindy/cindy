import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Execute the page's callbacks with its host boundaries injected. Pure card
// copy/layout assertions were duplicates of rendering, i18n and layout suites.
// These regressions need the page's async scope and returned-message handling.
const page = ts.createSourceFile('session.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode<T extends ts.Node>(find: (node: ts.Node) => node is T): T {
  let result: T | undefined;
  function visit(node: ts.Node) {
    if (find(node)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(page);
  if (!result) throw new Error('Missing production session behavior');
  return result;
}
function evaluate(expression: ts.Expression, bindings: Record<string, unknown>): any {
  const code = ts.transpileModule('const value = ' + expression.getText(page), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn value;')(...Object.values(bindings));
}
function variable(name: string): ts.Expression {
  const declaration = findNode((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(page) === name);
  if (!declaration.initializer) throw new Error('Missing production initializer: ' + name);
  return declaration.initializer;
}
function callback(name: string, bindings: Record<string, unknown>): (...args: any[]) => any {
  const initializer = variable(name);
  if (!ts.isCallExpression(initializer)) throw new Error('Expected production useCallback: ' + name);
  return evaluate(initializer.arguments[0], bindings);
}
function effect(dependencies: string[], bindings: Record<string, unknown>): () => void {
  const call = findNode((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
    && node.arguments.length > 1 && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements.map(item => item.getText(page)).join(',') === dependencies.join(','));
  return evaluate(call.arguments[0], bindings);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function containingCondition(node: ts.Node): ts.ConditionalExpression {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isConditionalExpression(current)) current = current.parent;
  if (!current) throw new Error('Missing production state branch');
  return current as ts.ConditionalExpression;
}

describe('mobile session page async controls', () => {
  it('replaces revoked shared content with the ended state and suppresses retry controls', () => {
    const ended = findNode((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(page) === 'SharedTaskEndedState');
    const banner = findNode((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(page) === 'ConnectionBanner');
    const replace = vi.fn();
    const bindings = { React, isSharedTaskAccessRevoked: true, ScrollView: 'ScrollView', SharedTaskEndedState: 'Ended',
      topOverlayHeight: 30, spacing: { lg: 16 }, router: { replace } };
    const tree = evaluate(containingCondition(ended), bindings);
    expect(tree.props.children.type).toBe('Ended');
    tree.props.children.props.onReturnToTasks();
    expect(replace).toHaveBeenCalledExactlyOnceWith('/devices');
    expect(evaluate(containingCondition(banner), bindings)).toBeNull();
  });

  it.each(['unchanged', 'sessionId', 'deviceId', 'accountProviderId'])('suppresses stale reset alerts when refresh changes %s', async (changed) => {
    const identity = { deviceId: 'd1', sessionId: 's1', accountProviderId: 'openai' };
    const scope = evaluate(variable('accountControlScope'), identity);
    const accountControlScopeRef = { current: scope };
    const refresh = deferred<void>();
    const alert = vi.fn();
    const clearRetry = vi.fn();
    const reset = callback('resetCodexRateLimits', { codexRateLimits: null, codexResetRetryKey: 'expired-offer', codexResetBusy: false,
      setCodexResetRetryKey: clearRetry, refreshAccountUsage: () => refresh.promise, accountControlScopeRef, accountControlScope: scope,
      Alert: { alert }, t: (key: string) => key });
    const pending = reset();
    expect(clearRetry).toHaveBeenCalledExactlyOnceWith(null);
    expect(alert).not.toHaveBeenCalled();
    if (changed !== 'unchanged') accountControlScopeRef.current = evaluate(variable('accountControlScope'), { ...identity, [changed]: 'changed' });
    refresh.resolve();
    await pending;
    if (changed === 'unchanged') expect(alert).toHaveBeenCalledExactlyOnceWith('session.screen.resetReconfirmTitle', 'session.screen.resetOfferExpired');
    else expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    { result: { clientIds: ['part-1', '', null, 'part-2', 42] }, removed: ['part-1', 'part-2'] },
    { result: { clientIds: [] }, removed: ['requested'] },
    { result: {}, removed: ['requested'] },
  ])('applies the host deletion group, with legacy fallback: $removed', async ({ result, removed }) => {
    const hostResult = deferred<typeof result>();
    const removeMessages = vi.fn();
    const hostDelete = vi.fn(() => hostResult.promise);
    const busy = vi.fn();
    const alert = vi.fn();
    const remove = callback('deleteMessage', { deviceId: 'd1', sessionId: 's1', messageActionBusy: null,
      Alert: { alert }, t: (key: string) => key, maker: { deleteMessage: hostDelete }, remoteSessionStore: { removeMessages },
      setMessageActionBusy: busy, setError: vi.fn() });
    remove('requested');
    expect(hostDelete).not.toHaveBeenCalled();
    const actions = alert.mock.calls[0][2] as { style: string; onPress?: () => void }[];
    actions.find(action => action.style === 'destructive')!.onPress!();
    expect(hostDelete).toHaveBeenCalledExactlyOnceWith('s1', 'requested');
    expect(removeMessages).not.toHaveBeenCalled();
    hostResult.resolve(result);
    await hostResult.promise;
    expect(removeMessages).toHaveBeenCalledExactlyOnceWith('s1', removed, 'd1');
    expect(busy.mock.calls).toEqual([[{ clientId: 'requested', kind: 'delete' }], [null]]);
  });

  it('resyncs once per recovered online connection without reloading on unchanged ticks', () => {
    const bindings = { connectionEpoch: 1, status: 'online', syncedConnectionEpochRef: { current: 1 }, latchOutboxTransportHold: vi.fn(), load: vi.fn() };
    const run = () => effect(['connectionEpoch', 'latchOutboxTransportHold', 'load', 'status'], bindings)();
    run();
    bindings.connectionEpoch = 2; bindings.status = 'offline'; run();
    expect(bindings.load).not.toHaveBeenCalled();
    bindings.status = 'online'; run(); run();
    expect(bindings.load).toHaveBeenCalledTimes(1);
    expect(bindings.latchOutboxTransportHold).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('resyncs only a same-device availability recovery and leaves initial or switched devices to mount', () => {
    const bindings = { deviceId: 'd1', targetAvailableDeviceRef: { current: null as string | null }, targetAvailableRef: { current: null as boolean | null },
      targetAvailableForDispatch: true as boolean | null, status: 'online', latchOutboxTransportHold: vi.fn(), load: vi.fn() };
    const run = () => effect(['deviceId', 'latchOutboxTransportHold', 'load', 'status', 'targetAvailableForDispatch'], bindings)();
    run(); run();
    bindings.deviceId = 'd2'; run();
    expect(bindings.load).not.toHaveBeenCalled();
    bindings.targetAvailableForDispatch = false; run();
    bindings.targetAvailableForDispatch = true; run(); run();
    expect(bindings.load).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('restricts fork and rewind actions for shared-task peers=%s', (shared) => {
    const forkAtMessage = vi.fn(); const previewRewindAtMessage = vi.fn();
    const bindings = { deviceId: 'd1', isSharedTaskPeer: () => shared, forkAtMessage, previewRewindAtMessage };
    for (const [prop, handler] of [['onForkMessage', forkAtMessage], ['onPreviewRewind', previewRewindAtMessage]] as const) {
      const attribute = findNode((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText(page) === prop);
      if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) throw new Error('Missing page action binding: ' + prop);
      const action = evaluate(attribute.initializer.expression, bindings);
      if (shared) expect(action).toBeUndefined();
      else { action('m1'); expect(handler).toHaveBeenCalledExactlyOnceWith('m1'); }
    }
  });
});
