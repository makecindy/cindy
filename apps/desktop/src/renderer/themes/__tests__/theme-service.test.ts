// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { defaultDark } from '../builtin/default-dark';
import { defaultLight } from '../builtin/default-light';
import '../colors';
import { exportThemeColors, themeService } from '../theme-service';

describe('ThemeService native control color scheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('color-scheme');
    document.getElementById('theme-vars')?.remove();
  });

  it('updates the native control color scheme when switching themes', () => {
    themeService.applyTheme(defaultDark);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    themeService.applyTheme(defaultLight);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  // PR #10019 / governance §4: old local themes may reference this public ID
  // from shadow-menu. Existing color-scheme coverage did not test missing aliases.
  // Minimal unit input: a theme overriding shadow-menu with the legacy variable.
  it.each([defaultLight, defaultDark])('preserves legacy shadow references in $type themes', base => {
    const theme = { ...base, colors: { ...base.colors, 'shadow-menu': 'var(--shadow-chip-raised)' } };
    const expected = base.type === 'light'
      ? '0 1px 2px rgba(0, 0, 0, 0.12)'
      : '0 1px 2px rgba(0, 0, 0, 0.4)';
    const exported = exportThemeColors(theme);
    expect(exported['shadow-menu']).toBe('var(--shadow-chip-raised)');
    expect(exported['shadow-chip-raised']).toBe(expected);
    themeService.applyTheme(theme);
    const injected = document.getElementById('theme-vars')?.textContent;
    expect(injected).toContain(`--shadow-chip-raised:${expected}`);
    expect(injected).toContain('--shadow-menu:var(--shadow-chip-raised)');
  });
});
