// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => {
  // React Native bundles preset PNG requires; replace only that native asset boundary.
  vi.stubGlobal('require', (path: string) => { if (path.endsWith('.png')) return 1; throw new Error('Unexpected native asset'); });
  return { remoteMedia: vi.fn<(media: unknown, deps: unknown, options: unknown) => Promise<{ url: string; previewable: boolean; mimeType: string }>>(async () => { throw new Error('Computer media only'); }), invoke: vi.fn(), failImage: null as null | (() => void),
    auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn() } };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return { View: ({ children }: any) => createElement('div', null, children),
    Image: ({ source, onError }: any) => { h.failImage = onError; return createElement('img', { src: source.uri, 'data-asset': typeof source === 'string' ? source : undefined }); },
    StyleSheet: { create: (value: any) => value } };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: ({ children }: any) => createElement('span', null, children) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('@/device-link/mobileMakerTransport', () => ({ createMobileMakerTransport: () => ({ fetchRemoteMedia: vi.fn() }) }));
vi.mock('@/session/remoteMedia', () => ({ resolveMobileRemoteMedia: h.remoteMedia }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid' }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('lucide-react-native', () => ({ Users: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/session/messageMarkdown', () => ({ parseMobileMarkdownInlines: () => [] }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/session/CompanionListRow', () => ({ CompanionListRow: ({ avatar }: any) => avatar }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/device-link/remoteResourceCache', () => ({ cachedBotItem: () => null, readRemoteResourceSnapshot: async () => ({}),
  remoteResourceCacheRevision: () => 0, subscribeRemoteResourceCache: () => () => {}, isRemoteResourceUnread: () => false }));
import { chatGroupView, chatRoomRow, type ChatSnapshot } from '@/chat/chatServerClient';
import { BotGroupAvatar, useBotGroupIdentities } from '@/session/BotGroupAvatars';
import { BotGroupListRow } from '@/session/BotGroupList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { h.remoteMedia.mockClear(); h.invoke.mockClear(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

it('renders a server member public avatar without computer resolution and recovers after a changed image', async () => {
  const snapshot: ChatSnapshot = { room: { id: 'group', name: 'Discussion', kind: 'group', archived: false, revision: 1,
    created_at: '', updated_at: '', response_mode: 'all', speaking_mode: 'auto' }, cursor: '1', messages: [], members: [
    { id: 'bot', kind: 'bot', name: 'Teammate', state: 'joined', ownerActorId: 'owner', ownerName: '', avatar: 'https://avatars.example.invalid/bot.png', role: 'member' },
  ] };
  const Probe = () => {
    const identityFor = useBotGroupIdentities('');
    const member = chatGroupView({ snapshot, messages: [], before: null }, 'owner').members[0];
    return createElement(BotGroupAvatar, { deviceId: '', identity: identityFor(member.botId, member.name, member), size: 28, online: true });
  };
  const host = document.createElement('div'); root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
  expect(host.querySelector('img')?.getAttribute('src')).toBe(snapshot.members[0].avatar);
  expect(h.remoteMedia).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
  act(() => h.failImage!());
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toBe('T');
  snapshot.members[0].avatar = 'https://avatars.example.invalid/replaced.png';
  await act(async () => root!.render(createElement(Probe)));
  expect(host.querySelector('img')?.getAttribute('src')).toBe(snapshot.members[0].avatar);
});

it('keeps computer local media avatars on the existing resolver', async () => {
  h.remoteMedia.mockResolvedValueOnce({ url: 'https://media.example.invalid/thumbnail.png', previewable: true, mimeType: 'image/png' });
  const host = document.createElement('div'); root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupAvatar, {
    deviceId: 'mac', identity: { botId: 'bot', name: 'Teammate', avatar: { kind: 'media', value: 'cindy-media://avatar/a.png', fallbackText: 'T' } }, size: 28, online: true,
  })));
  expect(h.remoteMedia).toHaveBeenCalledExactlyOnceWith({ kind: 'image', url: 'cindy-media://avatar/a.png' }, expect.anything(), { thumbnail: true });
  expect(host.querySelector('img')?.getAttribute('src')).toBe('https://media.example.invalid/thumbnail.png');
});

it.each(['https://avatars.example.invalid/bot.png', 'cindy://avatar/preset/cindy', '🦊'])('preserves %s in the actual direct group roster avatar', async (avatar) => {
  const snapshot: ChatSnapshot = { room: { id: 'group', name: 'Discussion', kind: 'group', archived: false, revision: 1,
    created_at: '', updated_at: '', response_mode: 'all', speaking_mode: 'auto' }, cursor: '1', messages: [], members: [
    { id: 'bot', kind: 'bot', name: 'Teammate', state: 'joined', ownerActorId: 'owner', ownerName: '', avatar, role: 'member' },
    { id: 'left', kind: 'bot', name: 'Former', state: 'left', ownerActorId: 'owner', ownerName: '', avatar: 'https://avatars.example.invalid/left.png', role: 'member' },
  ] };
  const host = document.createElement('div'); root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupListRow, {
    row: chatRoomRow(snapshot.room, snapshot, 'owner'), online: true, onPress: () => {},
  })));
  if (avatar.startsWith('https:')) expect(host.querySelector('img')?.getAttribute('src')).toBe(avatar);
  // The Vitest native-asset transform exposes the bundled file path instead of Metro's numeric asset ID.
  else if (avatar.startsWith('cindy:')) expect(host.querySelector('img')?.getAttribute('data-asset')).toMatch(/[\\/]bot-presets[\\/]cindy\.png$/);
  else { expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toBe(avatar); }
  expect(h.remoteMedia).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
  expect(host.querySelectorAll('img').length).toBe(avatar === '🦊' ? 0 : 1);
});
