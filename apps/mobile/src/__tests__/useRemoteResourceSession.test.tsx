// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandNeedsRemoteSession, parseMobileLocalSystemCommand } from '@/session/systemCard';
import { parseMobileDesktopCommand } from '@/session/desktopSlashCommands';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  language: "en", focused: true,
  t: (key: string) => key, metadataVerified: true,
  resourceId: 'bot-1', sessionId: 'task-1', openSearch: '', resourceHistorySessionId: '', resourceThreadRootSessionId: '', resourceThreadRootClientId: '',
  markRead: vi.fn(), forget: vi.fn(),
  store: { getSessionDeviceId: vi.fn(), upsertDeviceSession: vi.fn() },
  router: { replace: vi.fn(), setParams: vi.fn() },
  auth: { user: { id: 'owner' }, accountGeneration: 1 },
  link: { openLink: vi.fn(), invoke: vi.fn(), connectionEpoch: 1, status: 'online', onRemoteResourceChanged: vi.fn(() => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('@/session/useCachedCompanionSession', () => ({ useCachedCompanionSession: () => null }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t, i18n: { language: h.language } }) }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useIsFocused: () => h.focused,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => h.focused ? effect() : undefined, [effect, h.focused]),
    useLocalSearchParams: () => ({ resourceCollectionId: 'teammates', resourceId: h.resourceId, resourceKind: 'bot', openSearch: h.openSearch, resourceHistorySessionId: h.resourceHistorySessionId, resourceThreadRootSessionId: h.resourceThreadRootSessionId, resourceThreadRootClientId: h.resourceThreadRootClientId }),
    useRouter: () => h.router,
  };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', async () => ({ ...await vi.importActual<typeof import('@/device-link/remoteStatus')>('@/device-link/remoteStatus'), formatRemoteError: String }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.get }));
vi.mock('@/device-link/remoteResourceCache', () => ({ markRemoteResourceRead: h.markRead, forgetRemoteResource: h.forget }));
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
let result: ReturnType<typeof useRemoteResourceSession>;
let root: Root | undefined;
let container: HTMLDivElement;
function Probe({ canMarkRead }: { canMarkRead: boolean }) {
  result = useRemoteResourceSession('mac', 'My Mac', h.sessionId, canMarkRead, h.metadataVerified);
  const { resource } = result;
  return typeof resource?.display.title === 'string' ? resource.display.title : null;
}
async function render(canMarkRead = false) {
  if (!root) { container = document.createElement('div'); root = createRoot(container); }
  await act(async () => root!.render(createElement(Probe, { canMarkRead })));
  // A viewport receipt is separate from loading/entering the chat.
  result.markReadThrough(200);
}
beforeEach(() => { vi.clearAllMocks(); h.link.openLink.mockResolvedValue(undefined); h.openSearch = ''; h.resourceHistorySessionId = ''; h.resourceThreadRootSessionId = ''; h.resourceThreadRootClientId = ''; h.auth.accountGeneration = 1; h.metadataVerified = true; h.focused = true; h.language = "en"; h.resourceId = 'bot-1'; h.sessionId = 'task-1'; h.link.status = 'online'; h.link.connectionEpoch = 1; h.store.getSessionDeviceId.mockReturnValue(undefined); });
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });

