// @vitest-environment jsdom
import { act, createElement, memo, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteSessionStoreSubscriptionGate, remoteSessionStore, useRemoteSessionMessagePreview } from '@/session/remoteSessionStore';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import type { RemoteSession } from '@/session/types';
const h = vi.hoisted(() => ({ focused: true, private: [] as any[], groups: [] as any[], unread: new Set<string>() }));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ items: h.private, groupTargets: [] }) }));
vi.mock('@/session/useBotGroupRoster', () => ({ useBotGroupRoster: () => ({ items: h.groups }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ subscribeRemoteResourceCache: () => () => {}, remoteResourceCacheRevision: () => 0,
  isRemoteResourceUnread: (_owner: string, _host: string, id: string) => h.unread.has(id) }));
import { HomeUnreadProvider, useHomeUnreadCounts, usePublishHomeScheduleUnread } from '@/session/HomeUnreadContext';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div'); let root: ReturnType<typeof createRoot>;
beforeEach(() => { remoteSessionStore.clear(); h.focused = true; h.private = []; h.groups = []; h.unread.clear(); });
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); remoteSessionStore.clear(); });
function seed(rows: Array<Partial<RemoteSession> & { id: string }>) {
  remoteSessionStore.setDeviceSessions('mac', 'Mac', rows.map(row => ({
    userId: 'owner', title: row.id, status: 'active', workingDir: null, workspaceKind: 'dialogue', model: 'model',
    agentKind: 'codex', effort: '', permissionMode: 'default', fastMode: false,
    userSendAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...row,
  })));
}
function activity(id: string, phase = 'completed') {
  remoteSessionStore.applyRemotePush('mac', SESSION_ACTIVITY_CHANNEL, { sessionId: id, phase, attention: true });
}
let publishSchedules: (ids: ReadonlySet<string>) => void;
function Counts() { publishSchedules = usePublishHomeScheduleUnread(); const counts = useHomeUnreadCounts(); return `${counts.tasks}/${counts.teammates}`; }
it('maps ordinary task attention and unread private/group chats into mutually exclusive destinations', () => {
  seed([...['desktop', 'bot', 'scheduler', 'learn'].map((source, i) => ({ id: `${i}`, source })),
    { id: 'archived', status: 'archived' }, { id: 'worker', orcaRole: 'worker' }, { id: 'running' }]);
  for (const id of ['0', '1', '2', '3', 'worker']) activity(id);
  activity('archived', 'error'); activity('running', 'running');
  const row = (id: string) => ({ host: { deviceId: 'mac' }, item: { ref: { id }, display: { lastReplyAt: 20 } } });
  h.private = [row('p1'), row('p2')]; h.groups = [row('g1')]; h.unread = new Set(['p1', 'g1']);
  root = createRoot(container);
  const render = () => act(() => root.render(createElement(HomeUnreadProvider, { children: createElement(Counts) })));
  render(); expect(container.textContent).toBe('1/2');
  act(() => publishSchedules(new Set(['0']))); expect(container.textContent).toBe('0/2');
  act(() => publishSchedules(new Set()));
  // Rendering/entering a section cannot acknowledge any rows.
  render(); expect(container.textContent).toBe('1/2');
  h.unread.delete('g1'); render(); expect(container.textContent).toBe('1/1');
  act(() => remoteSessionStore.clear()); h.private = []; h.groups = []; render(); expect(container.textContent).toBe('0/0');
});

it('does no task scans for message/usage pushes or while covered, then catches up on focus', () => {
  seed(Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` })));
  root = createRoot(container);
  const render = () => act(() => root.render(createElement(HomeUnreadProvider, { children: createElement(Counts) })));
  render();
  const readActivity = vi.spyOn(remoteSessionStore, 'getSessionLiveActivity');
  act(() => {
    for (let i = 0; i < 100; i++) {
      remoteSessionStore.setMessages('s0', [{ id: 'm', clientId: 'm', sessionId: 's0', role: 'assistant',
        content: `token ${i}`, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z' }]);
      remoteSessionStore.applySessionPatch('mac', 's0', { totalTokenUsage: i });
    }
  });
  expect(readActivity).not.toHaveBeenCalled();
  h.focused = false; render(); readActivity.mockClear();
  act(() => { activity('s10'); remoteSessionStore.applySessionPatch('mac', 's20', { title: 'renamed' }); });
  expect(readActivity).not.toHaveBeenCalled();
  expect(container.textContent).toBe('0/0');
  h.focused = true; render();
  expect(container.textContent).toBe('1/0');
  expect(readActivity).toHaveBeenCalled();
});

it('covers 1,000 memoized rows without rendering them, then updates only changed previews on return', () => {
  seed(Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` })));
  const renders = new Map<string, number>();
  const Row = memo(function Row({ id }: { id: string }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return <span>{useRemoteSessionMessagePreview(id)}</span>;
  });
  root = createRoot(container);
  const render = (enabled: boolean, count = 1000) => act(() => root.render(
    <StrictMode><RemoteSessionStoreSubscriptionGate enabled={enabled}>
      {Array.from({ length: count }, (_, i) => <Row key={i} id={`s${i}`} />)}
    </RemoteSessionStoreSubscriptionGate></StrictMode>,
  ));
  render(true); renders.clear();
  render(false);
  expect(renders.size).toBe(0);
  act(() => remoteSessionStore.setMessages('s10', [{ id: 'm', clientId: 'm', sessionId: 's10', role: 'assistant',
    content: 'Updated while covered', toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z' }]));
  expect(renders.size).toBe(0);
  expect(container.textContent).not.toContain('Updated while covered');
  render(true);
  expect([...renders.keys()]).toEqual(['s10']);
  expect(container.textContent).toContain('Updated while covered');
  renders.clear(); render(false); render(true);
  expect(renders.size).toBe(0);
  // Removed subscribers must not be reattached by a later resume.
  render(false); render(false, 0); render(true, 0);
  act(() => remoteSessionStore.setMessages('s10', []));
  expect(renders.size).toBe(0);
});
