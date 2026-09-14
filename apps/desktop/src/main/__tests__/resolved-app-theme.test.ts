import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolved app theme snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the persisted mode before the renderer reports its preference', async () => {
    const { resolveAppThemeIsDark } = await import('../resolved-app-theme');

    expect(resolveAppThemeIsDark(false)).toBe(false);
    expect(resolveAppThemeIsDark(true)).toBe(true);
    expect(resolveAppThemeIsDark(false, 'dark')).toBe(true);
    expect(resolveAppThemeIsDark(true, 'light')).toBe(false);
    expect(resolveAppThemeIsDark(false, 'light', true)).toBe(true);
    expect(resolveAppThemeIsDark(true, 'dark', false)).toBe(false);
    expect(resolveAppThemeIsDark(false, 'system', true)).toBe(false);
    expect(resolveAppThemeIsDark(true, 'system', false)).toBe(true);
  });

  it('uses the latest renderer-resolved theme for windows created later', async () => {
    const { rememberResolvedAppTheme, resolveAppThemeIsDark } = await import(
      '../resolved-app-theme'
    );

    rememberResolvedAppTheme(true);
    expect(resolveAppThemeIsDark(false)).toBe(true);

    rememberResolvedAppTheme(false);
    expect(resolveAppThemeIsDark(true)).toBe(false);
  });

  it('accepts only supported persisted modes', async () => {
    const { isAppThemeMode } = await import('../resolved-app-theme');

    expect(['system', 'light', 'dark'].every(isAppThemeMode)).toBe(true);
    expect(isAppThemeMode('auto')).toBe(false);
    expect(isAppThemeMode(null)).toBe(false);
  });
});
