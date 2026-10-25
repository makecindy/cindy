// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stub: (_name: string) => () => null,
  room: { status: 'ready', messages: [] as unknown[], before: null, loadingOlder: false, reload: vi.fn(), loadOlder: vi.fn(), media: vi.fn() },
  strips: [] as Array<{ messageId: string; align: string; names: string[]; resolve: unknown }>,
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const view = ({ children, testID, style }: any) => el('div', { 'data-testid': testID, 'data-style': JSON.stringify(style ?? null) }, children);
  return { View: view, ScrollView: view, ActivityIndicator: view, Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    StyleSheet: { create: (s: any) => s, hairlineWidth: 1 } };
});
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({}) }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('react-native')).View }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).View }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: h.stub('avatar') }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => ({ actors: [{ id: 'actor', name: 'Mia', avatar: null, homeDeviceId: 'mac' }], setHome: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/chat/useCloudCompanionRoom', () => ({ useCloudCompanionRoom: () => h.room }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ readDeviceList: vi.fn() }) }));
vi.mock('@/device-link/devices', () => ({ toDeviceListItems: () => [] }));
vi.mock('@/device-link/remoteResourceCache', () => ({ cachedBotItem: () => null }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => new Set() }));
vi.mock('@/theme', async () => {
  const colors = new Proxy({}, { get: () => '#777777' });
  return { useTheme: () => ({ colors }), useThemedStyles: (make: any) => make(colors) };
});
vi.mock('@/theme/userBubblePreference', () => ({ useUserBubbleAppearance: () => ({ colors: null }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ width: 402 }) }));
vi.mock('@/session/BotGroupAvatars', () => ({ BOT_GROUP_MESSAGE_AVATAR_SIZE: 28 }));
vi.mock('@/session/BotGroupMessageText', async () => {
  const { createElement: el } = await import('react');
  return { BotGroupUserText: ({ content }: any) => el('p', { 'data-kind': 'user-text' }, content),
    BotGroupMarkdownText: ({ content }: any) => el('p', { 'data-kind': 'reply-text' }, content) };
});
vi.mock('@/session/MessageRenderer', () => ({ MarkdownBody: h.stub('markdown') }));
vi.mock('@/session/messageContentLayout', () => ({ buildMessageContentLayout: () => ({}) }));
vi.mock('@/session/ChatIdentityHeader', () => ({ CHAT_HEADER_MARK_SIZE: 32, ChatIdentityHeader: h.stub('header'), ChatIdentitySubtitle: h.stub('subtitle') }));
vi.mock('@/session/CompanionCardButton', () => ({ CompanionCardActions: h.stub('actions'), CompanionCardButton: h.stub('button') }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: h.stub('row') }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: h.stub('sheet') }));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ openTeammate: vi.fn() }) }));
vi.mock('@/session/useTeammateRoster', () => ({ TEAMMATE_COLLECTION_ID: 'teammates', useTeammateRoster: () => ({ items: [], refresh: vi.fn(), isOnline: () => false }) }));
vi.mock('@/session/BotGroupMessageAttachments', async () => {
  const { createElement: el } = await import('react');
  return { BotGroupMessageAttachments: (props: any) => {
    h.strips.push({ messageId: props.messageId, align: props.align, names: props.attachments.map((a: any) => a.name), resolve: props.resolveServerMedia });
    return el('div', { 'data-kind': 'strip', 'data-message': props.messageId });
  } };
});
import { CloudCompanionScreen } from '@/session/CloudCompanionScreen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (n: number, authorId: string, content: unknown[]) => ({ id: id(n), seq: String(n), authorId, author: { kind: 'x', name: '' },
  createdAt: `2026-10-13T00:00:0${n}Z`, deleted: false, threadRootId: null, content });
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  h.strips.length = 0; h.room.status = 'ready';
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
const render = () => act(async () => root.render(createElement(CloudCompanionScreen, { actorId: id(1), botId: 'mia', deviceId: 'mac', deviceName: 'Mac', title: 'Mia' })));

// Tier: behavior. The offline cloud conversation drew only message.text, so an owner's file or a
// companion's deliverable (media blocks of the room message) never appeared; an attachment-only message vanished.
it('shows the owner\'s and the companion\'s attachments under their messages, including messages without text', async () => {
  h.room.messages = [
    message(2, id(9), [{ type: 'text', text: 'please summarise' }, { type: 'media', mediaId: id(20), caption: 'notes.pdf' }]),
    message(3, id(1), [{ type: 'text', text: 'done' }, { type: 'media', mediaId: id(21), caption: 'chart.png' }, { type: 'media', mediaId: id(22), caption: 'report.docx' }]),
    message(4, id(1), [{ type: 'media', mediaId: id(23), caption: 'extra.zip' }]),
    message(5, id(9), [{ type: 'media', mediaId: id(24), caption: 'photo.jpg' }]),
    message(6, id(1), [{ type: 'text', text: 'plain' }]),
  ];
  await render();
  expect(h.strips.map(({ messageId, align, names }) => ({ messageId, align, names }))).toEqual([
    { messageId: id(2), align: 'right', names: ['notes.pdf'] },
    { messageId: id(3), align: 'left', names: ['chart.png', 'report.docx'] },
    { messageId: id(4), align: 'left', names: ['extra.zip'] },
    { messageId: id(5), align: 'right', names: ['photo.jpg'] },
  ]);
  // Each strip fetches its addresses from the room hook.
  expect(h.strips.every(strip => strip.resolve === h.room.media)).toBe(true);
  expect(container.querySelectorAll('[data-testid="cloudCompanion.message.user"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-testid="cloudCompanion.message.companion"]')).toHaveLength(3);
  // Captions are the attachments' names, not text repeated beside them; an attachment-only message has no empty bubble.
  expect([...container.querySelectorAll('p')].map(node => node.textContent)).toEqual(['please summarise', 'done', 'plain']);
});

// Tier: behavior. The owner's bubble sat in a content-sized column capped at 86%; the bubble itself had no cap,
// so long text was laid out wider than the cap and clipped. The cap must live on the bubble, inside a full-width column.
it('caps the owner\'s bubble at 86% of a full-width column so long text wraps', async () => {
  h.room.messages = [message(2, id(9), [{ type: 'text', text: 'a long message '.repeat(20) }])];
  await render();
  const column = container.querySelector('[data-testid="cloudCompanion.message.user"] > div') as HTMLElement;
  const bubble = column.firstElementChild as HTMLElement;
  const style = (node: HTMLElement) => [JSON.parse(node.dataset.style!)].flat(2).reduce((all, part) => ({ ...all, ...(part || {}) }), {} as Record<string, unknown>);
  expect(style(bubble).maxWidth).toBe('86%');
  expect(style(column).maxWidth).toBeUndefined();
  expect(style(column).alignItems).toBe('flex-end');
});
