// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWallpaperBackground } from '../useWallpaperBackground';

const initial = {
  background: 'url("first.webp")' as string | undefined,
  pending: false,
  visibility: 0.5,
  blur: 0,
  reducedMotion: false,
  decodeUrl: undefined as string | undefined,
};
const root = document.documentElement;
const image = () => root.style.getPropertyValue('--app-wallpaper-image');
const previousImage = () => root.style.getPropertyValue('--app-wallpaper-previous-image');

beforeEach(() => {
  vi.useFakeTimers();
  root.style.setProperty('--motion-fast', '150ms');
});
afterEach(() => {
  cleanup();
  root.style.removeProperty('--motion-fast');
  vi.useRealTimers();
});

// Regression: pending/failed selections must not expose their thumbnail and
// replace the old scene twice. Only the ready original starts the transition.
it('holds the displayed image through loading and starts a fade when the original is ready', () => {
  const { rerender } = renderHook(useWallpaperBackground, { initialProps: initial });
  rerender({ ...initial, background: 'url("thumbnail.webp")', pending: true });
  expect(image()).toBe(initial.background);
  expect(previousImage()).toBe('');
  act(() => vi.advanceTimersByTime(1000));
  expect(image()).toBe(initial.background);
  rerender({ ...initial, background: 'url("original.webp")' });
  expect(image()).toBe('url("original.webp")');
  expect(previousImage()).toBe(initial.background);
  expect(root.dataset.wallpaperTransition).toBe('true');
  act(() => vi.runAllTimers());
  expect(previousImage()).toBe('');
  expect(image()).toBe('url("original.webp")');
});

it('replaces a running transition without letting its earlier timer clear the next fade', () => {
  const { rerender } = renderHook(useWallpaperBackground, { initialProps: initial });
  rerender({ ...initial, background: 'url("second.webp")' });
  act(() => vi.advanceTimersByTime(125));
  rerender({ ...initial, background: 'url("third.webp")' });
  expect(previousImage()).toBe('url("second.webp")');
  act(() => vi.advanceTimersByTime(125));
  expect(root.dataset.wallpaperTransition).toBe('true');
  expect(image()).toBe('url("third.webp")');
  act(() => vi.runAllTimers());
  expect(previousImage()).toBe('');
});

it('waits for a custom replacement to decode and retains the old image on failure', async () => {
  const finishes = new Map<string, { resolve: () => void; reject: () => void }>();
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode = () =>
        new Promise<void>((resolve, reject) => {
          finishes.set(this.src, { resolve, reject });
        });
    },
  );
  const { rerender } = renderHook(useWallpaperBackground, { initialProps: initial });
  rerender({ ...initial, background: 'url("custom.webp")', decodeUrl: 'custom.webp' });
  expect(image()).toBe(initial.background);
  await act(async () => finishes.get('custom.webp')!.resolve());
  expect(image()).toBe('url("custom.webp")');
  expect(previousImage()).toBe(initial.background);
  rerender({ ...initial, background: 'url("broken.webp")', decodeUrl: 'broken.webp' });
  await act(async () => finishes.get('broken.webp')!.reject());
  expect(image()).toBe('url("custom.webp")');
  vi.unstubAllGlobals();
});

it('respects reduced motion and cancels transitions when hidden, disabled or unmounted', () => {
  const { rerender, unmount } = renderHook(useWallpaperBackground, { initialProps: initial });
  rerender({ ...initial, background: 'url("second.webp")', reducedMotion: true });
  expect(image()).toBe('url("second.webp")');
  expect(previousImage()).toBe('');
  rerender({ ...initial, background: 'url("third.webp")', blur: 8 });
  expect(previousImage()).toBe('url("second.webp")');
  rerender({ ...initial, background: 'url("third.webp")', visibility: 0 });
  expect(previousImage()).toBe('');
  expect(root.dataset.wallpaperBlur).toBeUndefined();
  rerender({ ...initial, background: undefined });
  expect(image()).toBe('');
  expect(root.dataset.wallpaperActive).toBeUndefined();
  rerender(initial);
  unmount();
  expect(image()).toBe('');
  expect(root.style.getPropertyValue('--app-wallpaper-veil')).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});
