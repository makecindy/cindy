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

  it('keeps portal overlays opaque above a translucent skin canvas', () => {
    const theme = resolveSkinTheme(appearance, 'dark');
    expect(theme.colors.popover).toBe('207 30% 17%');
    expect(theme.colors['settings-theme-card-bg']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['surface-translucent-overlay']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['confirm-bg']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['model-dropdown-bg']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['folder-picker-bg']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['cmd-palette-bg']).toBe('hsl(207 30% 17%)');
  });

  it('maps composer, home controls, and sidebar hierarchy to host-owned skin colors', () => {
    const theme = resolveSkinTheme(appearance, 'dark');
    expect(theme.colors['composer-pill-bg']).toBe('hsl(205 28% 24% / 0.94)');
    expect(theme.colors['create-agent-control-bg']).toBe('hsl(207 30% 17% / 0.94)');
    expect(theme.colors['create-agent-segment-track-bg']).toBe('hsl(209 35% 11% / 0.94)');
    expect(theme.colors['model-agent-switch-track-bg']).toBe('hsl(209 35% 11%)');
    expect(theme.colors['model-agent-switch-selected-bg']).toBe('hsl(205 28% 24%)');
    expect(theme.colors['model-agent-switch-selected-text']).toBe('hsl(210 10% 88%)');
    expect(theme.colors['model-agent-switch-inactive-text']).toBe('hsl(210 8% 68%)');
    expect(theme.colors['settings-logout-bg']).toBe('hsl(207 30% 17% / 0.64)');
    expect(theme.colors['settings-logout-border']).toBe('hsl(205 28% 24% / 0.72)');
    expect(theme.colors['settings-logout-text']).toBe('hsl(210 10% 88%)');
    expect(theme.colors['settings-logout-hover-bg']).toBe('hsl(205 28% 24% / 0.86)');
    expect(theme.colors['settings-checkbox-bg']).toBe('hsl(207 30% 17% / 0.64)');
    expect(theme.colors['settings-checkbox-border']).toBe('hsl(210 8% 68%)');
    expect(theme.colors['settings-checkbox-checked-bg']).toBe('hsl(205 28% 24%)');
    expect(theme.colors['settings-checkbox-icon']).toBe('hsl(210 10% 88%)');
    expect(theme.colors['settings-shortcut-description']).toBe('hsl(210 8% 68%)');
    expect(theme.colors['settings-shortcut-key-bg']).toBe('hsl(207 30% 17%)');
    expect(theme.colors['settings-shortcut-key-border']).toBe('hsl(205 28% 24%)');
    expect(theme.colors['settings-shortcut-key-text']).toBe('hsl(210 10% 88%)');
    expect(theme.colors['settings-shortcut-action-icon']).toBe('hsl(210 8% 68%)');
    expect(theme.colors['sidebar-list-muted']).not.toBe(cindyDark.colors['sidebar-list-muted']);
    expect(theme.colors['folder-item-icon']).toBe(theme.colors['sidebar-list-muted']);
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
