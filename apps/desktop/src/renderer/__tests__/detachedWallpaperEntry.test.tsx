// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
} from '../../shared/appearanceSettings';

const h = vi.hoisted(() => ({ roots: [] as Array<{ unmount(): void }> }));
vi.mock('react-dom/client', async (original) => {
  const actual = await original<typeof import('react-dom/client')>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      h.roots.push(root);
      return root;
    },
  };
});
vi.mock('@/i18n', () => ({}));
vi.mock('../hooks/useLocale', () => ({
  bootstrapInitialLocale: vi.fn(),
  LocaleProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/error/TopLevelErrorBoundary', () => ({
  TopLevelErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/ui/confirm-dialog-provider', () => ({
  ConfirmDialogProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../cindy-brain/ghostPanels', () => ({ ensureGhostPanelsRegistered: vi.fn() }));
// Model UI is unrelated to the real entry's palette/font/wallpaper synchronization.
vi.mock('../cindy-brain/PluginModelPickerHost', () => ({ PluginModelPickerHost: () => null }));
vi.mock('../components/layout/SidebarWindowLayout', () => ({
  SidebarWindowLayout: () => <div>sidebar host</div>,
}));
vi.mock('../components/layout/SidebarTabWindowLayout', () => ({
  SidebarTabWindowLayout: () => <div>tab host</div>,
}));

afterEach(async () => {
  await act(async () => {
    for (const root of h.roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  const gateWindow = window as typeof window & {
    __xdtHiddenAnimationGateDisposer?: () => void;
    __xdtHiddenAnimationGateLastHidden?: boolean;
  };
  gateWindow.__xdtHiddenAnimationGateDisposer?.();
  delete gateWindow.__xdtHiddenAnimationGateLastHidden;
  document.documentElement.classList.remove('dark');
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['sidebar'] as const)(
  'boots %s with a wallpaper using its read-only bridge and follows live changes',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('theme', 'light');
    localStorage.setItem('theme.familyId', 'cindy');
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode = vi.fn().mockResolvedValue(undefined);
      },
    );
    const imageUrl = 'cindy-media://client-wallpaper/' + 'b'.repeat(64) + '.webp';
    const videoUrl = 'cindy-media://client-wallpaper/' + 'c'.repeat(64) + '.mp4';
    const ensureImage = vi.fn().mockResolvedValue(imageUrl);
    const ensureVideo = vi.fn().mockResolvedValue(videoUrl);
    document.body.innerHTML = '<div id="root"></div>';
    let changed!: (settings: AppearanceSettings) => void;
    let hiddenChanged!: (hidden: boolean) => void;
    let snapshot = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-window' as const,
      wallpaperMotion: 'dynamic' as const } as AppearanceSettings;
    const getSync = vi.fn(() => snapshot);
    const addListener = vi.spyOn(window, 'addEventListener');
    // Electron can report visible while a prewarmed native window is hidden.
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('electronAPI', {
      platform: 'win32',
      localThemes: {
        listSync: () => ({ success: true, diagnostics: [], themes: [{
          id: 'paper-light-local', family: 'paper', name: 'Paper', type: 'light',
          colors: { surface: '#faf4ed' }, packageSha256: 'a'.repeat(64),
          appearance: { density: 0.9, uiFont: { family: 'Georgia' } },
        }] }),
        onChanged: () => () => {},
      },
      onWindowHiddenChange: (fn: typeof hiddenChanged) => {
        hiddenChanged = fn;
        fn(true);
        return () => {};
      },
      appearanceSettings: {
        ensureWallpaperImage: ensureImage,
        ensureWallpaperVideo: ensureVideo,
        getSync,
        onChanged: (fn: typeof changed) => {
          changed = fn;
          return () => {};
        },
      },
    });
    await act(async () => {
      await import('../sidebar-window-entry');
    });
    expect(document.body.textContent).toContain('sidebar host');
    expect(addListener.mock.calls.filter(([event]) => event === 'storage')).toHaveLength(1);
    expect(document.documentElement.dataset.wallpaperActive).toBe('true');
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(document.querySelector('video')?.getAttribute('src')).toBe(videoUrl);
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toContain(
      imageUrl,
    );
    expect(ensureImage).toHaveBeenCalledWith('cindy-window');
    expect(ensureVideo).toHaveBeenCalledWith('cindy-window');
    if (kind === 'sidebar') {
      expect(play).not.toHaveBeenCalled();
      expect(pause).toHaveBeenCalled();
      const video = document.querySelector('video')!;
      await act(async () => hiddenChanged(false));
      expect(play).toHaveBeenCalledOnce();
      video.currentTime = 3;
      pause.mockClear();
      await act(async () => hiddenChanged(true));
      expect(pause).toHaveBeenCalledOnce();
      expect(play).toHaveBeenCalledOnce();
      await act(async () => hiddenChanged(false));
      expect(play).toHaveBeenCalledTimes(2);
      expect(document.querySelector('video')).toBe(video);
      expect(video.currentTime).toBe(3);
    }
    const lightVeil = document.documentElement.style.getPropertyValue('--app-wallpaper-veil');
    await act(async () => {
      document.documentElement.classList.add('dark');
    });
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-veil')).not.toBe(
      lightVeil,
    );
    const url = 'cindy-media://client-wallpaper/' + 'a'.repeat(64) + '.webp';
    await act(async () =>
      changed({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'custom', customWallpaperUrl: url }),
    );
    expect(document.querySelector('video')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toContain(url);
    await act(async () => changed(DEFAULT_APPEARANCE_SETTINGS));
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();

    // Unit, real sidebar entry/palette/font/presenter/wallpaper. #9817 let live
    // appearance snapshots update while its palette stayed at the startup family.
    // Existing entry coverage stubbed themes; one already-open window plus three
    // storage selections is the minimal input (no module resets or real waits).
    const reads = getSync.mock.calls.length;
    for (const [family, expectedTheme, settings] of [
      ['paper-local', 'paper-light-local', { ...DEFAULT_APPEARANCE_SETTINGS,
        uiFamily: 'Georgia', density: 0.9, motion: 0, wallpaperId: 'custom', customWallpaperUrl: url }],
      ['default', 'default-light', DEFAULT_APPEARANCE_SETTINGS],
      ['cindy', 'cindy-light', DEFAULT_APPEARANCE_SETTINGS],
    ] as const) {
      snapshot = settings;
      localStorage.setItem('theme.familyId', family);
      await act(async () => {
        changed(settings);
        window.dispatchEvent(new StorageEvent('storage', { key: 'theme.familyId', newValue: family }));
      });
      expect.soft(document.documentElement.dataset.theme, family).toBe(expectedTheme);
      expect(document.documentElement.style.getPropertyValue('--app-font-ui')).toBe(
        settings.uiFamily ? `${settings.uiFamily}, var(--app-font-ui-default)` : '',
      );
      expect(document.documentElement.dataset.wallpaperActive).toBe(family === 'paper-local' ? 'true' : undefined);
      expect(document.documentElement.dataset.cindyReducedMotion).toBe(family === 'paper-local' ? 'true' : undefined);
      const appearanceCss = document.querySelector('style[data-cindy-appearance]')?.textContent ?? '';
      if (family === 'paper-local') expect(appearanceCss).toContain('--space-4:0.9rem');
      else expect(appearanceCss).toBe('');
    }
    expect(getSync).toHaveBeenCalledTimes(reads);
  },
);