describe('companion task visibility refresh', () => {
  it('does not acknowledge on entry and never acknowledges beyond the rendered tail', async () => {
    h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { lastReplyAt: 200 } });
    container = document.createElement('div'); root = createRoot(container);
    await act(async () => root!.render(createElement(Probe, { canMarkRead: true })));
    expect(h.markRead).not.toHaveBeenCalled();
    result.markReadThrough(100);
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'bot-1', 100);
    result.markReadThrough(300);
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'bot-1', 200);
  });
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
  // Persisted notification identities must not reopen a task after an explicit access rejection (unit).
  it.each([Object.assign(new Error('gone'), { code: 'NOT_FOUND' }), new Error('[NOT_FOUND] resource missing'),
    Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' }), new Error('[PERMISSION_DENIED] resource revoked')])('leaves the cached task when the host rejects the resource', async (error) => {
    h.get.mockRejectedValue(error);
    await render();
    expect(h.router.replace).toHaveBeenCalledWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac',
    } });
    expect(h.forget).toHaveBeenCalledWith('owner', 'bot-1');
  });
  it('retains recovery for a transient connection failure', async () => {
    h.get.mockRejectedValue(new Error('NOT_CONNECTED'));
    await render();
    expect(h.router.replace).not.toHaveBeenCalled();
    expect(h.forget).not.toHaveBeenCalled();
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

it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', "es", "fr", "de", "pt-PT", "pt-BR"])('sends the viewing locale %s and reloads when it changes', async (locale) => {
  h.get.mockImplementation(async () => ({ revision: 'same', links: [], display: { title: h.language } }));
  h.language = locale;
  await render();
  expect(h.get).toHaveBeenLastCalledWith(h.link.invoke, { deviceId: 'mac', deviceName: 'My Mac' },
    { collectionId: 'teammates', id: 'bot-1', kind: 'bot' }, locale);
  h.language = locale === 'en' ? 'ja' : 'en';
  await render();
  expect(h.get.mock.calls.at(-1)?.[3]).toBe(h.language);
  expect(container.textContent).toBe(h.language);
});

