// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ groups: [] as any[], sessions: [] as any[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
vi.mock('react-native', async () => { const { createElement } = await import('react'); return { View: ({ children }: any) => createElement('div', null, children) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/session/BotGroupAvatars', () => ({ BotGroupDuoAvatar: () => null, useBotGroupIdentities: () => () => ({}) }));
vi.mock('@/session/messageMarkdown', () => ({ parseMobileMarkdownInlines: () => [] }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => 'now' }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ items: [], groupTargets: [] }) }));
vi.mock('@/session/useBotGroupRoster', () => ({ useBotGroupRoster: () => ({ items: h.groups }) }));
vi.mock('@/session/remoteSessionStore', () => ({ RemoteSessionStoreSubscriptionGate: ({ children }: any) => children,
  useRemoteHomeSessions: () => h.sessions, useRemoteHomeStatusVersion: () => 0, remoteSessionStore: {} }));
vi.mock('@/components/MobilePrimitives', async () => { const { createElement } = await import('react'); return {
  MainWindowOptionButton: ({ testID, badge }: any) => createElement('button', { 'data-id': testID, 'data-badge': badge }),
}; });
vi.mock('@/session/CompanionListRow', async () => { const { createElement } = await import('react'); return {
  CompanionListRow: ({ unread, accessibilityLabel }: any) => createElement('button', { 'data-unread': String(unread), 'aria-label': accessibilityLabel }),
}; });
import { chatRoomRow, chatReadAt, chatReadSequence, type ChatSnapshot } from '@/chat/chatServerClient';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { BotGroupListRow } from '@/session/BotGroupList';
import { HomeUnreadProvider } from '@/session/HomeUnreadContext';
import { HomeModeSwitch } from '@/session/HomeModeSwitch';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('keeps the actual group row and home teammate badge in sync for same-millisecond replies', async () => {
  const first = '9007199254740992', second = '9007199254740993';
  const snapshot: ChatSnapshot = { room: { id: 'group', name: 'Discussion', kind: 'group', archived: false, revision: 1,
    created_at: '2026-10-09', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' }, cursor: second,
    reads: [{ thread_key: 'main', read_seq: first }], members: [], messages: [first, second].map((seq, index) => ({
      id: `incoming-${index}`, seq, authorId: 'other', author: { kind: 'bot', name: 'Teammate' },
      createdAt: '2026-10-09T10:00:00.123Z', deleted: false, threadRootId: null, content: [{ type: 'text', text: 'hello' }],
    })) };
  const row = chatRoomRow(snapshot.room, snapshot, 'self');
  h.groups = [row];
  await markRemoteResourceRead('owner', '', 'group', chatReadAt(snapshot, 'self'), chatReadSequence(snapshot));
  const node = document.createElement('div'), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(HomeUnreadProvider, { children: createElement(Fragment, null,
      createElement(HomeModeSwitch, { mode: 'tasks', onModeChange: () => {} }),
      createElement(BotGroupListRow, { row, online: true, onPress: () => {} })) })));
    expect(node.querySelector('[data-unread]')?.getAttribute('data-unread')).toBe('true');
    expect(node.querySelector('[data-unread]')?.getAttribute('aria-label')).toContain('devices.companions.unread');
    expect(node.querySelector('[data-id="home.mode.teammates"]')?.getAttribute('data-badge')).toBe('1');
    await act(async () => { await markRemoteResourceRead('owner', '', 'group', row.item.display.lastReplyAt!, second); });
    expect(node.querySelector('[data-unread]')?.getAttribute('data-unread')).toBe('false');
    expect(node.querySelector('[data-unread]')?.getAttribute('aria-label')).not.toContain('devices.companions.unread');
    expect(node.querySelector('[data-id="home.mode.teammates"]')?.hasAttribute('data-badge')).toBe(false);
  } finally { act(() => root.unmount()); }
});
