// @vitest-environment jsdom
// Tier 1: the production message player must expose inline transport controls,
// recover from a failed source patch, and stop when its message leaves view.
// Markdown renderer tests mock this component, so they cannot catch these bugs.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { ChatVideoView } from '../ChatVideoView';
import { registerMedia, __resetMediaBusForTests } from '@/lib/mediaPlaybackBus';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useRemoteMediaUrl', () => ({ useRemoteMediaUrl: (url: string) => url }));
let visibility: IntersectionObserverCallback;
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { visibility = callback; }
    observe() {} disconnect() {}
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); __resetMediaBusForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const props = { filename: 'Clip', variant: 'tool-output' as const, src: 'xdt-file://local/?path=%2Fclip.mp4' };
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
it('pauses video when its message leaves view', () => {
  render(<ChatVideoView {...props} />, { wrapper: Tooltip.Provider });
  visibility([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(pause).toHaveBeenCalledOnce();
});
// Tier 1: the old lightbox joined the real audio/video bus; inline playback must
// preserve that behavior, including the fresh element mounted after retry.
it('coordinates inline videos and audio through playback and retry', () => {
  const view = render(<><ChatVideoView {...props} /><ChatVideoView {...props} filename="Second" /></>, { wrapper: Tooltip.Provider });
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