it('shows the clicked identity immediately but waits for resource and session validation before read/control readiness', async () => {
  const { readRemoteCollectionCache, writeRemoteCollectionCache, remoteCollectionCacheOwner } = await import('@/device-link/remoteResourceAvailability');
  const owner = remoteCollectionCacheOwner('owner', 1);
  readRemoteCollectionCache(owner, 'teammates');
  writeRemoteCollectionCache(owner, 'teammates', [{ key: 'fixture', host: { deviceId: 'mac', deviceName: 'My Mac' }, item: {
    ref: { collectionId: 'teammates', id: 'bot-1', kind: 'bot' }, revision: 'cached', display: { title: 'Cached teammate' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }],
  } }]);
  let finish!: (value: unknown) => void;
  h.metadataVerified = false;
  h.get.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(true);
  expect(container.textContent).toBe('Cached teammate');
  expect(result.ready).toBe(false);
  expect(h.markRead).not.toHaveBeenCalled();
  await act(async () => finish({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Cached teammate', lastReplyAt: 42 } }));
  expect(result.ready).toBe(false);
  h.metadataVerified = true; await render(true);
  expect(result.ready).toBe(true);
  expect(h.markRead).toHaveBeenCalledExactlyOnceWith('owner', 'mac', 'bot-1', 42);
  expect(h.get).toHaveBeenCalledTimes(1);
  expect(h.link.invoke).not.toHaveBeenCalled(); // Session metadata is the screen's existing read.
});
it('does not refetch the profile when history becomes readable', async () => {
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Teammate', lastReplyAt: 12 } });
  await render(false); await render(true);
  expect(h.get).toHaveBeenCalledTimes(1);
});
it('keeps dispatch unavailable on a transient lookup error and retries in place', async () => {
  vi.useFakeTimers();
  h.get.mockRejectedValue(new Error('NOT_CONNECTED'));
  await render(true);
  await act(async () => vi.advanceTimersByTimeAsync(7750));
  expect(result.ready).toBe(false); expect(result.error).toContain('NOT_CONNECTED');
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Teammate' } });
  await act(async () => result.retry());
  expect(result.ready).toBe(true); expect(result.error).toBe(null);
  expect(h.router.replace).not.toHaveBeenCalled();
});
it('does not allow a changed canonical link to authorize the old conversation', async () => {
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-2' } }], display: { title: 'Teammate' } });
  h.link.invoke.mockResolvedValue({ id: 'task-2', source: 'bot' });
  await render(true);
  expect(result.ready).toBe(false);
  expect(h.router.setParams).toHaveBeenCalledWith({ sessionId: 'task-2' });
  expect(h.markRead).not.toHaveBeenCalled();
});

it('revalidates on refocus without blanking the identity and keeps controls closed during the read', async () => {
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Teammate' } });
  await render(false); expect(result.ready).toBe(true);
  h.focused = false; await render(false); expect(result.ready).toBe(false);
  h.get.mockReturnValue(new Promise(() => {}));
  h.focused = true; await render(false);
  expect(container.textContent).toBe('Teammate'); expect(result.ready).toBe(false);
  expect(h.get).toHaveBeenCalledTimes(2);
});
it('never exposes a cached prior-account identity while the new account lookup is pending', async () => {
  h.get.mockResolvedValue({ links: [], display: { title: 'Old account' } });
  await render(false);
  h.auth.accountGeneration++; h.get.mockReturnValue(new Promise(() => {}));
  await render(false);
  expect(container.textContent).toBe(''); expect(result.ready).toBe(false);
});
it('keeps invitation preparation in its existing recovery screen, with no controls or read receipt', async () => {
  h.get.mockResolvedValue({ links: [], display: { title: 'Preparing' }, blocks: [{ id: 'invitation', primitive: 'status', data: { stage: 'skills' } }] });
  await render(true);
  expect(result.ready).toBe(false); expect(h.markRead).not.toHaveBeenCalled();
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]' }));
});

it('drops a late response when switching companions and fences a disconnected/reconnected entry', async () => {
  let finish!: (value: unknown) => void;
  h.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render(true);
  h.resourceId = 'bot-2'; h.sessionId = 'task-2';
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-2' } }], display: { title: 'Second' } });
  await render(true); expect(container.textContent).toBe('Second'); expect(result.ready).toBe(true);
  await act(async () => finish({ links: [], display: { title: 'First' } }));
  expect(container.textContent).toBe('Second'); expect(h.router.replace).not.toHaveBeenCalled();
  h.link.status = 'offline'; await render(true);
  expect(container.textContent).toBe('Second'); expect(result.ready).toBe(false);
  h.link.status = 'online'; h.link.connectionEpoch++; h.get.mockReturnValue(new Promise(() => {}));
  await render(true); expect(result.ready).toBe(false);
});

it.each([false, true].flatMap(ready => [undefined, 'running', 'create-failed'].map(status => ({ ready, status }))))(
  'keeps composing for dispatch readiness=$ready except during failed creation handoff ($status)', ({ ready, status }) => {
  const expressions = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) expressions.set(node.name.getText(screen), node.initializer.getText(screen));
    ts.forEachChild(node, visit);
  };
  visit(screen);
  const names = ['canUseComposer', 'remoteRealtimeControlsUnavailable', 'outboxConnectionState'];
  const code = names.map(name => `const ${name} = ${expressions.get(name)};`).join('\n');
  const gates = new Function('ready', 'creationTask', `
    const companionEntry = { ready, canCompose: true }, sessionOperationLayout = { canUseComposer: true }, sessionResourceCards = { blocked: false };
    const status = 'online', targetAvailableForDispatch = true, isDeviceUnresponsive = false, outboxRecoverySyncHeld = false, loading = false;
    ${code}
    return { canUseComposer, remoteRealtimeControlsUnavailable, outboxConnectionState };
  `)(ready, status ? { status } : undefined);
  expect(gates.canUseComposer).toBe(status !== 'create-failed');
  expect(gates.remoteRealtimeControlsUnavailable).toBe(!ready);
  expect(gates.outboxConnectionState.autoRecoveringError).toBe(!ready);
});

