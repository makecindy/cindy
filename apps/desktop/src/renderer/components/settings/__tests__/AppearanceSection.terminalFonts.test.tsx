// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { AppearanceSection } from '../AppearanceSection';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import appearanceSearch from '../AppearanceSection.settings-search';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (current, part) =>
            current && typeof current === 'object'
              ? (current as Record<string, unknown>)[part]
              : undefined,
          zhCN,
        );
      return typeof value === 'string' ? value : key;
    },
  }),
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

vi.mock('@/hooks/useWallpaperSettings', () => ({
  useWallpaperSettings: () => ({
    wallpaperId: 'none',
    wallpaperOverlay: 0.2,
    wallpaperMotion: 'static',
    visibility: 0.37,
    setWallpaper: vi.fn(),
    setVisibility: vi.fn(),
    setBlur: vi.fn(),
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

vi.mock('../LayoutResetControl', () => ({ LayoutResetControl: () => null }));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings() {
  render(
    <FontSettingsProvider>
      <AppearanceSection />
    </FontSettingsProvider>,
  );
}

describe('AppearanceSection terminal fonts', () => {
  it('registers search targets for the terminal font and size rows', () => {
    renderSettings();
    for (const key of ['terminalFamily', 'terminalSize']) {
      const entry = appearanceSearch.entries.find(
        (item) => item.id === `settings.appearance.font.${key}.label`,
      );
      expect(entry).toBeDefined();
      expect(document.getElementById(entry!.targetId)?.textContent).toContain(
        key === 'terminalFamily' ? '终端字体' : '终端字号',
      );
    }
  });

  it('reuses custom font entry and keeps terminal and code font selections independent', () => {
    renderSettings();
    const terminalPicker = screen.getByRole('button', { name: '选择终端字体' });
    const codePicker = screen.getByRole('button', { name: '选择代码字体' });

    fireEvent.click(terminalPicker);
    fireEvent.change(screen.getByPlaceholderText(zhCN.settings.appearance.font.customPlaceholder), {
      target: { value: 'Menlo' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: zhCN.settings.appearance.font.applyCustom }),
    );

    expect(terminalPicker.textContent).toBe('Menlo');
    expect(codePicker.textContent).toBe('Codex 风格（默认）');
    expect(
      screen.queryByPlaceholderText(zhCN.settings.appearance.font.customPlaceholder),
    ).toBeNull();

    fireEvent.click(codePicker);
    fireEvent.change(screen.getByPlaceholderText(zhCN.settings.appearance.font.customPlaceholder), {
      target: { value: 'Consolas' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: zhCN.settings.appearance.font.applyCustom }),
    );
    expect(codePicker.textContent).toBe('Consolas');
    expect(terminalPicker.textContent).toBe('Menlo');

    fireEvent.click(
      within(terminalPicker.parentElement!).getByRole('button', { name: '恢复默认' }),
    );
    expect(terminalPicker.textContent).toBe('等宽字体（默认）');
    expect(codePicker.textContent).toBe('Consolas');
  });

  it('applies the existing JetBrains Mono preset only to the terminal', () => {
    renderSettings();
    const terminalPicker = screen.getByRole('button', { name: '选择终端字体' });
    fireEvent.click(terminalPicker);
    fireEvent.click(screen.getByRole('option', { name: 'JetBrains Mono' }));

    expect(terminalPicker.textContent).toBe('JetBrains Mono');
    expect(screen.getByRole('button', { name: '选择代码字体' }).textContent).toBe(
      'Codex 风格（默认）',
    );
    expect(document.documentElement.style.getPropertyValue('--app-font-code')).toBe('');
  });

  it('bounds terminal size input, supports slider keys and resets only the terminal size', () => {
    renderSettings();
    const size = screen.getByRole('spinbutton', { name: '终端字号' }) as HTMLInputElement;
    const slider = screen.getByRole('slider', { name: '调整终端字号' });
    expect(size.value).toBe('13');

    fireEvent.change(size, { target: { value: '30' } });
    fireEvent.blur(size);
    expect(size.value).toBe('24');

    fireEvent.change(size, { target: { value: '' } });
    fireEvent.blur(size);
    expect(size.value).toBe('24');

    fireEvent.change(size, { target: { value: '9' } });
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(size.value).toBe('10');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(size.value).toBe('11');

    fireEvent.click(
      within(size.parentElement!.parentElement!).getByRole('button', { name: '恢复默认' }),
    );
    expect(size.value).toBe('13');
    expect((screen.getByRole('spinbutton', { name: '代码字号' }) as HTMLInputElement).value).toBe(
      '14',
    );
    expect((screen.getByRole('spinbutton', { name: '界面字号' }) as HTMLInputElement).value).toBe(
      '14',
    );
  });
});
