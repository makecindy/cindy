// @vitest-environment jsdom
// Tier 1: the production message player must expose inline transport controls,
// recover from a failed source patch, and stop when its message leaves view.
// Markdown renderer tests mock this component, so they cannot catch these bugs.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { ChatVideoView } from '../ChatVideoView';
import { VideoLightbox } from '../VideoLightbox';
import { registerMedia, __resetMediaBusForTests } from '@/lib/mediaPlaybackBus';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useRemoteMediaUrl', () => ({ useRemoteMediaUrl: (url: string) => url }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let visibility: IntersectionObserverCallback;
let observe: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.spyOn>;
const showModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
);
beforeEach(() => {
  observe = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback;
      }
      observe = observe;
      unobserve() {}
      disconnect() {}
    },
  );
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  __resetMediaBusForTests();
  vi.restoreAllMocks();
  if (showModalDescriptor)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(document, 'fullscreenElement');
  vi.unstubAllGlobals();
});
const props = {
  filename: 'Clip',
  variant: 'tool-output' as const,
  src: 'xdt-file://local/?path=%2Fclip.mp4',
};
// Tier 1 regression: a local video's body-portal menu was hidden behind native
// fullscreen. Existing inline/retry tests never opened a menu in fullscreen.
// Exercise both real players with one fullscreen video + a right-click, checking
// the menu's top-layer host, usable action, and exit/unmount cleanup.
it.each(['inline', 'lightbox'] as const)(
  '%s keeps its fullscreen context menu above the video',
  async (kind) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('electronAPI', undefined);
    const copy = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { copyMediaToClipboard: copy },
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // jsdom has dialog's hidden style but no native showModal implementation.
    const show = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: show,
    });
    const src = 'cindy-media://blobs/test.mp4';
    const view = render(
      kind === 'inline' ? (
        <ChatVideoView {...props} src={src} />
      ) : (
        <VideoLightbox src={src} onClose={vi.fn()} />
      ),
      { wrapper: Tooltip.Provider },
    );
    const video = document.querySelector('video')!;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: video,
      writable: true,
    });
    fireEvent.contextMenu(video, { clientX: 120, clientY: 100 });
    const menu = view.getByRole('menu');
    const host = document.querySelector('dialog[open]');
    expect(host?.contains(menu)).toBe(true);
    expect(show).toHaveBeenCalled();
    fireEvent.click(view.getByRole('menuitem', { name: 'chat.media.copyVideo' }));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith({ url: src }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.fullscreenElement).toBe(video);
    fireEvent.contextMenu(video);
    fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog')).toBeNull();
    fireEvent.contextMenu(video);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
    fireEvent.contextMenu(video);
    expect(view.getByRole('menu')).toBeTruthy();
    expect(document.querySelector('dialog')).toBeNull();
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: video });
    fireEvent.contextMenu(video);
    expect(document.querySelector('dialog')).not.toBeNull();
    view.unmount();
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
  },
);
it('provides inline browser transport controls without a click-to-lightbox wrapper', () => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  const video = view.container.querySelector('video')!;
  expect(video.controls).toBe(true);
  expect(video.playsInline).toBe(true);
  fireEvent.click(video);
  expect(view.container.querySelectorAll('video')).toHaveLength(1);
  expect(view.queryByRole('dialog')).toBeNull();
  expect(view.queryByRole('button', { name: 'Clip' })).toBeNull();
});
it('a patched source recovers from a previous decoding error', () => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  fireEvent.error(view.container.querySelector('video')!);
  expect(view.container.querySelector('video')).toBeNull();
  view.rerender(<ChatVideoView {...props} src="https://media.test/recovered.mp4" />);
  expect(view.container.querySelector('video')?.src).toBe('https://media.test/recovered.mp4');
});
it('retries a failed source when the network returns', () => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  fireEvent.error(view.container.querySelector('video')!);
  fireEvent(window, new Event('online'));
  expect(view.container.querySelector('video')?.src).toBe(props.src);
});
// Regression: Windows CSP/transport/decode errors were reported as a lost file.
// Existing source/network retry cases do not exercise the user's recovery action.
// Tier 1, minimum input: one media error followed by Retry on the real player.
it('reports a playback failure without claiming the file is missing and lets the user retry', () => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  fireEvent.error(view.container.querySelector('video')!);
  expect(view.getByText('chat.media.videoUnavailable')).toBeTruthy();
  expect(view.queryByText('chat.media.videoMissing')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'chat.errorBanner.retry' }));
  expect(view.container.querySelector('video')?.src).toBe(props.src);
});
// Regression: Seedance 2.5 1080p is HEVC-only; where Chromium cannot decode it the placeholder
// used to be a dead end (retry only) for a file the user already paid for.
// Tier 1, minimum input: one media error on a local cindy-media source.
it('offers reveal-in-folder on the failure placeholder for local media', async () => {
  const reveal = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electronAPI', { showItemInFolder: reveal });
  const src = 'cindy-media://blobs/hevc.mp4';
  const view = render(<ChatVideoView {...props} src={src} />, { wrapper: Tooltip.Provider });
  fireEvent.error(view.container.querySelector('video')!);
  fireEvent.click(view.getByRole('button', { name: 'chat.media.revealVideo' }));
  await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith({ url: src }));
});
it('does not offer reveal-in-folder for remote sources that failed', () => {
  const view = render(<ChatVideoView {...props} src="https://media.test/x.mp4" />, {
    wrapper: Tooltip.Provider,
  });
  fireEvent.error(view.container.querySelector('video')!);
  expect(view.queryByRole('button', { name: 'chat.media.revealVideo' })).toBeNull();
});
it('pauses video when its message leaves view', () => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  const video = view.container.querySelector('video')!;
  // Native fullscreen can make the original inline bounds leave the viewport.
  // Do not stop playback just because the message's observer reports it hidden.
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => video });
  visibility(
    [{ isIntersecting: false }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  expect(pause).not.toHaveBeenCalled();
  vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(null);
  visibility(
    [{ isIntersecting: false }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  expect(pause).toHaveBeenCalledOnce();
});
// Tier 1 regression (PR #7264): exiting fullscreen must pause an offscreen
// message even if its only hidden notification arrived during fullscreen.
// The previous test sent a second transition manually, hiding this gap. Model
// observe's fresh initial notification, including a now-visible inline player
// so stale fullscreen bounds cannot spuriously pause playback.
it.each([false, true])('rechecks visibility after fullscreen exits (visible: %s)', (visible) => {
  const view = render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  const video = view.container.querySelector('video')!;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => video,
  });
  fireEvent(document, new Event('fullscreenchange'));
  visibility(
    [{ isIntersecting: false }] as IntersectionObserverEntry[],
    {} as IntersectionObserver,
  );
  expect(pause).not.toHaveBeenCalled();
  // No new intersection transition occurs on exit. Only a fresh subscription
  // delivers the browser's initial visibility sample again.
  observe.mockImplementation(() => {
    visibility(
      [{ isIntersecting: visible }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  });
  vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(null);
  fireEvent(document, new Event('fullscreenchange'));
  expect(pause).toHaveBeenCalledTimes(visible ? 0 : 1);
});
// Tier 1: the old lightbox joined the real audio/video bus; inline playback must
// preserve that behavior, including the fresh element mounted after retry.
it('coordinates inline videos and audio through playback and retry', () => {
  const view = render(
    <>
      <ChatVideoView {...props} />
      <ChatVideoView {...props} filename="Second" />
    </>,
    { wrapper: Tooltip.Provider },
  );
  const [first, second] = view.container.querySelectorAll('video');
  Object.defineProperty(first, 'paused', { configurable: true, value: false });
  fireEvent.play(second);
  expect(pause.mock.contexts).toContain(first);
  const audio = document.createElement('audio');
  const unregister = registerMedia(audio);
  Object.defineProperty(audio, 'paused', { configurable: true, value: false });
  fireEvent.play(second);
  expect(pause.mock.contexts).toContain(audio);
  fireEvent.error(second);
  fireEvent(window, new Event('online'));
  const retried = view.container.querySelectorAll('video')[1];
  pause.mockClear();
  Object.defineProperty(retried, 'paused', { configurable: true, value: false });
  fireEvent.play(audio);
  expect(pause.mock.contexts).toContain(retried);
  expect(pause.mock.contexts).not.toContain(second);
  unregister();
});
