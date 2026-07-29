import { describe, expect, it } from 'vitest';

import type { GhostAppearanceSnapshot } from '../../../shared/ghost';
import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { resolveSkinTheme } from '../skin-theme';
import { resolveThemeValue } from '../theme-service';

const appearance: GhostAppearanceSnapshot = {
  palette: 'ocean',
  sourceGhostId: 'skin-plugin',
  name: 'Ocean Room',
  dim: 0.28,
  surfaceOpacity: 0.82,
  updatedAt: 1,
};

describe('resolveSkinTheme', () => {
  it('uses the matching Cindy foundation and returns a complete light theme', () => {
    const theme = resolveSkinTheme(appearance, 'light');
    expect(theme.type).toBe('light');
    expect(theme.id).toBe('skin-ocean-light');
    expect(theme.colors['text-primary']).toBe(cindyLight.colors['text-primary']);
    expect(theme.colors.surface).not.toBe(cindyLight.colors.surface);
    expect(theme.brand).toEqual(cindyLight.brand);
  });

  it('switches only the skin variant when display mode becomes dark', () => {
    const light = resolveSkinTheme(appearance, 'light');
    const dark = resolveSkinTheme(appearance, 'dark');
    expect(dark.type).toBe('dark');
    expect(dark.colors['text-primary']).toBe(cindyDark.colors['text-primary']);
    expect(dark.colors.surface).not.toBe(light.colors.surface);
    expect(light.colors['sidebar-item-hover']).not.toContain('hsl(');
    expect(dark.brand).toEqual(cindyDark.brand);
  });

  it('keeps semantic danger and permission colors on the Cindy foundation', () => {
    const theme = resolveSkinTheme(appearance, 'dark');
    expect(theme.colors['perm-auto-selected-text']).toBe(
      cindyDark.colors['perm-auto-selected-text'],
    );
    expect(resolveThemeValue(theme, 'error-flat')).toBe(resolveThemeValue(cindyDark, 'error-flat'));
    expect(resolveThemeValue(theme, 'diff-add-bg')).toBe(
      resolveThemeValue(cindyDark, 'diff-add-bg'),
    );
  });

  it('places host-validated skin brand assets on the resolved theme', () => {
    const branded = resolveSkinTheme(
      {
        ...appearance,
        brand: {
          icon: { url: 'cindy-media://blobs/icon.png' },
          logo: { url: 'cindy-media://blobs/logo.png' },
        },
      },
      'light',
    );
    expect(branded.brand).toEqual({
      icon: { src: 'cindy-media://blobs/icon.png' },
      logo: { src: 'cindy-media://blobs/logo.png' },
    });
  });
});
