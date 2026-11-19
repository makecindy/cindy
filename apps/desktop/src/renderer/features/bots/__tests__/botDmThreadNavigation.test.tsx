// @vitest-environment jsdom
/**
 * Test value: real BotDmThreadHost/Panel, observable source and writable session.
 * Regression: creating a topic while an old topic URL is still rendered must not reopen it.
 * Gap: resize tests stub away URL updates and never switch topics.
 * Minimum input: old URL + successful new ensure + delayed router commit (React transition).
 * Tier: unit, controlled IPC/router promises, no user data or real messages.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(), reload: vi.fn(), send: vi.fn(), around: vi.fn(),
  realRouter: false, navigationType: 'REPLACE', location: { key: 'initial', state: null as unknown }, pendingState: null as unknown,
  params: new URLSearchParams(), pending: null as URLSearchParams | null,
  listeners: new Set<() => void>(), profiles: [] as unknown[],
  hiddenListeners: new Set<(hidden: boolean) => void>(),
  historyEpoch: 0, historyListeners: new Set<() => void>(),
  snapshots: new Map<string, { messages: unknown[] }>(),
}));
const setParams = (update: (p: URLSearchParams) => URLSearchParams, options?: { state?: unknown }) => {
  h.pending = update(h.params); h.pendingState = options?.state ?? null;
};
vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual,
    useLocation: () => h.realRouter ? actual.useLocation() : h.location,
    useNavigationType: () => h.realRouter ? actual.useNavigationType() : h.navigationType,
    useSearchParams: () => h.realRouter ? actual.useSearchParams() : [
      useSyncExternalStore((fn) => { h.listeners.add(fn); return () => { h.listeners.delete(fn); }; }, () => h.params),
      setParams,
    ],
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {
  getSnapshot: (id: string) => h.snapshots.get(id),
  getMessageHistoryEpoch: () => h.historyEpoch,
  subscribe: (_id: string, listener: () => void) => {
    h.historyListeners.add(listener); return () => { h.historyListeners.delete(listener); };
  },
} }));
vi.mock('@/lib/makerTransport', () => ({ aroundMessagesByClientIdFor: h.around }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.profiles }));
vi.mock('../botReadState', () => ({ botDmThreadReadKey: (id: string) => id, markBotRead: vi.fn() }));
vi.mock('../botDmThreads', () => ({ isBotDmThreadUnread: () => false,
  useBotDmThreadList: () => ({ threads: new Map(), reload: h.reload, readVersion: 0 }),
}));
vi.mock('../useThreadPanelResize', () => ({ useThreadPanelResize: () => undefined }));
vi.mock('@/cindy-brain/PluginUiContributions', () => ({ usePluginUiMessageCandidates: () => [] }));
vi.mock('../BotGroupTimelineItem', () => ({ BotGroupTimelineItem: ({ message }: { message: { content: string; attachments: { name: string; url: string | null; path: string | null }[] } }) => <div><p>{message.content}</p>{message.attachments.map(a => <span key={a.name} data-url={a.url} data-path={a.path}>{a.name}</span>)}</div> }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: ({ sessionIdProp, messageStreamHeader }: {
  sessionIdProp: string; messageStreamHeader: ReactNode;
}) => <div data-testid="session" data-session-id={sessionIdProp}>{messageStreamHeader}
  <p>{sessionIdProp === 'old-topic' ? 'Old discussion' : 'New discussion'}</p>
  <button onClick={() => h.send(sessionIdProp)}>send</button>
</div> }));
import { BotDmThreadHost } from '../BotDmThreadHost';
import { useBotDmThreads } from '../botDmThreadsContext';

function Openers() {
  const threads = useBotDmThreads();
  return <>{['old', 'new', 'third'].map(id => <button key={id} onClick={() => threads?.openThread(id)}>open {id}</button>)}</>;
}
function Host() {
  return <BotDmThreadHost enabled bot={{ id: 'bot', name: 'Cindy' }} rootSessionId="chat" mentions={[]}><Openers /></BotDmThreadHost>;
}
function commitUrl(params = h.pending, state = params === h.pending ? h.pendingState : null) {
  if (!params) throw new Error('No pending navigation');
  act(() => { h.location = { key: crypto.randomUUID(), state }; h.params = params; h.pending = null; h.listeners.forEach(fn => fn()); });
}
async function click(id: string) { await act(async () => { fireEvent.click(screen.getByText('open ' + id)); }); }
beforeEach(() => {
  setDataOwnerGeneration('test-owner');
  h.realRouter = false; h.navigationType = 'REPLACE';
  h.location = { key: 'initial', state: null }; h.pendingState = null;
  h.hiddenListeners.clear();
  document.documentElement.removeAttribute('data-app-hidden');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  h.historyEpoch = 0; h.historyListeners.clear();
  h.around.mockReset().mockResolvedValue([]);
  h.ensure.mockReset().mockImplementation(async ({ rootClientId }) => ({ ok: true, sessionId: rootClientId + '-topic', created: true }));
  h.send.mockReset(); h.reload.mockReset(); h.params = new URLSearchParams('thread=old-topic'); h.pending = null;
  h.profiles = [{ id: 'bot', sessions: ['old', 'new', 'third'].map(id => ({ id: id + '-topic', role: 'thread', status: 'active', threadRoot: { rootSessionId: 'chat', rootClientId: id } })) }];
  h.snapshots.set('chat', { messages: ['old', 'new', 'third'].map(id => ({ clientId: id, role: 'assistant', content: id + ' source' })) });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { onWindowHiddenChange: (fn: (hidden: boolean) => void) => { h.hiddenListeners.add(fn); return () => { h.hiddenListeners.delete(fn); }; }, localDb: { bots: { dmThread: { ensure: h.ensure } } } } });
});
afterEach(cleanup);

it('keeps the selected source and writable topic while the old URL is still rendered', async () => {
  await act(async () => { render(<Host />); });
  await click('new');
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
  expect(screen.getByText('new source')).toBeTruthy();
  expect(screen.queryByText('Old discussion')).toBeNull();
  expect(h.pending?.get('thread')).toBe('new-topic');
  fireEvent.click(screen.getByText('send'));
  expect(h.send).toHaveBeenCalledWith('new-topic');
  commitUrl();
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
});

it('ignores an older ensure result after a later message was selected', async () => {
  await act(async () => { render(<Host />); });
  let resolve!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click('new');
  expect(screen.queryByTestId('session')).toBeNull();
  expect(screen.getByText('new source')).toBeTruthy();
  await click('third');
  await act(async () => { resolve({ ok: true, sessionId: 'new-topic', created: true }); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('third-topic');
  expect(h.pending?.get('thread')).toBe('third-topic');
});

it('ignores a late failure and does not reopen a closed pending topic', async () => {
  await act(async () => { render(<Host />); });
  let reject!: (reason: Error) => void;
  h.ensure.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  await click('new'); await click('third');
  await act(async () => { reject(new Error('late failure')); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('third-topic');
  let resolve!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click('new');
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await act(async () => { resolve({ ok: true, sessionId: 'new-topic', created: true }); });
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(h.pending?.has('thread')).toBe(false);
});

it('restores the persisted topic URL after remount and reopens the same source idempotently', async () => {
  const view = render(<Host />);
  await act(async () => {});
  await click('new'); commitUrl();
  const calls = h.ensure.mock.calls.length;
  await click('new'); expect(h.ensure).toHaveBeenCalledTimes(calls);
  view.unmount();
  await act(async () => { render(<Host />); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
  expect(screen.getByText('new source')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' })); commitUrl();
  await click('new');
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
  expect(h.ensure).toHaveBeenLastCalledWith({ botId: 'bot', rootSessionId: 'chat', rootClientId: 'new', title: 'new source' });
});

it('follows an external topic link after the previous navigation committed', async () => {
  await act(async () => { render(<Host />); });
  await click('new'); commitUrl();
  await act(async () => { commitUrl(new URLSearchParams('thread=third-topic')); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('third-topic');
  expect(screen.getByText('third source')).toBeTruthy();
});

it('does not change navigation after the originating host unmounts', async () => {
  h.params = new URLSearchParams();
  let resolve!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(<Host />); await click('new'); view.unmount();
  await act(async () => { resolve({ ok: true, sessionId: 'new-topic', created: true }); });
  expect(h.pending).toBeNull();
});

it('restores an older root from storage without importing adjacent main-chat messages', async () => {
  h.params = new URLSearchParams('thread=new-topic');
  h.snapshots.set('chat', { messages: [] });
  h.around.mockResolvedValue([
    { sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'unrelated adjacent message' },
    { sessionId: 'chat', clientId: 'new', role: 'assistant', content: 'persisted new source', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  await act(async () => { render(<Host />); });
  expect(screen.getByText('persisted new source')).toBeTruthy();
  expect(screen.queryByText('unrelated adjacent message')).toBeNull();
  expect(h.around).toHaveBeenCalledWith('chat', 'new', { radius: 0 });
});

it('does not display a late source read in a different topic', async () => {
  h.snapshots.set('chat', { messages: [] });
  let resolve!: (value: unknown) => void;
  h.around.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { render(<Host />); });
  h.around.mockResolvedValue([{ sessionId: 'chat', clientId: 'new', role: 'user', content: { text: 'new user source' }, createdAt: '2026-01-01T00:00:00Z' }]);
  await click('new');
  await act(async () => { resolve([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'late old source' }]); });
  expect(screen.getByText('new user source')).toBeTruthy();
  expect(screen.queryByText('late old source')).toBeNull();
});


it.each([false, true])('keeps image and file pointers in the source (cached=%s)', async cached => {
  h.params = new URLSearchParams('thread=new-topic');
  const images = [{ url: 'xdt-image://chat/diagram.png', originalName: 'diagram.png', mimeType: 'image/png' }];
  const files = [{ name: 'notes.txt', path: '/test-fixtures/notes.txt' }];
  h.snapshots.set('chat', { messages: cached ? [{ clientId: 'new', role: 'user', content: 'media source', images, files }] : [] });
  h.around.mockResolvedValue([{ sessionId: 'chat', clientId: 'new', role: 'user', content: JSON.stringify({ text: 'media source', images, files }) }]);
  await act(async () => { render(<Host />); });
  expect(screen.getByText('diagram.png').getAttribute('data-url')).toBe(images[0].url);
  expect(screen.getByText('notes.txt').getAttribute('data-path')).toBe(files[0].path);
});

it('ignores a pending ensure after the account generation changes', async () => {
  h.params = new URLSearchParams();
  let resolve!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  render(<Host />); await click('new');
  setDataOwnerGeneration('another-owner');
  await act(async () => { resolve({ ok: true, sessionId: 'new-topic', created: true }); });
  expect(h.pending).toBeNull();
  expect(screen.queryByTestId('session')).toBeNull();
});

it('ignores a pending source after the account generation changes', async () => {
  h.snapshots.set('chat', { messages: [] });
  let resolve!: (value: unknown) => void;
  h.around.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { render(<Host />); });
  setDataOwnerGeneration('another-owner');
  await act(async () => { resolve([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'stale account root' }]); });
  expect(screen.queryByText('stale account root')).toBeNull();
});

it('ignores pending ensure when the host changes without unmounting', async () => {
  h.params = new URLSearchParams();
  let resolve!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const tree = (id: string) => <BotDmThreadHost enabled bot={{ id, name: id }} rootSessionId="chat" mentions={[]}><Openers /></BotDmThreadHost>;
  const view = render(tree('bot')); await click('new');
  view.rerender(tree('another-bot'));
  await act(async () => { resolve({ ok: true, sessionId: 'new-topic', created: true }); });
  expect(h.pending).toBeNull();
  expect(screen.queryByTestId('session')).toBeNull();
});

it('retains an in-memory image source before it becomes a persisted pointer', async () => {
  h.params = new URLSearchParams('thread=new-topic');
  h.snapshots.set('chat', { messages: [{ clientId: 'new', role: 'user', content: '',
    images: [{ base64: 'fixture-bytes', mimeType: 'image/png', originalName: 'pending.png' }] }] });
  await act(async () => { render(<Host />); });
  expect(screen.getByText('pending.png').getAttribute('data-url')).toBe('data:image/png;base64,fixture-bytes');
});

it('does not reuse an already fetched source after an owner change and rerender', async () => {
  h.snapshots.set('chat', { messages: [] });
  h.around.mockResolvedValue([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'previous owner source' }]);
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<Host />); });
  expect(screen.getByText('previous owner source')).toBeTruthy();
  h.around.mockResolvedValue([]); // The new owner has no source row.
  setDataOwnerGeneration('another-owner');
  await act(async () => { view.rerender(<Host />); });
  expect(screen.queryByText('previous owner source')).toBeNull();
});


it.each(['[1,2,3]', '{"text":"part","other":"keep"}', { text: 'part', other: 'keep' }])(
  'preserves assistant JSON instead of decoding it as a user envelope: %j', async (content) => {
    h.snapshots.set('chat', { messages: [] });
    h.around.mockResolvedValue([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content }]);
    await act(async () => { render(<Host />); });
    expect(screen.getByText(typeof content === 'string' ? content : JSON.stringify(content))).toBeTruthy();
  },
);

it('invalidates an off-window root and its attachments on history deletion/reset', async () => {
  h.snapshots.set('chat', { messages: [] });
  h.around.mockResolvedValueOnce([{ sessionId: 'chat', clientId: 'old', role: 'user',
    content: { text: 'removed source', files: [{ name: 'removed.txt', path: '/fixture/removed.txt' }] } }]);
  const view = await act(async () => render(<Host />));
  expect(screen.getByText('removed source')).toBeTruthy();
  expect(screen.getByText('removed.txt')).toBeTruthy();
  let stale!: (rows: unknown[]) => void;
  h.around.mockImplementationOnce(() => new Promise(resolve => { stale = resolve; }));
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  expect(screen.queryByText('removed source')).toBeNull();
  expect(screen.queryByText('removed.txt')).toBeNull();
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  await act(async () => { stale([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'stale deleted root' }]); });
  expect(screen.queryByText('stale deleted root')).toBeNull();
  expect(h.around).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(h.historyListeners.size).toBe(0);
});

// §8.3: real panel with native/document visibility signals; unit, no timers.
it.each(['native', 'document'])('defers invalidated source reads while hidden via %s', async signal => {
  const hide = (hidden: boolean) => act(() => {
    if (signal === 'native') {
      document.documentElement.toggleAttribute('data-app-hidden', hidden);
      h.hiddenListeners.forEach(fn => fn(hidden));
    } else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  h.snapshots.set('chat', { messages: [] });
  hide(true);
  const view = await act(async () => render(<Host />));
  expect(h.around).not.toHaveBeenCalled();
  h.around.mockResolvedValueOnce([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'stored source' }]);
  await act(async () => { hide(false); });
  expect(screen.getByText('stored source')).toBeTruthy();
  hide(true); await act(async () => { hide(false); });
  expect(h.around).toHaveBeenCalledTimes(1);
  hide(true);
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  expect(screen.queryByText('stored source')).toBeNull();
  expect(h.around).toHaveBeenCalledTimes(1);
  await act(async () => { hide(false); });
  expect(h.around).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('stored source')).toBeNull();
  view.unmount();
  expect(h.hiddenListeners.size).toBe(0);
  hide(true); await act(async () => { hide(false); });
  expect(h.around).toHaveBeenCalledTimes(2);
});

it('keeps a newer selection when an intermediate own URL commits', async () => {
  await act(async () => { render(<Host />); });
  await click('new');
  const intermediate = h.pending;
  let finish!: (value: unknown) => void;
  h.ensure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('third');
  commitUrl(intermediate);
  await act(async () => { finish({ ok: true, sessionId: 'third-topic', created: true }); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('third-topic');
  expect(screen.getByText('third source')).toBeTruthy();
  expect(h.pending?.get('thread')).toBe('third-topic');
});

it('ignores queued navigation after close but follows an external link to that same topic', async () => {
  await act(async () => { render(<Host />); });
  await click('new');
  const intermediate = h.pending;
  const intermediateState = h.pendingState;
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  const closedUrl = h.pending;
  const closedState = h.pendingState;
  commitUrl(intermediate, intermediateState);
  expect(screen.queryByRole('complementary')).toBeNull();
  commitUrl(closedUrl, closedState);
  await act(async () => { commitUrl(new URLSearchParams('thread=new-topic')); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
});

it('ignores an earlier own URL after the latest topic is ready and honors an external same-URL link', async () => {
  await act(async () => { render(<Host />); });
  await click('new');
  const intermediate = h.pending;
  const intermediateState = h.pendingState;
  await click('third');
  const latest = h.pending;
  const latestState = h.pendingState;
  commitUrl(intermediate, intermediateState);
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('third-topic');
  await act(async () => { commitUrl(new URLSearchParams('thread=new-topic')); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
  commitUrl(latest, latestState);
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('new-topic');
});

it('does not start a hidden deferred read after its data owner changes or panel unmounts', async () => {
  document.documentElement.setAttribute('data-app-hidden', '');
  h.snapshots.set('chat', { messages: [] });
  const view = await act(async () => render(<Host />));
  setDataOwnerGeneration('different-owner');
  await act(async () => { h.hiddenListeners.forEach(fn => fn(false)); });
  expect(h.around).not.toHaveBeenCalled();
  view.unmount();
  expect(h.hiddenListeners.size).toBe(0);
});

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return <><output data-testid="url">{location.search}</output>
    <button onClick={() => navigate('/chat')}>main notification</button>
    <button onClick={() => navigate(-1)}>back</button>
    <button onClick={() => navigate(1)}>forward</button></>;
}

// Real MemoryRouter preserves history state/keys and POP vs REPLACE semantics.
// Minimum regression: A -> push main chat -> B -> back to A, same mounted Host.
it('restores source and send target across real history back/forward, including the main chat', async () => {
  h.realRouter = true;
  await act(async () => { render(<MemoryRouter initialEntries={['/chat']}><HistoryControls /><Host /></MemoryRouter>); });
  await click('old');
  await act(async () => { fireEvent.click(screen.getByText('main notification')); });
  await click('new');
  const check = (root: string) => {
    expect(screen.getByTestId('url').textContent).toBe('?thread=' + root + '-topic');
    expect(screen.getByText(root + ' source')).toBeTruthy();
    expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe(root + '-topic');
    fireEvent.click(screen.getByText('send'));
    expect(h.send).toHaveBeenLastCalledWith(root + '-topic');
  };
  await act(async () => { fireEvent.click(screen.getByText('back')); });
  check('old');
  await act(async () => { fireEvent.click(screen.getByText('forward')); });
  check('new');
  await act(async () => { fireEvent.click(screen.getByText('main notification')); });
  expect(screen.getByTestId('url').textContent).toBe('');
  expect(screen.queryByTestId('session')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByText('back')); });
  check('new');
  await act(async () => { fireEvent.click(screen.getByText('forward')); });
  expect(screen.queryByTestId('session')).toBeNull();
});

it.each(['resolve', 'reject'])('history navigation invalidates a pending topic that later %ss', async outcome => {
  h.realRouter = true;
  await act(async () => { render(<MemoryRouter initialEntries={['/chat?thread=old-topic']}><HistoryControls /><Host /></MemoryRouter>); });
  await act(async () => { fireEvent.click(screen.getByText('main notification')); });
  let finish!: (value: unknown) => void;
  let fail!: (reason: Error) => void;
  h.ensure.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await click('new');
  await act(async () => { fireEvent.click(screen.getByText('back')); });
  expect(screen.getByTestId('session').getAttribute('data-session-id')).toBe('old-topic');
  await act(async () => {
    if (outcome === 'resolve') finish({ ok: true, sessionId: 'new-topic', created: true });
    else fail(new Error('late failure'));
  });
  expect(screen.getByTestId('url').textContent).toBe('?thread=old-topic');
  expect(screen.getByText('old source')).toBeTruthy();
  fireEvent.click(screen.getByText('send'));
  expect(h.send).toHaveBeenLastCalledWith('old-topic');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByText('forward')); });
  expect(screen.getByTestId('url').textContent).toBe('');
  expect(screen.queryByTestId('session')).toBeNull();
});

// §8.6: invalidation bursts must not multiply an already pending exact-root IPC.
it.each(['resolve', 'reject'])('coalesces history invalidations until the pending source read %ss', async outcome => {
  h.snapshots.set('chat', { messages: [] });
  let finish!: (rows: unknown[]) => void;
  let fail!: (reason: Error) => void;
  h.around.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await act(async () => { render(<Host />); });
  for (let i = 0; i < 4; i++) {
    await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  }
  expect(h.around).toHaveBeenCalledTimes(1);
  h.around.mockResolvedValueOnce([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'current source' }]);
  await act(async () => {
    if (outcome === 'resolve') finish([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'invalidated source' }]);
    else fail(new Error('invalidated read failed'));
  });
  expect(h.around).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('invalidated source')).toBeNull();
  expect(screen.getByText('current source')).toBeTruthy();
});

it.each(['hidden', 'unmount', 'owner', 'cached'])('drops or defers a queued source refresh after %s', async event => {
  h.snapshots.set('chat', { messages: [] });
  let finish!: (rows: unknown[]) => void;
  h.around.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await act(async () => render(<Host />));
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  expect(h.around).toHaveBeenCalledTimes(1);
  if (event === 'hidden') act(() => { h.hiddenListeners.forEach(fn => fn(true)); });
  else if (event === 'unmount') view.unmount();
  else if (event === 'owner') setDataOwnerGeneration('changed-owner');
  else act(() => {
    h.snapshots.set('chat', { messages: [{ clientId: 'old', role: 'assistant', content: 'cached source' }] });
    h.historyListeners.forEach(fn => fn());
  });
  await act(async () => { finish([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'stale source' }]); });
  expect(h.around).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('stale source')).toBeNull();
  if (event === 'hidden') {
    h.around.mockResolvedValueOnce([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'visible source' }]);
    await act(async () => { h.hiddenListeners.forEach(fn => fn(false)); });
    expect(h.around).toHaveBeenCalledTimes(2);
    expect(screen.getByText('visible source')).toBeTruthy();
  } else if (event === 'cached') expect(screen.getByText('cached source')).toBeTruthy();
});

it('does not make a new owner wait for the previous owner pending source read', async () => {
  h.snapshots.set('chat', { messages: [] });
  let finish!: (rows: unknown[]) => void;
  h.around.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await act(async () => render(<Host />));
  h.around.mockResolvedValueOnce([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'new owner source' }]);
  setDataOwnerGeneration('new-owner');
  await act(async () => { view.rerender(<Host />); });
  expect(h.around).toHaveBeenCalledTimes(2);
  expect(screen.getByText('new owner source')).toBeTruthy();
  await act(async () => { finish([{ sessionId: 'chat', clientId: 'old', role: 'assistant', content: 'old owner source' }]); });
  expect(screen.queryByText('old owner source')).toBeNull();
  expect(screen.getByText('new owner source')).toBeTruthy();
});

// §8.4: failure is unsynchronized; only the next visibility event retries it.
it.each(['native', 'document'])('recovers a failed source read on %s visibility without retrying a valid empty result', async signal => {
  h.snapshots.set('chat', { messages: [] });
  h.around.mockRejectedValueOnce(new Error('temporary IPC failure'));
  await act(async () => { render(<Host />); });
  expect(h.around).toHaveBeenCalledTimes(1);
  const visible = (value: boolean) => {
    if (signal === 'native') h.hiddenListeners.forEach(fn => fn(!value));
    else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'visible' : 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  };
  await act(async () => { visible(false); });
  expect(h.around).toHaveBeenCalledTimes(1);
  let finish!: (rows: unknown[]) => void;
  h.around.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { visible(true); visible(true); });
  expect(h.around).toHaveBeenCalledTimes(2);
  await act(async () => { visible(false); visible(true); });
  expect(h.around).toHaveBeenCalledTimes(2); // Still pending: no duplicate retry.
  await act(async () => { finish([{ sessionId: 'chat', clientId: 'old', role: 'user',
    content: { text: 'recovered source', files: [{ name: 'recovered.txt', path: '/fixture/recovered.txt' }] } }]); });
  expect(screen.getByText('recovered source')).toBeTruthy();
  expect(screen.getByText('recovered.txt')).toBeTruthy();
  await act(async () => { visible(false); visible(true); });
  expect(h.around).toHaveBeenCalledTimes(2); // Successful reads stay settled.
  await act(async () => { h.historyEpoch++; h.historyListeners.forEach(fn => fn()); });
  expect(h.around).toHaveBeenCalledTimes(3); // Default empty result: genuinely unavailable.
  expect(screen.queryByText('recovered source')).toBeNull();
  expect(screen.queryByText('recovered.txt')).toBeNull();
  await act(async () => { visible(false); visible(true); });
  expect(h.around).toHaveBeenCalledTimes(3);
});
