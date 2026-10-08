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
vi.mock('../themes/colors', () => ({}));
vi.mock('../themes/local-themes', () => ({ bootstrapLocalThemesSync: vi.fn() }));
vi.mock('../themes/theme-service', () => ({ themeService: { applyTheme: vi.fn() } }));
vi.mock('../hooks/useTheme', () => ({ getInitialThemeVariant: () => ({ theme: 'test' }) }));
vi.mock('../hooks/useFontSettings', () => ({
  applyFontSettings: vi.fn(),
  getInitialFontSettings: vi.fn(),
}));
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
vi.mock('../components/layout/SidebarWindowLayout', () => ({
  SidebarWindowLayout: () => <div>sidebar host</div>,
}));
vi.mock('../components/layout/GhostPanelWindowLayout', () => ({
  GhostPanelWindowLayout: () => <div>plugin host</div>,
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['sidebar', 'plugin'] as const)(
  'boots %s with a wallpaper using its read-only bridge and follows live changes',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';
    let changed!: (settings: AppearanceSettings) => void;
    let hiddenChanged!: (hidden: boolean) => void;
    // Electron can report visible while a prewarmed native window is hidden.
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('electronAPI', {
      platform: 'win32',
      onWindowHiddenChange: (fn: typeof hiddenChanged) => {
        hiddenChanged = fn;
        fn(true);
        return () => {};
      },
      appearanceSettings: {
        getSync: () => ({
          ...DEFAULT_APPEARANCE_SETTINGS,
          wallpaperId: 'cindy-window',
          wallpaperMotion: 'dynamic',
        }),
        onChanged: (fn: typeof changed) => {
          changed = fn;
          return () => {};
        },
      },
    });
    await act(async () => {
      if (kind === 'sidebar') await import('../sidebar-window-entry');
      else await import('../ghost-panel-window-entry');
    });
    expect(document.body.textContent).toContain(
      kind === 'sidebar' ? 'sidebar host' : 'plugin host',
    );
    expect(document.documentElement.dataset.wallpaperActive).toBe('true');
    expect(document.querySelectorAll('video')).toHaveLength(1);
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
  },
);
