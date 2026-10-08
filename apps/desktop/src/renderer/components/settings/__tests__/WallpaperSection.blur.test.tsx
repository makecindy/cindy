// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let changed: (settings: AppearanceSettings) => void;
let saved: AppearanceSettings;
let setPatch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 100,
  } as DOMRect);
  vi.stubGlobal('electronAPI', {
    appearanceSettings: {
      getSync: () => saved,
      onChanged: (listener: typeof changed) => {
        changed = listener;
        return () => {};
      },
      setPatch: (setPatch = vi.fn(async (patch: Partial<AppearanceSettings>) => {
        saved = { ...saved, ...patch };
        changed(saved);
      })),
    },
  });
  saved = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-window', wallpaperBlur: 4 };
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function pointer(target: Element, type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}
function view(show = true) {
  return <WallpaperSettingsProvider>{show && <WallpaperSection />}</WallpaperSettingsProvider>;
}
const blur = () => document.documentElement.style.getPropertyValue('--app-wallpaper-blur');
const thumb = () => screen.getByRole('slider', { name: 'settings.appearance.wallpaper.blurLabel' });
const track = () => thumb().closest('.cindy-slider')!;

describe('wallpaper blur gesture persistence', () => {
  it('previews all intermediate values and saves only the released value', async () => {
    render(view());
    const slider = track();
    pointer(slider, 'pointerdown', 30);
    pointer(slider, 'pointermove', 60);
    pointer(slider, 'pointermove', 90);
    expect(blur()).toBe('18px');
    await act(async () => {});
    expect(setPatch).not.toHaveBeenCalled();
    pointer(slider, 'pointerup', 90);
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperBlur: 18 }));
    expect(blur()).toBe('18px');
  });
  it('persists keyboard changes without leaving a preview behind', async () => {
    render(view());
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' });
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperBlur: 5 }));
    await act(async () => {});
    act(() => changed({ ...saved, wallpaperBlur: 9 }));
    expect(blur()).toBe('9px');
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur'])(
    'cancels %s without writing and shows the latest saved value',
    async (cause) => {
      render(view());
      const slider = track();
      pointer(slider, 'pointerdown', 80);
      expect(blur()).toBe('16px');
      act(() => changed({ ...saved, wallpaperBlur: 9 }));
      expect(blur()).toBe('16px');
      if (cause === 'blur') fireEvent(window, new Event('blur'));
      else pointer(slider, cause, 80);
      await waitFor(() => expect(blur()).toBe('9px'));
      expect(setPatch).not.toHaveBeenCalled();
    },
  );
  it('discards an unfinished preview when leaving settings', async () => {
    const { rerender } = render(view());
    pointer(track(), 'pointerdown', 80);
    expect(blur()).toBe('16px');
    rerender(view(false));
    await waitFor(() => expect(blur()).toBe('4px'));
    expect(setPatch).not.toHaveBeenCalled();
  });
  it('clears the preview on reset instead of later restoring it', async () => {
    render(view());
    pointer(track(), 'pointerdown', 80);
    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }));
    await waitFor(() => expect(setPatch).toHaveBeenCalledTimes(1));
    expect(setPatch).toHaveBeenCalledWith(expect.objectContaining({ wallpaperBlur: null }));
    expect(blur()).toBe('');
    expect(thumb().getAttribute('aria-valuenow')).toBe('0');
  });
  it.each(['pointer', 'keyboard'])(
    'rolls back a failed %s save to the confirmed value',
    async (input) => {
      setPatch.mockRejectedValueOnce(new Error('save failed'));
      render(view());
      const slider = track();
      if (input === 'pointer') {
        pointer(slider, 'pointerdown', 80);
        pointer(slider, 'pointerup', 80);
      } else fireEvent.keyDown(thumb(), { key: 'End' });
      await waitFor(() =>
        expect(setPatch).toHaveBeenCalledExactlyOnceWith({
          wallpaperBlur: input === 'pointer' ? 16 : 20,
        }),
      );
      await waitFor(() => expect(blur()).toBe('4px'));
    },
  );
  it('does not save or keep a preview when dragging back to the starting value', async () => {
    render(view());
    const slider = track();
    pointer(slider, 'pointerdown', 80);
    pointer(slider, 'pointermove', 20);
    pointer(slider, 'pointerup', 20);
    await act(async () => {});
    expect(setPatch).not.toHaveBeenCalled();
    act(() => changed({ ...saved, wallpaperBlur: 9 }));
    expect(blur()).toBe('9px');
  });
});
