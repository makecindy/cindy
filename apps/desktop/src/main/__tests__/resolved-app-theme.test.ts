import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolved app theme snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('falls back to the system theme before the renderer reports its preference', async () => {
    const { resolveAppThemeIsDark } = await import('../resolved-app-theme');

    expect(resolveAppThemeIsDark(false)).toBe(false);
    expect(resolveAppThemeIsDark(true)).toBe(true);
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
});
