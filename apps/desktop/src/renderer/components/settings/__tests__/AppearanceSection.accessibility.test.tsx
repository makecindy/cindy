// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AppearanceSection } from '../AppearanceSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useTheme', () => ({
  resolveIsDark: () => false,
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn(),
    familyId: 'cindy',
    setFamily: vi.fn(),
    fallbackFromType: null,
  }),
}));

vi.mock('@/hooks/useFontSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useFontSettings')>()),
  useFontSettings: () => ({
    uiFamily: '',
    codeFamily: '',
    uiSize: 14,
    codeSize: 14,
    setUiFamily: vi.fn(),
    setCodeFamily: vi.fn(),
    setUiSize: vi.fn(),
    setCodeSize: vi.fn(),
    resetUiFamily: vi.fn(),
    resetCodeFamily: vi.fn(),
    resetUiSize: vi.fn(),
    resetCodeSize: vi.fn(),
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
  it('labels the UI and code font-size number inputs', () => {
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
      'settings.appearance.wallpaper.options.cindy-window',
      'settings.appearance.wallpaper.options.cindy-studio',
      'settings.appearance.wallpaper.options.cindy-dream',
      'settings.appearance.wallpaper.options.memory',
      'settings.appearance.wallpaper.options.custom',
    ]);
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.uiSize.label' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.codeSize.label' }),
    ).toBeTruthy();
  });
});
