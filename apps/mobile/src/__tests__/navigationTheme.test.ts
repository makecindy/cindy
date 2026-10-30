import { describe, expect, it } from 'vitest';
import { createNavigationTheme } from '@/theme/navigationTheme';
import { darkColors, lightColors } from '@/theme/tokens';
import type { Theme as NavigationTheme } from 'expo-router';

const baseTheme: NavigationTheme = {
  dark: false,
  colors: {
    primary: 'base-primary',
    background: 'base-background',
    card: 'base-card',
    text: 'base-text',
    border: 'base-border',
    notification: 'base-notification',
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '600' },
    heavy: { fontFamily: 'System', fontWeight: '700' },
  },
};

describe('mobile navigation theme', () => {
  it.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('projects the %s palette onto every navigation surface', (_mode, colors) => {
    const result = createNavigationTheme(baseTheme, colors);

    expect(result.colors).toEqual({
      primary: colors.inputCaret,
      background: colors.surface,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
      notification: colors.statusError,
    });
    expect(result.fonts).toBe(baseTheme.fonts);
    expect(baseTheme.colors.background).toBe('base-background');
  });
});
