// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
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
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    value?: number[];
    onValueChange?: (value: number[]) => void;
  }) => <input type="range" value={value?.[0]} readOnly {...props} />,
}));

vi.mock('../FontFamilyPicker', () => ({ FontFamilyPicker: () => null }));
vi.mock('../LayoutResetControl', () => ({ LayoutResetControl: () => null }));

describe('AppearanceSection accessibility', () => {
  it('labels the UI and code font-size number inputs', () => {
    render(<AppearanceSection />);

    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.uiSize.label' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('spinbutton', { name: 'settings.appearance.font.codeSize.label' }),
    ).toBeTruthy();
  });
});
