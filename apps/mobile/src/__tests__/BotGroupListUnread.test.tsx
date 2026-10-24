// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
vi.mock('react-native', async () => { const { createElement } = await import('react'); return { View: ({ children }: any) => createElement('div', null, children) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/session/BotGroupAvatars', () => ({ BotGroupDuoAvatar: () => null, useBotGroupIdentities: () => () => ({}) }));
vi.mock('@/session/messageMarkdown', () => ({ parseMobileMarkdownInlines: () => [], mobileMarkdownPreviewText: (value: string) => value }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => 'now' }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/session/CompanionListRow', async () => { const { createElement } = await import('react'); return {
  CompanionListRow: ({ unread, accessibilityLabel }: any) => createElement('button', { 'data-unread': String(unread), 'aria-label': accessibilityLabel }),
}; });
import { chatRoomRow, chatReadAt, chatReadSequence, type ChatSnapshot } from '@/chat/chatServerClient';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { BotGroupListRow } from '@/session/BotGroupList';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('reads a group row as unread until the last of two same-millisecond replies is read', async () => {
  const first = '9007199254740992', second = '9007199254740993';
  const snapshot: ChatSnapshot = { room: { id: 'group', name: 'Discussion', kind: 'group', archived: false, revision: 1,
    created_at: '2026-10-09', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' }, cursor: second,
    reads: [{ thread_key: 'main', read_seq: first }], members: [], messages: [first, second].map((seq, index) => ({
      id: `incoming-${index}`, seq, authorId: 'other', author: { kind: 'bot', name: 'Teammate' },
      createdAt: '2026-10-09T10:00:00.123Z', deleted: false, threadRootId: null, content: [{ type: 'text', text: 'hello' }],
    })) };
  const row = chatRoomRow(snapshot.room, snapshot, 'self');
  await markRemoteResourceRead('owner', '', 'group', chatReadAt(snapshot, 'self'), chatReadSequence(snapshot));
  const node = document.createElement('div'), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(BotGroupListRow, { row, online: true, onPress: () => {} })));
    expect(node.querySelector('[data-unread]')?.getAttribute('data-unread')).toBe('true');
    expect(node.querySelector('[data-unread]')?.getAttribute('aria-label')).toContain('devices.companions.unread');
    await act(async () => { await markRemoteResourceRead('owner', '', 'group', row.item.display.lastReplyAt!, second); });
    expect(node.querySelector('[data-unread]')?.getAttribute('data-unread')).toBe('false');
    expect(node.querySelector('[data-unread]')?.getAttribute('aria-label')).not.toContain('devices.companions.unread');
  } finally { act(() => root.unmount()); }
});
