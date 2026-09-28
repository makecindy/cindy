// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ sessions: [] as any[], private: [] as any[], groups: [] as any[], unread: new Set<string>() }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ items: h.private, groupTargets: [] }) }));
vi.mock('@/session/useBotGroupRoster', () => ({ useBotGroupRoster: () => ({ items: h.groups }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ subscribeRemoteResourceCache: () => () => {}, remoteResourceCacheRevision: () => 0,
  isRemoteResourceUnread: (_owner: string, _host: string, id: string) => h.unread.has(id) }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  subscribe: () => () => {}, getSessions: () => h.sessions,
  getSessionLiveActivity: (id: string) => h.sessions.find(row => row.id === id)?.activity,
  getPendingInteractions: () => [], isSessionRunning: () => false,
} }));
import { HomeUnreadProvider, useHomeUnreadCounts, usePublishHomeScheduleUnread } from '@/session/HomeUnreadContext';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div'); let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); });
let publishSchedules: (ids: ReadonlySet<string>) => void;
function Counts() { publishSchedules = usePublishHomeScheduleUnread(); const counts = useHomeUnreadCounts(); return `${counts.tasks}/${counts.teammates}`; }
it('maps ordinary task attention and unread private/group chats into mutually exclusive destinations', () => {
  h.sessions = ['desktop', 'bot', 'scheduler', 'learn'].map((source, i) => ({ id: `${i}`, source, status: 'active', activity: { phase: 'completed', attention: true } }));
  h.sessions.push({ id: 'archived', status: 'archived', activity: { phase: 'error', attention: true } },
    { id: 'worker', status: 'active', orcaRole: 'worker', activity: { phase: 'completed', attention: true } },
    { id: 'running', status: 'active', activity: { phase: 'running' } });
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
  h.sessions = []; h.private = []; h.groups = []; render(); expect(container.textContent).toBe('0/0');
});