it('closes controls immediately on a resource push, keeps the title, and coalesces revalidation', async () => {
  vi.useFakeTimers();
  try {
    h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Teammate' } });
    await render();
    expect(result.ready).toBe(true);
    const changed = (h.link.onRemoteResourceChanged.mock.calls as unknown as Array<[(device: string, payload: object) => void]>)[0][0];
    let finish!: (resource: unknown) => void;
    h.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => {
      changed('mac', { collectionId: 'teammates' });
      changed('mac', { collectionId: 'teammates' });
    });
    expect(result.ready).toBe(false);
    expect(container.textContent).toBe('Teammate');
    expect(h.get).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(300));
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(result.ready).toBe(false);
    await act(async () => finish({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { title: 'Teammate' } }));
    expect(result.ready).toBe(true);
  } finally { vi.useRealTimers(); }
});


it.each(['failed', 'identity'])('keeps %s invitation history visible without enabling writes', async stage => {
  h.openSearch = '1';
  h.get.mockResolvedValue({
    blocks: [{ id: 'invitation', primitive: 'status', data: { stage } }],
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }],
    display: { title: 'Recovering teammate', lastReplyAt: 200 },
  });
  await render(true);
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(container.textContent).toBe('Recovering teammate');
  expect(result.ready).toBe(false);
  expect(h.markRead).not.toHaveBeenCalled();

  // The same invitation still redirects on ordinary entry.
  h.openSearch = '';
  h.resourceHistorySessionId = '';
  await render(true);
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]' }));
});

it('validates the canonical task in failed invitation history and restores controls after recovery', async () => {
  h.openSearch = '1';
  const resource = {
    blocks: [{ id: 'invitation', primitive: 'status', data: { stage: 'failed' } }],
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-2' } }],
    display: { title: 'Recovering teammate' },
  };
  h.get.mockResolvedValue(resource);
  h.link.invoke.mockResolvedValue({ id: 'task-2', source: 'bot' });
  await render();
  expect(h.router.setParams).toHaveBeenCalledWith({ sessionId: 'task-2' });
  expect(result.ready).toBe(false);
  h.sessionId = 'task-2';
  await render();
  expect(result.ready).toBe(false);
  h.get.mockResolvedValue({ ...resource, blocks: [{ id: 'invitation', primitive: 'status', data: { stage: 'ready' } }] });
  await act(async () => result.retry());
  expect(result.ready).toBe(true);
});

it('still leaves failed invitation history when the host revokes the resource', async () => {
  h.openSearch = '1';
  h.get.mockRejectedValue(new Error('[NOT_FOUND] resource missing'));
  await render();
  expect(result.ready).toBe(false);
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]' }));
});

it('keeps local editing and durable queuing available offline, and reopens only the target on recovery', async () => {
  const { readRemoteCollectionCache, writeRemoteCollectionCache, remoteCollectionCacheOwner } = await import('@/device-link/remoteResourceAvailability');
  readRemoteCollectionCache(remoteCollectionCacheOwner('owner', 1), 'teammates');
  writeRemoteCollectionCache(remoteCollectionCacheOwner('owner', 1), 'teammates', [{ key: 'offline', host: { deviceId: 'mac', deviceName: 'My Mac' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, revision: 'cached', display: { title: 'Cached teammate' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }],
  } }]);
  h.link.status = 'offline'; await render();
  expect(container.textContent).toBe('Cached teammate');
  expect(result.canCompose).toBe(true); expect(result.ready).toBe(false);
  expect(h.get).not.toHaveBeenCalled(); expect(h.link.openLink).not.toHaveBeenCalled();
  h.link.status = 'online'; h.link.connectionEpoch++;
  h.get.mockResolvedValue({ display: { title: 'Recovered teammate' }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }] });
  await render();
  expect(h.link.openLink).toHaveBeenCalledExactlyOnceWith('mac');
  expect(result.ready).toBe(true); expect(container.textContent).toBe('Recovered teammate');
  // No mutation or automatic read receipt merely for opening and reconnecting.
  expect(h.link.invoke).not.toHaveBeenCalled(); expect(h.markRead).not.toHaveBeenCalled();
});

it.each(['ACCESS_REVOKED', 'REMOTE_DISABLED', 'NOT_FOUND'])('closes local queuing and dispatch on explicit rejection %s without retrying', async code => {
  vi.useFakeTimers(); h.get.mockRejectedValue(Object.assign(new Error(code), { code }));
  await render(); expect(result.canCompose).toBe(false); expect(result.ready).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(h.get).toHaveBeenCalledTimes(1);
});

