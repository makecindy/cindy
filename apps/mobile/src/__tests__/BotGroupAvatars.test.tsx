// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => {
  // React Native bundles preset PNG requires; replace only that native asset boundary.
  vi.stubGlobal('require', (path: string) => { if (path.endsWith('.png')) return 1; throw new Error('Unexpected native asset'); });
  return { remoteMedia: vi.fn<(media: unknown, deps: unknown, options: unknown) => Promise<{ url: string; previewable: boolean; mimeType: string }>>(async () => { throw new Error('Computer media only'); }), invoke: vi.fn(), avatars: new Map<string, string>(), store: false, failImage: null as null | (() => void),
    auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn() } };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return { View: ({ children, style }: any) => createElement('div', { style: Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) }, children),
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
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid', getActiveMobileSessionRealm: () => 'global' }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: (factory: any) => factory({}) }));
vi.mock('lucide-react-native', () => ({ Users: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/session/messageMarkdown', () => ({ parseMobileMarkdownInlines: () => [] }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/session/CompanionListRow', () => ({ CompanionListRow: ({ avatar }: any) => avatar }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/device-link/remoteResourceCache', () => ({ cachedBotItem: () => null, readRemoteResourceSnapshot: async () => ({}),
  remoteResourceCacheRevision: () => 0, subscribeRemoteResourceCache: () => () => {}, isRemoteResourceUnread: () => false }));
vi.mock('@/device-link/peerFileCache', () => ({ createPeerFileCache: async (owner: string) => ({
  lookupAvatar: async (id: string) => { const uri = h.avatars.get(owner + id); return uri ? { uri } : null; },
  storeAvatar: async (id: string, _uri: string, _mime: string, active: () => boolean) => { if (!h.store || !active()) return false; h.avatars.set(owner + id, 'file:///cached-avatar.png'); return true; },
}) }));
import { chatGroupView, chatRoomRow, type ChatSnapshot } from '@/chat/chatServerClient';
import { BotGroupAvatar, BotGroupDuoAvatar, useBotGroupIdentities } from '@/session/BotGroupAvatars';
import { ChatInviteAvatar } from '@/chat/ChatInviteAvatar';
import { BotGroupListRow } from '@/session/BotGroupList';
import { parseBotGroupChatData } from '@/session/botGroupRemote';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { h.avatars.clear(); h.store = false; h.auth.user.id = 'owner'; h.auth.accountGeneration = 1; h.remoteMedia.mockClear(); h.invoke.mockClear(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

// Product rule §5/§8.2: previous coverage only exercised single-member image sources.
// Render the real shared row/header mark: two members expose reversed occlusion;
// three expose truncation, four/five expose cluster geometry, six expose the cap (unit).
it.each(['row', 'header'] as const)('keeps the first members in front inside the %s mark as membership changes', async (variant) => {
  const host = document.createElement('div'); root = createRoot(host);
  const members = Array.from({ length: 6 }, (_, index) => ({ botId: String(index), name: `Member ${index}`, avatarUrl: `https://avatars.example.invalid/${index}.png` }));
  for (const count of [2, 3, 4, 5, 6, 1, 0]) {
    await act(async () => root!.render(createElement(BotGroupDuoAvatar, { deviceId: '', members: members.slice(0, count), online: true, variant })));
    const images = Array.from(host.querySelectorAll('img'));
    expect(images.map((img) => img.getAttribute('src'))).toEqual(members.slice(0, Math.min(count, 5)).reverse().map((member) => member.avatarUrl));
    if (count < 2) continue;
    const frame = host.firstElementChild as HTMLElement;
    const box = parseFloat(frame.style.width);
    const layers = images.map((img) => img.parentElement!);
    // Paint order only implies foreground when layers are siblings with no overriding z-index.
    expect(layers.every((layer) => layer.parentElement === frame && layer.style.position === 'absolute' && !layer.style.zIndex)).toBe(true);
    if (count === 2) continue;
    const centers = layers.map((layer) => {
      const size = parseFloat(layer.style.width);
      const left = parseFloat(layer.style.left), top = parseFloat(layer.style.top);
      expect(left).toBeGreaterThanOrEqual(0); expect(top).toBeGreaterThanOrEqual(0);
      expect(left + size).toBeLessThanOrEqual(box + 0.001); expect(top + size).toBeLessThanOrEqual(box + 0.001);
      return { x: left + size / 2 - box / 2, y: top + size / 2 - box / 2, size };
    });
    const distances = centers.map((point, index) => {
      const next = centers[(index + 1) % centers.length];
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(Math.hypot(centers[0].x, centers[0].y));
      const distance = Math.hypot(next.x - point.x, next.y - point.y);
      expect(distance).toBeLessThan(point.size); // neighboring circles actually overlap
      return distance;
    });
    distances.forEach((distance) => expect(distance).toBeCloseTo(distances[0]));
  }
});

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

// Regression: direct Chat Server rendering was covered, but the computer's
// group block lost avatarUrl during parsing (PR #6807). Exercise that boundary
// through the real identity hook and image component, including reset (unit).
it('renders the computer group avatar and its reset to the account avatar', async () => {
  let avatarUrl: string | null = 'https://avatars.example.invalid/group.png';
  const Probe = () => {
    const identityFor = useBotGroupIdentities('mac');
    const member = parseBotGroupChatData({ id: 'group', name: 'Group', messages: [], members: [
      { botId: 'person', name: 'Person', avatar: avatarUrl ? '' : '🙂', avatarUrl, status: 'active' },
    ] })!.members[0];
    return createElement(BotGroupAvatar, { deviceId: 'mac', identity: identityFor(member.botId, member.name, member), size: 28, online: true });
  };
  const host = document.createElement('div'); root = createRoot(host);
  for (const next of [avatarUrl, 'https://avatars.example.invalid/account.png', null]) {
    avatarUrl = next;
    await act(async () => root!.render(createElement(Probe)));
    if (next) expect(host.querySelector('img')?.getAttribute('src')).toBe(next);
    else { expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toBe('🙂'); }
  }
  expect(h.remoteMedia).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
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

// Cold/offline remount uses the same production avatar component as companion and
// group rows. Existing tests only covered live resolver rendering (unit).
it.each(['media', 'public'] as const)('restores a %s avatar before checking presence and isolates accounts', async (kind) => {
  h.store = true;
  h.remoteMedia.mockResolvedValue({ url: 'data:image/png;base64,fixture', previewable: true, mimeType: 'image/png' });
  const host = document.createElement('div'); root = createRoot(host);
  const identity = { botId: 'bot', name: 'Teammate', ...(kind === 'public' ? { avatarUrl: 'https://avatars.example.invalid/saved.png' }
    : { avatar: { kind: 'media', value: 'cindy-media://blobs/saved.png', fallbackText: 'T' } }) };
  await act(async () => root!.render(createElement(BotGroupAvatar, { deviceId: 'mac', identity, size: 28, online: true })));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('file:///cached-avatar.png');
  act(() => root!.unmount()); root = createRoot(host); h.remoteMedia.mockClear();
  await act(async () => root!.render(createElement(BotGroupAvatar, { deviceId: 'mac', identity, size: 28, online: false })));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('file:///cached-avatar.png');
  expect(h.remoteMedia).not.toHaveBeenCalled();
  h.store = false; h.auth.user.id = 'other'; h.auth.accountGeneration++;
  await act(async () => root!.render(createElement(BotGroupAvatar, { deviceId: 'mac', identity, size: 28, online: false })));
  expect(host.querySelector('img')?.getAttribute('src')).not.toBe('file:///cached-avatar.png');
});

// V9 unit regression: roster avatars had no 88pt preview contour or missing-image slot coverage.
// Render the production invitation identity; no fixture members enter App code.
it('centers all 1–5 preview contours without changing their membership or first-member foreground', async () => {
  const host = document.createElement('div'); root = createRoot(host);
  const members = Array.from({ length: 6 }, (_, i) => ({ avatar: `https://avatars.example.invalid/${i}.png`, initial: String(i) }));
  for (const count of [1, 2, 3, 4, 5, 6, 0]) {
    await act(async () => root!.render(createElement(ChatInviteAvatar, { members: members.slice(0, count) })));
    const images = Array.from(host.querySelectorAll('img'));
    expect(images.map(img => img.getAttribute('src'))).toEqual(members.slice(0, Math.min(count, 5)).reverse().map(member => member.avatar));
    if (count < 2) continue;
    const layers = images.map(img => img.parentElement!);
    const extent = (axis: 'left' | 'top') => {
      const starts = layers.map(layer => parseFloat(layer.style[axis]));
      const ends = layers.map((layer, i) => starts[i] + parseFloat(layer.style.width));
      return [Math.min(...starts), Math.max(...ends)];
    };
    for (const axis of ['left', 'top'] as const) {
      const [min, max] = extent(axis);
      expect((min + max) / 2).toBeCloseTo(44);
      expect(min).toBeGreaterThanOrEqual(-0.001); expect(max).toBeLessThanOrEqual(88.001);
    }
  }
  expect(h.remoteMedia).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
});
it('keeps a failed preview image in the same slot with its full Unicode initial', async () => {
  const host = document.createElement('div'); root = createRoot(host);
  await act(async () => root!.render(createElement(ChatInviteAvatar, { members: [{ avatar: 'https://avatars.example.invalid/failed.png', initial: '👩🏽‍💻' }, { avatar: null, initial: '林' }] })));
  const before = Array.from(host.firstElementChild!.children).map(node => (node as HTMLElement).style.cssText);
  act(() => h.failImage!());
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('👩🏽‍💻'); expect(host.textContent).toContain('林');
  expect(Array.from(host.firstElementChild!.children).map(node => (node as HTMLElement).style.cssText)).toEqual(before);
});
