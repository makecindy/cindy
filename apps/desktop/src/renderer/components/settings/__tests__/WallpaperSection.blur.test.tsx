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
    // Zero-transparency desktop mode exists only with macOS's native sidebar material (#9424).
    platform: 'darwin',
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
const visibility = () => document.documentElement.style.getPropertyValue('--background-visibility');
const visibilityThumb = () => screen.getByRole('slider', { name: 'settings.appearance.wallpaper.visibilityLabel' });
const visibilityTrack = () => visibilityThumb().closest('.cindy-slider')!;

describe('wallpaper blur gesture persistence', () => {
  // Upgrade regression, unit integration: a legacy artwork visibility must not
  // reveal the desktop. Exercise the real provider, canvas and shared slider.
  it.each([undefined, 0.8])('keeps legacy visibility %s opaque until desktop opt-in and remembers both sources', async legacy => {
    saved = { ...saved, wallpaperId: 'none', wallpaperVisibility: legacy };
    const { unmount } = render(view());
    expect(visibility()).toBe('0');
    expect(document.documentElement.dataset.desktopBlur).toBe('0');
    expect(setPatch).not.toHaveBeenCalled();
    const slider = screen.getByRole('slider', { name: 'settings.appearance.wallpaper.desktopVisibilityLabel' }).closest('.cindy-slider')!;
    pointer(slider, 'pointerdown', 60);
    pointer(slider, 'pointerup', 60);
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ desktopVisibility: 0.6 }));
    expect(saved.wallpaperVisibility).toBe(legacy);
    act(() => changed({ ...saved, wallpaperId: 'cindy-window' }));
    expect(Number(visibility())).toBe(legacy ?? 0.37);
    act(() => changed({ ...saved, wallpaperId: 'none' }));
    expect(visibility()).toBe('0.6');
    unmount();
    render(view());
    expect(visibility()).toBe('0.6');
    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }));
    await waitFor(() => expect(setPatch).toHaveBeenCalledTimes(2));
    expect(visibility()).toBe('0');
    expect(saved.desktopVisibility).toBeNull();
  });

  // The real visibility slider used to save every pointer movement. Protect
  // desktop/artwork preview and one-write commit via the real provider + control.
  it.each(['none', 'cindy-window'] as const)('previews %s visibility without writing until release', async wallpaperId => {
    saved = { ...saved, wallpaperId, wallpaperVisibility: 0.4, desktopVisibility: 0.4 };
    render(view());
    const label = wallpaperId === 'none' ? 'desktopVisibilityLabel' : 'visibilityLabel';
    const slider = screen.getByRole('slider', { name: `settings.appearance.wallpaper.${label}` }).closest('.cindy-slider')!;
    pointer(slider, 'pointerdown', 60);
    pointer(slider, 'pointermove', 80);
    expect(document.documentElement.style.getPropertyValue('--background-visibility')).toBe('0.8');
    await act(async () => {});
    expect(setPatch).not.toHaveBeenCalled();
    pointer(slider, 'pointerup', 80);
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ [wallpaperId === 'none' ? 'desktopVisibility' : 'wallpaperVisibility']: 0.8 }));
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'leave'])(
    'discards visibility preview on %s and follows the latest saved value', async cause => {
      saved = { ...saved, wallpaperVisibility: 0.4 };
      const { rerender } = render(view());
      const slider = visibilityTrack();
      pointer(slider, 'pointerdown', 80);
      act(() => changed({ ...saved, wallpaperVisibility: 0.55 }));
      expect(visibility()).toBe('0.8');
      if (cause === 'leave') rerender(view(false));
      else if (cause === 'blur') fireEvent(window, new Event('blur'));
      else pointer(slider, cause, 80);
      await waitFor(() => expect(visibility()).toBe('0.55'));
      expect(setPatch).not.toHaveBeenCalled();
    },
  );
  it('commits keyboard visibility changes without pinning a stale preview', async () => {
    saved = { ...saved, wallpaperVisibility: 0.4 };
    render(view());
    fireEvent.keyDown(visibilityThumb(), { key: 'ArrowRight' });
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 0.41 }));
    act(() => changed({ ...saved, wallpaperVisibility: 0.7 }));
    expect(visibility()).toBe('0.7');
  });
  it.each(['pointer', 'keyboard'])('rolls back a failed %s visibility commit', async input => {
    saved = { ...saved, wallpaperVisibility: 0.4 };
    setPatch.mockRejectedValueOnce(new Error('save failed'));
    render(view());
    if (input === 'keyboard') fireEvent.keyDown(visibilityThumb(), { key: 'End' });
    else {
      pointer(visibilityTrack(), 'pointerdown', 80);
      pointer(visibilityTrack(), 'pointerup', 80);
    }
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: input === 'keyboard' ? 1 : 0.8 }));
    await waitFor(() => expect(visibility()).toBe('0.4'));
  });
  it('cancels visibility on reset and does not save when dragging back to the starting value', async () => {
    saved = { ...saved, wallpaperVisibility: 0.4 };
    render(view());
    pointer(visibilityTrack(), 'pointerdown', 80);
    pointer(visibilityTrack(), 'pointermove', 40);
    pointer(visibilityTrack(), 'pointerup', 40);
    await act(async () => {});
    expect(setPatch).not.toHaveBeenCalled();
    expect(visibility()).toBe('0.4');
    pointer(visibilityTrack(), 'pointerdown', 80);
    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }));
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wallpaperVisibility: null })));
    expect(visibility()).not.toBe('0.8');
  });
  // Unit integration: zero visibility suspends rendering and interaction, but
  // must never overwrite the preference shared by desktop and wallpaper modes.
  // Existing gesture cases only exercised visible backgrounds.
  it.each(['none', 'cindy-window'] as const)(
    'suspends %s blur at zero visibility and restores its saved value', (wallpaperId) => {
      saved = { ...saved, wallpaperId, wallpaperVisibility: 0, wallpaperBlur: 12 };
      render(view());
      const root = document.documentElement;
      const label = wallpaperId === 'none' ? 'desktopBlurLabel' : 'blurLabel';
      const slider = screen.getByRole('slider', { name: `settings.appearance.wallpaper.${label}` });
      const sliderTrack = slider.closest('.cindy-slider')!;
      expect(sliderTrack.hasAttribute('data-disabled')).toBe(true);
      expect(slider.getAttribute('aria-valuenow')).toBe('12');
      expect(blur()).toBe('');
      if (wallpaperId === 'none') expect(root.dataset.desktopBlur).toBe('0');
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
      pointer(sliderTrack, 'pointerdown', 80);
      pointer(sliderTrack, 'pointerup', 80);
      expect(setPatch).not.toHaveBeenCalled();
      act(() => changed({ ...saved, [wallpaperId === 'none' ? 'desktopVisibility' : 'wallpaperVisibility']: 0.5 }));
      expect(sliderTrack.hasAttribute('data-disabled')).toBe(false);
      expect(slider.getAttribute('aria-valuenow')).toBe('12');
      if (wallpaperId === 'none') expect(root.dataset.desktopBlur).toBe('12');
      else expect(blur()).toBe('12px');
      expect(setPatch).not.toHaveBeenCalled();
    },
  );
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
    expect(screen.getByRole('slider', { name: 'settings.appearance.wallpaper.desktopBlurLabel' }).getAttribute('aria-valuenow')).toBe('0');
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
  // Unit regression: the shared controls must retain an intermediate blur value
  // when switching from None to artwork; the former switch discarded this input.
  // Existing gesture cases only cover artwork. Native blur rendering is separate.
  it('shares the slider value between the desktop and wallpaper, saving only on release', async () => {
    saved = { ...saved, wallpaperId: 'none', desktopVisibility: 0.4 };
    render(view());
    const desktopThumb = screen.getByRole('slider', { name: 'settings.appearance.wallpaper.desktopBlurLabel' });
    const desktopTrack = desktopThumb.closest('.cindy-slider')!;
    pointer(desktopTrack, 'pointerdown', 30);
    pointer(desktopTrack, 'pointermove', 60);
    expect(desktopThumb.getAttribute('aria-valuenow')).toBe('12');
    expect(setPatch).not.toHaveBeenCalled();
    pointer(desktopTrack, 'pointerup', 60);
    await waitFor(() => expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperBlur: 12 }));
    act(() => changed({ ...saved, wallpaperId: 'cindy-window' }));
    expect(thumb().getAttribute('aria-valuenow')).toBe('12');
    expect(blur()).toBe('12px');
    act(() => changed({ ...saved, wallpaperId: 'none' }));
    expect(screen.getByRole('slider', { name: 'settings.appearance.wallpaper.desktopBlurLabel' }).getAttribute('aria-valuenow')).toBe('12');
  });
});
