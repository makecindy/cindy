// @vitest-environment jsdom
// Tier 1: video covers keep a play mark and open the shared gallery.
// Exercise paused previews, resource leases and cancellation without inline playback.
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlineVideoPlayer } from '@/session/InlineVideoPlayer';
const h = vi.hoisted(() => ({ player: null as any, download: null as any }));
vi.mock('@/session/VideoDownloadButton', () => ({ VideoDownloadButton: (props: any) => { h.download = props; return null; } }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => el('div', null, children),
  Pressable: ({ children, onPress, disabled, testID }: any) => el('button', { onClick: onPress, disabled, 'data-testid': testID }, children),
  ActivityIndicator: () => el('span', null, 'loading'),
  StyleSheet: { absoluteFill: {} },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: (props: any) => { h.player = props; return el('video', { src: props.url, style: Object.assign({}, ...props.style) }); } }));
vi.mock('@/session/remoteMedia', () => ({ isDirectPreviewableMediaUrl: (url: string) => /^https:/.test(url) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('lucide-react-native', () => ({ Play: () => el('span', { 'data-testid': 'play-icon' }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let container: HTMLDivElement;
const url = 'cindy-media://blobs/clip.mp4';
const onOpen = vi.fn();
const result = { url: 'https://media.test/clip.mp4', mimeType: 'video/mp4', previewable: true, ossKey: '', size: 12, expiresAt: '9999-12-31' };
function render(resolve: any, visible = true, source = url, width = 300) {
  act(() => root.render(el(InlineVideoPlayer, { url: source, label: 'Clip', width, visible, resolve, onOpen })));
}
async function click() { await act(async () => container.querySelector('button')!.click()); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); root = createRoot(container); h.player = null; h.download = null; onOpen.mockClear(); });
afterEach(() => act(() => root.unmount()));

it('keeps a play affordance over the paused first frame and opens the gallery without inline download', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  await act(async () => render(resolve));
  expect(container.querySelector('video')?.src).toBe(result.url);
  expect(container.querySelector('[data-testid="play-icon"]')).not.toBeNull();
  expect(h.player).toMatchObject({ autoPlay: false, nativeControls: false });
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledOnce();
  expect(h.download).toBeNull();
});
it('prepares managed media only while visible and delegates arbitrary paths to the viewer', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  render(resolve, false);
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => render(resolve));
  expect(resolve).toHaveBeenCalledWith({ kind: 'video', url, previewable: false }, expect.objectContaining({ front: false }));
  render(resolve, false);
  expect(h.player.visible).toBe(false);
  act(() => root.render(null));
  render(resolve, true, 'xdt-file://open?path=%2Foutside%2Fclip.mp4');
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledOnce();
});
it('protects a resolved cover until its decoder fails or the row unmounts', async () => {
  const release = vi.fn();
  const protectLocalFile = vi.fn(() => release);
  const resolve = vi.fn().mockResolvedValue({ ...result, protectLocalFile });
  await act(async () => render(resolve));
  expect(protectLocalFile).toHaveBeenCalledOnce();
  render(resolve, false);
  expect(release).not.toHaveBeenCalled();
  act(() => h.player.onError('missing'));
  expect(release).toHaveBeenCalledOnce();
  act(() => root.render(null));
  await act(async () => render(resolve));
  act(() => root.render(null));
  expect(release).toHaveBeenCalledTimes(2);
});
it('fits native dimensions and bounds portrait covers without stretching', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  await act(async () => render(resolve, true, url, 800));
  act(() => h.player.onVideoSize({ width: 960, height: 720 }));
  expect(container.querySelector('video')?.style.width).toBe('480px');
  expect(container.querySelector('video')?.style.height).toBe('360px');
  render(resolve);
  act(() => h.player.onVideoSize({ width: 1080, height: 1920 }));
  expect(container.querySelector('video')?.style.height).toBe('400px');
  expect(container.querySelector('video')?.style.width).toBe('225px');
});
it('keeps the gallery reachable after preview failure without an automatic retry loop', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  await act(async () => render(resolve));
  act(() => h.player.onError('expired'));
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('[data-testid="play-icon"]')).not.toBeNull();
  await click();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledOnce();
});
it('opens the gallery while loading and cancels a hidden row without accepting late media', async () => {
  let finish!: (value: typeof result) => void;
  const resolve = vi.fn((_media: unknown, _options: { signal: AbortSignal }) => new Promise(r => { finish = r; }));
  render(resolve); await click();
  expect(onOpen).toHaveBeenCalledOnce();
  render(resolve, false);
  expect(resolve.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => finish(result));
  expect(container.querySelector('video')).toBeNull();
});
it('rejects a non-video response and previews direct video without remote file access', async () => {
  const resolve = vi.fn().mockResolvedValue({ ...result, mimeType: 'text/html', previewable: false });
  await act(async () => render(resolve));
  expect(container.querySelector('video')).toBeNull();
  await click(); expect(onOpen).toHaveBeenCalledOnce();
  act(() => root.render(null));
  render(resolve, true, result.url);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(container.querySelector('video')?.src).toBe(result.url);
  expect(h.player.autoPlay).toBe(false);
});
