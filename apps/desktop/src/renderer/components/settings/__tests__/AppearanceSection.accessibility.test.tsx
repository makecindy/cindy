// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AppearanceSection } from '../AppearanceSection';

const themeState = vi.hoisted(() => ({ familyId: 'cindy' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useTheme', () => ({
  resolveIsDark: () => false,
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn(),
    familyId: themeState.familyId,
    setFamily: vi.fn(),
  }),
}));

vi.mock('@/hooks/useFontSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useFontSettings')>()),
  useFontSettings: () => ({
    uiFamily: '',
    codeFamily: '',
    uiSize: 14,
    codeSize: 14,
    terminalFamily: '',
    terminalSize: 13,
    setUiFamily: vi.fn(),
    setCodeFamily: vi.fn(),
    setUiSize: vi.fn(),
    setCodeSize: vi.fn(),
    setTerminalFamily: vi.fn(),
    setTerminalSize: vi.fn(),
    resetUiFamily: vi.fn(),
    resetCodeFamily: vi.fn(),
    resetUiSize: vi.fn(),
    resetCodeSize: vi.fn(),
    resetTerminalFamily: vi.fn(),
    resetTerminalSize: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWallpaperSettings', () => ({
  useWallpaperSettings: () => ({
    wallpaperId: 'none',
    wallpaperOverlay: 0,
    wallpaperMotion: 'static',
    setWallpaper: vi.fn(),
    visibility: 0.37,
    setVisibility: vi.fn(),
    previewBlur: vi.fn(),
    setMotion: vi.fn(),
    resetWallpaper: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSidebarCardMode', () => ({
  useSidebarCardMode: () => ({ mode: 'text', setMode: vi.fn() }),
  useSidebarMainViewMode: () => ({ mode: 'list', setMode: vi.fn() }),
}));

vi.mock('@/themes/local-themes', () => ({
  buildCopyFromTheme: vi.fn(),
  getLocalThemes: () => [],
  onLocalThemesChange: () => () => {},
  refreshLocalThemes: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/slider', () => ({
  Slider: ({
    value,
    onValueChange: _onValueChange,
    onValueCommit: _onValueCommit,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    value?: number[];
    onValueChange?: (value: number[]) => void;
    onValueCommit?: (value: number[]) => void;
  }) => {
    void _onValueChange;
    void _onValueCommit;
    return <input type="range" value={value?.[0]} readOnly {...props} />;
  },
}));

vi.mock('../FontFamilyPicker', () => ({ FontFamilyPicker: () => null }));
vi.mock('../LayoutResetControl', () => ({ LayoutResetControl: () => null }));

describe('AppearanceSection accessibility', () => {
  it('labels the UI, code and terminal font-size number inputs', () => {
    render(<AppearanceSection />);
    const visibility = screen.getByRole('slider', {
      name: 'settings.appearance.wallpaper.visibilityLabel',
    });
    expect(visibility.getAttribute('min')).toBe('0');
    expect(visibility.getAttribute('max')).toBe('1');
    expect(visibility.getAttribute('step')).toBe('0.01');
    expect(visibility.getAttribute('aria-describedby')).toBe('wallpaper-visibility-hint');
    expect(screen.getByText('37%')).toBeTruthy();
    const blur = screen.getByRole('slider', { name: 'settings.appearance.wallpaper.blurLabel' });
    expect(blur.getAttribute('min')).toBe('0');
    expect(blur.getAttribute('max')).toBe('20');
    expect(blur.getAttribute('step')).toBe('1');
    expect(blur.getAttribute('aria-describedby')).toBe('wallpaper-blur-hint');
    expect(blur.hasAttribute('disabled')).toBe(true);

    const wallpapers = within(
      screen.getByRole('radiogroup', { name: 'settings.appearance.wallpaper.aria' }),
    );
    expect(
      wallpapers.getAllByRole('radio').map((option) => option.getAttribute('aria-label')),
    ).toEqual([
      'settings.appearance.wallpaper.options.none',
      'settings.appearance.wallpaper.options.cindy-whisper',
      'settings.appearance.wallpaper.options.cindy-night-glance',
      'settings.appearance.wallpaper.options.cindy-scarlet-stroll',
      'settings.appearance.wallpaper.options.cindy-neon',
      'settings.appearance.wallpaper.options.cindy-prism',
      'settings.appearance.wallpaper.options.night-launch',
      'settings.appearance.wallpaper.options.silent-orbits',
      'settings.appearance.wallpaper.options.dune-dawn',
      'settings.appearance.wallpaper.options.planet-dawn',
      'settings.appearance.wallpaper.options.indigo-folds',
      'settings.appearance.wallpaper.options.dune-sphere',
      'settings.appearance.wallpaper.options.ocean-clouds',
      'settings.appearance.wallpaper.options.rose-quartz',
      'settings.appearance.wallpaper.options.custom',
    ]);
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.uiSize.label' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.codeSize.label' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.terminalSize.label' }),
    ).toBeTruthy();
  });

  it('locks the appearance mode to the only variant of a single-variant theme', () => {
    themeState.familyId = 'eclipse';
    try {
      render(<AppearanceSection />);

      const modes = within(
        screen.getByRole('radiogroup', { name: 'settings.appearance.modeLabel' }),
      ).getAllByRole('radio');
      expect(modes.map((mode) => (mode as HTMLButtonElement).disabled)).toEqual([true, true, true]);
      expect(modes.map((mode) => mode.getAttribute('aria-checked'))).toEqual([
        'false',
        'true',
        'false',
      ]);
      expect(screen.getByText('settings.appearance.singleVariant.darkNotice')).toBeTruthy();
    } finally {
      themeState.familyId = 'cindy';
    }
  });

  it('keeps the saved appearance mode selectable for two-variant themes', () => {
    render(<AppearanceSection />);

    const modes = within(
      screen.getByRole('radiogroup', { name: 'settings.appearance.modeLabel' }),
    ).getAllByRole('radio');
    expect(modes.some((mode) => (mode as HTMLButtonElement).disabled)).toBe(false);
    expect(modes.map((mode) => mode.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    expect(screen.queryByText(/settings\.appearance\.singleVariant\..*Notice/)).toBeNull();
  });
});