it.each(['/context', '/learn keep this', '/help', 'keep this message'])('preserves offline command drafts without blocking local text: %s', draft => {
  let guard: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(screen).includes('commandNeedsRemoteSession(')) guard = node;
    ts.forEachChild(node, visit);
  };
  visit(screen);
  if (!guard) throw new Error('Missing production remote-command guard');
  const error = vi.fn();
  const consume = vi.fn();
  const run = new Function('args', `
    const { earlyLocalCommand, earlyDesktopCommand, commandNeedsRemoteSession, connectionDispatchBlockedAtSend,
      companionEntry, setError, consume } = args;
    const readSessionRowNow = () => ({ id: 'existing' });
    const isRemoteSessionMissing = () => false;
    const t = key => key, sendInFlightRef = { current: true }, setSending = () => {};
    ${guard!.getText(screen)}
    consume();
  `);
  for (const [ready, blocked] of [[false, false], [true, true]]) {
    error.mockClear(); consume.mockClear();
    run({ earlyLocalCommand: parseMobileLocalSystemCommand(draft), earlyDesktopCommand: parseMobileDesktopCommand(draft),
      commandNeedsRemoteSession, connectionDispatchBlockedAtSend: blocked, companionEntry: { ready }, setError: error, consume });
    const remote = draft.startsWith('/context') || draft.startsWith('/learn');
    expect(consume).toHaveBeenCalledTimes(remote ? 0 : 1);
    expect(error).toHaveBeenCalledTimes(remote ? 1 : 0);
  }
});

// A search hit in an old thread must not silently jump to today's main chat.
// Real hook entry; existing cases only covered following the canonical link. Unit tier.
it.each([true, false])('keeps a searched historical transcript read-only after verifying ownership (%s)', async owned => {
  h.resourceHistorySessionId = 'task-1';
  h.get.mockResolvedValue({ display: { title: 'Melody' }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'current-chat' } }] });
  h.link.invoke.mockResolvedValue({ sessions: [{ id: owned ? 'task-1' : 'unrelated', role: 'history', status: 'archived' }] });
  await render(true);
  expect(result.canCompose).toBe(false);
  expect(result.ready).toBe(false);
  expect(result.error === null).toBe(owned);
  expect(h.router.setParams).not.toHaveBeenCalled();
  expect(h.markRead).not.toHaveBeenCalled();
});

// Mobile topics: the canonical redirect must not steal a reply; a forged root must
// never unlock sending. Existing transcript tests did not cover writable hidden lanes (unit).
it.each([true, false])('verifies the exact private-topic binding before enabling replies (%s)', async (matches) => {
  h.sessionId = 'topic-1'; h.resourceThreadRootSessionId = 'task-1'; h.resourceThreadRootClientId = 'root-1';
  h.get.mockResolvedValue({ links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'task-1' } }], display: { lastReplyAt: 200 } });
  h.link.invoke.mockResolvedValue({ dmThreadsSupported: true, sessions: [{ id: 'topic-1', role: 'thread', status: 'active',
    threadRoot: { rootSessionId: 'task-1', rootClientId: matches ? 'root-1' : 'somebody-else' } }] });
  await render(true);
  expect(result.ready).toBe(matches);
  expect(result.canCompose).toBe(matches);
  expect(h.router.setParams).not.toHaveBeenCalled();
  expect(h.markRead).not.toHaveBeenCalled();
  h.link.connectionEpoch += 1;
  let resolve!: (value: unknown) => void;
  h.link.invoke.mockReturnValue(new Promise(r => { resolve = r; }));
  await render(true);
  expect(result.ready).toBe(false);
  expect(result.canCompose).toBe(false);
  await act(async () => resolve({ dmThreadsSupported: false }));
  expect(result.ready).toBe(false);
});
