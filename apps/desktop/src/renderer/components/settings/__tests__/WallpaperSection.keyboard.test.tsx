// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type WallpaperId,
} from '@/../shared/appearanceSettings';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let saved: AppearanceSettings;
let changed: (settings: AppearanceSettings) => void;
let setPatch: ReturnType<typeof vi.fn>;
let importWallpaper: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = { ...DEFAULT_APPEARANCE_SETTINGS };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
      importWallpaper: (importWallpaper = vi.fn(async () => null)),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function view() {
  return render(
    <WallpaperSettingsProvider>
      <button>Before</button>
      <WallpaperSection />
    </WallpaperSettingsProvider>,
  );
}
const grid = () => screen.getByRole('radiogroup', { name: 'settings.appearance.wallpaper.aria' });
const options = () => within(grid()).getAllByRole('radio') as HTMLButtonElement[];
const tile = (id: WallpaperId) =>
  within(grid()).getByRole('radio', {
    name: 'settings.appearance.wallpaper.options.' + id,
  });
const tabStops = () => options().filter((button) => button.tabIndex === 0);
const chooseButton = () =>
  screen.getByRole('button', { name: 'settings.appearance.wallpaper.customChoose' });

async function expectSelected(id: WallpaperId) {
  await waitFor(() => expect(saved.wallpaperId).toBe(id));
  expect(tile(id).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(tile(id));
  expect(tabStops()).toEqual([tile(id)]);
}

describe('wallpaper keyboard navigation', () => {
  it('uses one Tab stop for the whole group and allows Tab / Shift+Tab to leave and re-enter', async () => {
    const user = userEvent.setup();
    view();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
    await user.tab();
    expect(document.activeElement).toBe(tile('none'));
    expect(tabStops()).toEqual([tile('none')]);
    await user.tab();
    expect(document.activeElement).toBe(chooseButton());
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(tile('none'));
    expect(setPatch).not.toHaveBeenCalled();
  });

  it('enters at the saved visible selection and updates the entry after pointer selection', async () => {
    const user = userEvent.setup();
    saved.wallpaperId = 'cindy-whisper';
    view();
    expect(tabStops()).toEqual([tile('cindy-whisper')]);
    await user.click(tile('dune-dawn'));
    await expectSelected('dune-dawn');
    await user.tab();
    expect(document.activeElement).toBe(chooseButton());
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(tile('dune-dawn'));
  });

  it('shows a retired saved selection as the second tile without rewriting that preference', async () => {
    saved.wallpaperId = 'cindy-window';
    view();
    expect(options().map((o) => o.getAttribute('aria-label')).slice(0, 3)).toEqual([
      'settings.appearance.wallpaper.options.none',
      'settings.appearance.wallpaper.options.cindy-window',
      'settings.appearance.wallpaper.options.cindy-whisper',
    ]);
    expect(tabStops()).toEqual([tile('cindy-window')]);
    expect(tile('cindy-window').getAttribute('aria-checked')).toBe('true');
    expect(setPatch).not.toHaveBeenCalled();
  });

  it('drops the retired tile once the user switches away from it', async () => {
    const user = userEvent.setup();
    saved.wallpaperId = 'cindy-window';
    view();
    act(() => tile('cindy-window').focus());
    await user.keyboard('{ArrowRight}');
    await expectSelected('cindy-whisper');
    expect(screen.queryByRole('radio', { name: /cindy-window$/ })).toBeNull();
    expect(document.activeElement).toBe(tile('cindy-whisper'));
    expect(tabStops()).toEqual([tile('cindy-whisper')]);
  });

  it('moves focus and selection with all four arrows and Home', async () => {
    const user = userEvent.setup();
    view();
    act(() => tile('none').focus());
    await user.keyboard('{ArrowRight}');
    await expectSelected('cindy-whisper');
    await user.keyboard('{ArrowDown}');
    await expectSelected('cindy-night-glance');
    await user.keyboard('{ArrowLeft}');
    await expectSelected('cindy-whisper');
    await user.keyboard('{ArrowUp}');
    await expectSelected('none');
    await user.keyboard('{ArrowRight}{Home}');
    await expectSelected('none');
  });

  it('wraps across both ends and lets End select an existing custom image', async () => {
    const user = userEvent.setup();
    saved.customWallpaperUrl = 'cindy-media://client-wallpaper/' + 'a'.repeat(64) + '.webp';
    view();
    act(() => tile('none').focus());
    await user.keyboard('{ArrowLeft}');
    await expectSelected('custom');
    await user.keyboard('{ArrowRight}');
    await expectSelected('none');
    await user.keyboard('{End}');
    await expectSelected('custom');
    expect(importWallpaper).not.toHaveBeenCalled();
  });

  it.each(['{Enter}', ' '])(
    'requires explicit %s activation to import an empty custom tile',
    async (key) => {
      const user = userEvent.setup();
      view();
      act(() => tile('none').focus());
      await user.keyboard('{End}');
      expect(document.activeElement).toBe(tile('custom'));
      expect(tabStops()).toEqual([tile('custom')]);
      expect(saved.wallpaperId).toBe('none');
      expect(setPatch).not.toHaveBeenCalled();
      expect(importWallpaper).not.toHaveBeenCalled();
      await user.keyboard(key);
      await waitFor(() => expect(importWallpaper).toHaveBeenCalledOnce());
      expect(saved.wallpaperId).toBe('none');
      expect(setPatch).not.toHaveBeenCalled();
    },
  );

  it('returns the Tab entry to the selected item after leaving the empty custom tile', async () => {
    const user = userEvent.setup();
    view();
    act(() => tile('none').focus());
    await user.keyboard('{End}');
    await user.tab();
    expect(document.activeElement).toBe(chooseButton());
    expect(tabStops()).toEqual([tile('none')]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(tile('none'));
    expect(importWallpaper).not.toHaveBeenCalled();
  });

  it('honors RTL for horizontal keys without reversing vertical navigation', async () => {
    const user = userEvent.setup();
    saved.wallpaperId = 'cindy-whisper';
    view();
    for (const button of options()) button.style.direction = 'rtl';
    act(() => tile('cindy-whisper').focus());
    await user.keyboard('{ArrowRight}');
    await expectSelected('none');
    await user.keyboard('{ArrowLeft}');
    await expectSelected('cindy-whisper');
    await user.keyboard('{ArrowDown}');
    await expectSelected('cindy-night-glance');
  });

  it('keeps busy options out of the Tab order and ignores key presses while importing', async () => {
    let finish!: (value: null) => void;
    importWallpaper.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
    );
    view();
    fireEvent.click(tile('custom'));
    expect(options().every((button) => button.disabled)).toBe(true);
    expect(tabStops()).toEqual([]);
    fireEvent.keyDown(tile('none'), { key: 'ArrowRight' });
    expect(setPatch).not.toHaveBeenCalled();
    await act(async () => finish(null));
    expect(options().every((button) => !button.disabled)).toBe(true);
    expect(tabStops()).toEqual([tile('none')]);
  });
});
