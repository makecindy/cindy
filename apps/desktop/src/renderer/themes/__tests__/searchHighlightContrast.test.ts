import { describe, expect, it } from 'vitest';

import { contrastRatio, parseCssColor } from '../../../shared/theme-import/color';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { Theme } from '../types';

function color(theme: Theme, id: string) {
  const value = resolveThemeValue(theme, id)!;
  const parsed = parseCssColor(id.startsWith('search-match') ? `hsl(${value})` : value);
  if (!parsed) throw new Error(`Unsupported color: ${theme.id} ${id} ${value}`);
  return parsed;
}

describe('Search highlight contrast', () => {
  it.each(Object.values(builtinThemes))('$id keeps the current match legible and distinct', (theme) => {
    const active = color(theme, 'search-match-active-bg');
    const foreground = color(theme, 'search-match-active-fg');
    expect(contrastRatio(active, foreground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(active, color(theme, 'search-match-bg'))).toBeGreaterThanOrEqual(1.4);
  });

  it.each(Object.values(builtinThemes))(
    '$id keeps ordinary matches readable and visible on content surfaces',
    (theme) => {
      const background = color(theme, 'search-match-bg');
      expect(contrastRatio(background, color(theme, 'search-match-fg'))).toBeGreaterThanOrEqual(4.5);
      for (const surface of ['surface', 'surface-elevated']) {
        // Regression floor for the fill, not a WCAG text-contrast claim.
        expect(contrastRatio(background, color(theme, surface))).toBeGreaterThanOrEqual(1.2);
      }
    },
  );

  it('preserves explicit old and new theme overrides', () => {
    const theme: Theme = {
      id: 'custom-search', name: 'Custom search', type: 'dark',
      colors: {
        'search-match-bg': '210 70% 25%',
        'search-match-fg': '0 0% 100%',
        'search-match-active-bg': '210 70% 75%',
        'search-match-active-fg': '0 0% 5%',
      },
    };
    for (const [id, value] of Object.entries(theme.colors)) {
      expect(resolveThemeValue(theme, id)).toBe(value);
    }
  });
});
