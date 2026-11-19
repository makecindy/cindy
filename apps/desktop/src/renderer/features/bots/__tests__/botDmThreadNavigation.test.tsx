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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(), reload: vi.fn(), send: vi.fn(), around: vi.fn(),
  params: new URLSearchParams(), pending: null as URLSearchParams | null,
  listeners: new Set<() => void>(), profiles: [] as unknown[],
  snapshots: new Map<string, { messages: unknown[] }>(),
}));
const setParams = (update: (p: URLSearchParams) => URLSearchParams) => { h.pending = update(h.params); };
vi.mock('react-router-dom', () => ({ useSearchParams: () => [
  useSyncExternalStore((fn) => { h.listeners.add(fn); return () => { h.listeners.delete(fn); }; }, () => h.params),
  setParams,
] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {
  getSnapshot: (id: string) => h.snapshots.get(id), subscribe: () => () => {},
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
function commitUrl(params = h.pending) {
  if (!params) throw new Error('No pending navigation');
  act(() => { h.params = params; h.pending = null; h.listeners.forEach(fn => fn()); });
}
async function click(id: string) { await act(async () => { fireEvent.click(screen.getByText('open ' + id)); }); }
beforeEach(() => {
  setDataOwnerGeneration('test-owner');
  h.around.mockReset().mockResolvedValue([]);
  h.ensure.mockReset().mockImplementation(async ({ rootClientId }) => ({ ok: true, sessionId: rootClientId + '-topic', created: true }));
  h.send.mockReset(); h.reload.mockReset(); h.params = new URLSearchParams('thread=old-topic'); h.pending = null;
  h.profiles = [{ id: 'bot', sessions: ['old', 'new', 'third'].map(id => ({ id: id + '-topic', role: 'thread', status: 'active', threadRoot: { rootSessionId: 'chat', rootClientId: id } })) }];
  h.snapshots.set('chat', { messages: ['old', 'new', 'third'].map(id => ({ clientId: id, role: 'assistant', content: id + ' source' })) });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: { dmThread: { ensure: h.ensure } } } } });
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
  setDataOwnerGeneration('another-owner');
  view.rerender(<Host />);
  expect(screen.queryByText('previous owner source')).toBeNull();
});
