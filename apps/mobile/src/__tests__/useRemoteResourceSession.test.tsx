// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  markRead: vi.fn(),
  store: { getSessionDeviceId: vi.fn(), upsertDeviceSession: vi.fn() },
  router: { replace: vi.fn(), setParams: vi.fn() },
  auth: { user: { id: 'owner' }, accountGeneration: 1 },
  link: { invoke: vi.fn(), connectionEpoch: 1, status: 'online', onRemoteResourceChanged: vi.fn(() => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => ({ resourceCollectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot' }),
    useRouter: () => h.router,
  };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.get }));
vi.mock('@/device-link/remoteResourceCache', () => ({ markRemoteResourceRead: h.markRead }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: h.store }));
import { useRemoteResourceSession } from '@/session/useRemoteResourceSession';
// Evaluate the real screen's hook argument so this regression also catches a
// missing recovery fence at the call site, rather than testing a copied gate.
const screen = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function screenReadGate(contentRecoveryKey: string | null, contentSyncedKey: string | null): boolean {
  let argument: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(screen) === 'useRemoteResourceSession') argument = node.arguments[3];
    ts.forEachChild(node, visit);
  };
  visit(screen);
  if (!argument) throw new Error('Missing production companion read gate');
  const compiled = ts.transpileModule(`const gate = ${argument.getText(screen)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('contentRecoveryKey', 'contentSyncedKey', `
    const currentSession = { id: 'task-1' }, sessionId = 'task-1', connectionEpoch = 1;
    const hasRenderedMessages = true, readAckSyncedKey = 'task-1:1', outboxRecoverySyncHeld = false, loading = false;
    ${compiled}
    return gate;
  `)(contentRecoveryKey, contentSyncedKey);
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
function Probe({ canMarkRead }: { canMarkRead: boolean }) { useRemoteResourceSession('mac', 'My Mac', 'task-1', canMarkRead); return null; }
async function render(canMarkRead = false) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe, { canMarkRead })));
}
beforeEach(() => { vi.clearAllMocks(); h.auth.accountGeneration = 1; h.store.getSessionDeviceId.mockReturnValue(undefined); });
afterEach(() => { act(() => root?.unmount()); root = undefined; });

describe('companion task visibility refresh', () => {
  it('does not mark read until the entered task has rendered its synchronized history', async () => {
    h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { lastReplyAt: 200 } });
    await render(false);
    expect(h.markRead).not.toHaveBeenCalled();
    await render(true);
    expect(h.markRead).toHaveBeenCalledWith('owner', 'mac', 'bot-1', 200);
  });
  it('keeps the gap reply unread until the snapshot after the exact subscription ACK is applied', async () => {
    // Old history has rendered and the ordinary read ACK gate is open, but the
    // resource already advertises a reply produced in the subscription gap.
    h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { lastReplyAt: 200 } });
    await render(screenReadGate(null, null));
    expect(h.markRead).not.toHaveBeenCalled();
    const ack = JSON.stringify(['mac', 'task-1', 1, 7]);
    await render(screenReadGate(ack, null)); // ACK arrived; recovery read pending.
    expect(h.markRead).not.toHaveBeenCalled();
    await render(screenReadGate(ack, JSON.stringify(['mac', 'task-1', 1, 6])));
    expect(h.markRead).not.toHaveBeenCalled(); // A prior ACK snapshot is insufficient.
    await render(screenReadGate(ack, ack)); // Gap reply has now been applied.
    expect(h.markRead).toHaveBeenCalledExactlyOnceWith('owner', 'mac', 'bot-1', 200);
  });
  it.each(['resource', 'link', 'session', 'disconnect'])('preserves unread when opening fails at %s', async (stage) => {
    h.get.mockResolvedValue({ links: stage === 'link' ? [] : [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-2' } }], display: { lastReplyAt: 200 } });
    if (stage === 'resource') h.get.mockRejectedValue(new Error('[NOT_FOUND] missing'));
    h.link.invoke.mockRejectedValue(new Error(stage === 'disconnect' ? 'NOT_CONNECTED' : '[NOT_FOUND] missing task'));
    await render(true);
    expect(h.markRead).not.toHaveBeenCalled();
  });
  it('waits for the replacement task to enter instead of clearing unread on navigation', async () => {
    h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-2' } }], display: { lastReplyAt: 200 } });
    h.link.invoke.mockResolvedValue({ id: 'task-2', source: 'bot' });
    await render(true);
    expect(h.router.setParams).toHaveBeenCalledWith({ sessionId: 'task-2' });
    expect(h.markRead).not.toHaveBeenCalled();
  });
  it.each([Object.assign(new Error('gone'), { code: 'NOT_FOUND' }), new Error('[NOT_FOUND] resource missing')])('leaves the cached task when the host rejects the resource', async (error) => {
    h.get.mockRejectedValue(error);
    await render();
    expect(h.router.replace).toHaveBeenCalledWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac',
    } });
  });
  it('retains recovery for a transient connection failure', async () => {
    h.get.mockRejectedValue(new Error('NOT_CONNECTED'));
    await render();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
  it('ignores a visibility rejection belonging to the previous account', async () => {
    let reject!: (error: Error) => void;
    h.get.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    h.get.mockReturnValueOnce(new Promise(() => {}));
    h.auth.accountGeneration = 2;
    await render();
    await act(async () => reject(new Error('[NOT_FOUND] old owner')));
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});
