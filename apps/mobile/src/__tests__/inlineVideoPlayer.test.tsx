// @vitest-environment jsdom
// Tier 1: message video previously opened a viewer instead of an inline player.
// Unlike NativeVideoPlayer tests, this exercises click-to-resolve, cancellation
// and retry through the production message adapter, without fetching on mount.
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlineVideoPlayer } from '@/session/InlineVideoPlayer';
const h = vi.hoisted(() => ({ player: null as any }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => el('div', null, children),
  Pressable: ({ children, onPress, disabled, testID }: any) => el('button', { onClick: onPress, disabled, 'data-testid': testID }, children),
  ActivityIndicator: () => el('span', null, 'loading'),
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: (props: any) => { h.player = props; return el('video', { src: props.url, style: Object.assign({}, ...props.style) }); } }));
vi.mock('@/session/remoteMedia', () => ({ isDirectPreviewableMediaUrl: (url: string) => /^https:/.test(url) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('lucide-react-native', () => ({ Play: () => null }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let container: HTMLDivElement;
const url = 'xdt-file://open?path=%2Foutside%2Fclip.mp4';
const result = { url: 'https://media.test/clip.mp4', mimeType: 'video/mp4', previewable: true, ossKey: '', size: 12, expiresAt: '9999-12-31' };
function render(resolve: any, visible = true, source = url) {
  act(() => root.render(el(InlineVideoPlayer, { url: source, label: 'Clip', width: 300, visible, resolve })));
}
async function click() { await act(async () => container.querySelector('button')!.click()); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); root = createRoot(container); h.player = null; });
afterEach(() => act(() => root.unmount()));

it('fetches only on play and mounts the resolved video in the message with native autoplay', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  render(resolve);
  expect(resolve).not.toHaveBeenCalled();
  await click();
  expect(resolve).toHaveBeenCalledWith({ kind: 'video', url, previewable: false }, expect.objectContaining({ front: true }));
  expect(container.querySelector('video')?.src).toBe(result.url);
  expect(h.player.autoPlay).toBe(true);
  render(resolve, false);
  expect(h.player.visible).toBe(false);
});
// Tier 1: pressure cleanup must not delete a mounted native player's source;
// the lease ends on failure or unmount, including after a successful retry.
it('protects the resolved file until playback fails or the row unmounts', async () => {
  const release = vi.fn();
  const protectLocalFile = vi.fn(() => release);
  const resolve = vi.fn().mockResolvedValue({ ...result, protectLocalFile });
  render(resolve); await click();
  expect(protectLocalFile).toHaveBeenCalledOnce();
  render(resolve, false);
  expect(release).not.toHaveBeenCalled(); // hidden player stays mounted and can resume
  act(() => h.player.onError('missing'));
  expect(release).toHaveBeenCalledOnce();
  render(resolve); await click();
  act(() => root.render(null));
  expect(protectLocalFile).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
});
// Unit regression: the original 1146×848 recording was boxed into 16:9 with
// heavy black bars. Native-size changes must fit the picture without cropping;
// portrait clips must stay bounded. Earlier adapter tests did not cover sizing.
it('fits native video dimensions and bounds portrait height without stretching', async () => {
  render(vi.fn().mockResolvedValue(result)); await click();
  act(() => h.player.onVideoSize({ width: 1146, height: 848 }));
  const video = container.querySelector('video')!;
  expect(parseFloat(video.style.width)).toBeCloseTo(300);
  expect(parseFloat(video.style.height)).toBeCloseTo(300 * 848 / 1146);
  act(() => h.player.onVideoSize({ width: 1080, height: 1920 }));
  expect(parseFloat(video.style.height)).toBe(400);
  expect(parseFloat(video.style.width)).toBe(225);
});
it('retries failed playback through the resolver with a fresh source', async () => {
  const resolve = vi.fn().mockResolvedValue(result);
  render(resolve); await click();
  act(() => h.player.onError('expired'));
  expect(container.querySelector('video')).toBeNull();
  expect(container.textContent).toContain('message.renderer.retryPreview');
  await click();
  expect(resolve.mock.calls[1][1].forceRefresh).toBe(true);
  expect(container.querySelector('video')).not.toBeNull();
});
it('cancels a hidden row and ignores its late resolved file', async () => {
  let finish!: (value: typeof result) => void;
  const resolve = vi.fn((_media: unknown, _options: { signal: AbortSignal }) => new Promise(r => { finish = r; }));
  render(resolve); await click();
  render(resolve, false);
  expect(resolve.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => finish(result));
  expect(container.querySelector('video')).toBeNull();
});
it('rejects a non-video response and plays direct video without remote file access', async () => {
  const resolve = vi.fn().mockResolvedValue({ ...result, mimeType: 'text/html', previewable: false });
  render(resolve); await click();
  expect(container.querySelector('video')).toBeNull();
  expect(container.textContent).toContain('message.renderer.retryPreview');
  act(() => root.render(null));
  render(resolve, true, result.url); await click();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(container.querySelector('video')?.src).toBe(result.url);
});
