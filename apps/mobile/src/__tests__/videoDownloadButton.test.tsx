// @vitest-environment jsdom
// Tier 1: video export must hand a local copy to the OS, preserve its format,
// and never open a late share sheet after leaving the video/account.
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoDownloadButton } from '@/session/VideoDownloadButton';
const h = vi.hoisted(() => ({ download: vi.fn(), share: vi.fn(), alert: vi.fn(), generation: 0, focused: true }));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused }));
vi.mock('react-native', () => ({
  Pressable: ({ children, onPress, disabled }: any) => el('button', { onClick: onPress, disabled }, children),
  ActivityIndicator: () => el('span', null, 'busy'), Alert: { alert: h.alert },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: h.download }));
vi.mock('expo-sharing', () => ({ shareAsync: h.share }));
vi.mock('@/session/fileBrowserActions', () => ({ shareMimeForFileName: (name: string) => name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4' }));
vi.mock('@/session/filePreview', async () => ({ formatByteSize: (await import('@cindy/maker-shared/file-preview')).formatByteSize }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('lucide-react-native', () => ({ Download: () => null }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let container: HTMLDivElement;
function render(source: string | null = 'file:///clip.mov', active = true, mimeType?: string) {
  act(() => root.render(el(VideoDownloadButton, { source, active, mimeType })));
}
async function click() { await act(async () => container.querySelector('button')!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); root = createRoot(container);
  h.generation = 0; h.focused = true; h.download.mockReset().mockResolvedValue('file:///share/video.mov');
  h.share.mockReset().mockResolvedValue(undefined); h.alert.mockReset();
});
afterEach(() => act(() => root.unmount()));
it('exports a local copy with the video format and disables unresolved media', async () => {
  render(null); expect(container.querySelector('button')!.disabled).toBe(true);
  render(); await click();
  expect(h.download).toHaveBeenCalledWith('file:///clip.mov', 'video/quicktime', 'video.mov', expect.any(AbortSignal), expect.any(Function));
  expect(h.share).toHaveBeenCalledWith('file:///share/video.mov', { mimeType: 'video/quicktime' });
});
// Unit #8085: a data URL has no filename extension; retain its declared video
// MIME so the OS receives a playable MOV rather than a mislabeled MP4.
it('preserves the MIME and extension declared by a data-video source', async () => {
  render('data:video/quicktime;base64,AAAA'); await click();
  expect(h.download).toHaveBeenCalledWith('data:video/quicktime;base64,AAAA', 'video/quicktime', 'video.mov', expect.any(AbortSignal), expect.any(Function));
  expect(h.share).toHaveBeenCalledWith('file:///share/video.mov', { mimeType: 'video/quicktime' });
});
// Unit #8085 review r4429624618: the OS must not receive a streaming playlist
// mislabeled as a video file. Existing format tests only cover complete files.
// The smallest failing input is a playable HLS URL; DASH and MIME-only sources
// cover the other metadata paths to the same file-export boundary.
it.each([
  ['https://media.invalid/stream.M3U8?token=private', undefined],
  ['https://media.invalid/stream.mpd', undefined],
  ['https://media.invalid/playback', 'application/vnd.apple.mpegurl; charset=utf-8'],
])('does not share a streaming manifest as an MP4: %s', async (source, mimeType) => {
  render(source, true, mimeType); await click();
  expect(h.download).not.toHaveBeenCalled();
  expect(h.share).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledWith('files.preview.downloadFailed');
  render('https://media.invalid/clip.mp4'); await click();
  expect(h.share).toHaveBeenCalledOnce();
});
it.each(['hidden', 'source', 'account', 'blur', 'unmount'])('cancels %s exports and ignores late completion', async reason => {
  let finish!: (uri: string) => void;
  h.download.mockImplementation(() => new Promise(r => { finish = r; }));
  render(); await click(); await click();
  expect(h.download).toHaveBeenCalledOnce();
  const signal = h.download.mock.calls[0][3];
  if (reason === 'hidden') render(undefined, false);
  if (reason === 'source') render('file:///other.mp4');
  if (reason === 'account') { h.generation++; render(); }
  if (reason === 'blur') { h.focused = false; render(); }
  if (reason === 'unmount') act(() => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => finish('file:///late.mov'));
  expect(h.share).not.toHaveBeenCalled(); expect(h.alert).not.toHaveBeenCalled();
});
it('shows real transfer progress and allows retry after download failure', async () => {
  let finish!: (uri: null) => void;
  h.download.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  render('https://media.invalid/clip.mp4'); await click();
  act(() => h.download.mock.calls[0][4](50, 100));
  expect(container.textContent).toContain('50%');
  await act(async () => finish(null));
  expect(h.alert).toHaveBeenCalled(); expect(h.share).not.toHaveBeenCalled();
  await click(); expect(h.share).toHaveBeenCalledOnce();
});
