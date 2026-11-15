// @vitest-environment jsdom
// Mount the real bridge: service failures must preserve independent results and
// later batches. Pure identity tests do not execute the service queries.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationReconciliationBridge } from '../notifications/NotificationReconciliationBridge';
const state = vi.hoisted(() => ({ failure: '', retire: vi.fn(), tasks: vi.fn(), me: vi.fn(), chat: vi.fn(), notices: [] as unknown[] }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
const auth = { initialized: true, isAuthenticated: true, accountGeneration: 1, user: { id: 'account' },
  apiFetch: (...args: unknown[]) => state.tasks(...args) };
const chat = { current: () => true, realm: 'global', client: { me: () => state.me() }, request: (...args: unknown[]) => state.chat(...args) };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => chat }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelay: () => null }));
vi.mock('@/config/env', () => ({ getMobileEndpointForRealm: () => {
  if (state.failure === 'task-endpoint') throw Error('endpoint unavailable');
  return 'https://relay.example.invalid';
} }));
vi.mock('../../modules/cindy-notification-state', () => ({ default: { retire: (...args: unknown[]) => state.retire(...args) } }));
vi.mock('@/notifications/pushNotifications', () => ({ isPushSupported: () => true }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: {
  getPresentedNotificationsAsync: async () => state.notices, addNotificationReceivedListener: () => ({ remove() {} }),
} }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});
it.each(['chat-me', 'chat-query', 'task-endpoint', 'task-query'])('isolates %s failures across mixed and later batches', async failure => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.failure = failure;
  const taskIds = Array.from({ length: 51 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const chatId = '11111111-1111-4111-8111-111111111111';
  const notice = (id: string, recipientId: string, category: string) => ({ request: { identifier: id,
    content: { data: { notificationId: id, recipientId, category } } } });
  state.notices = [notice(chatId, 'actor', 'chat-message'), ...taskIds.map(id => notice(id, 'account', 'session-done'))];
  state.me.mockImplementation(async () => { if (failure === 'chat-me') throw Error('chat offline'); return 'actor'; });
  state.chat.mockImplementation(async () => { if (failure === 'chat-query') throw Error('chat offline'); return { recipientId: 'actor', ids: [chatId] }; });
  state.tasks.mockImplementation(async (_path, options) => { if (failure === 'task-query') throw Error('tasks offline'); return { ids: options.body.ids }; });
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(NotificationReconciliationBridge)));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const retired = state.retire.mock.calls.flatMap(([recipient, ids]) => (ids as string[]).map(id => `${recipient}:${id}`));
  expect(retired).toEqual(failure.startsWith('chat') ? taskIds.map(id => `account:${id}`) : [`actor:${chatId}`]);
  if (failure.startsWith('chat')) expect(state.tasks).toHaveBeenCalledTimes(2);
});
