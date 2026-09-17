import { describe, expect, it } from 'vitest';
import { contrastRatio, type Rgb } from '../../../shared/theme-import/color';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { Theme } from '../types';

function rgb(theme: Theme, id: string, depth = 0): Rgb {
  if (depth > 8) throw new Error(`Circular color alias: ${id}`);
  const color = resolveThemeValue(theme, id);
  const alias = color?.match(/^var\(--([\w-]+)\)$/);
  if (alias) return rgb(theme, alias[1], depth + 1);
  if (!color || !/^#[\da-f]{6}$/i.test(color)) throw new Error(`Unsupported color: ${id}=${color}`);
  return { r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) };
}

describe('FormField reading help', () => {
  it.each(Object.values(builtinThemes))('$id keeps small help text readable on the form surface', (theme) => {
    expect(contrastRatio(rgb(theme, 'form-field-hint'), rgb(theme, 'surface-elevated'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['cindy-light', 'cindy-dark'])('%s preserves the accepted Cindy hint color', (id) => {
    const theme = builtinThemes[id];
    expect(rgb(theme, 'form-field-hint')).toEqual(rgb(theme, 'text-tertiary'));
  });
});
