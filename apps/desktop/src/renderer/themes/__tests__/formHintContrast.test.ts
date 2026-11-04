import { describe, expect, it } from 'vitest';
import { contrastRatio, parseCssColorComposited, type Rgb } from '../../../shared/theme-import/color';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { Theme } from '../types';

function resolve(theme: Theme, id: string, depth = 0): string {
  if (depth > 8) throw new Error(`Circular color alias: ${id}`);
  const color = resolveThemeValue(theme, id);
  const alias = color?.match(/^var\(--([\w-]+)\)$/);
  if (alias) return resolve(theme, alias[1], depth + 1);
  if (!color) throw new Error(`Unsupported color: ${id}=${color}`);
  return color;
}

/** 屏幕上的实际颜色:半透明值(CINDY 的墨水文字)叠到给定底色上;不给底色时只认不透明 hex。 */
function rgb(theme: Theme, id: string, over: Rgb | null = null): Rgb {
  const color = resolve(theme, id);
  if (!over && !/^#[\da-f]{6}$/i.test(color)) throw new Error(`Unsupported color: ${id}=${color}`);
  const parsed = parseCssColorComposited(color, over);
  if (!parsed) throw new Error(`Unsupported color: ${id}=${color}`);
  return parsed;
}

describe('FormField reading help', () => {
  it.each(Object.values(builtinThemes))('$id keeps small help text readable on the form surface', (theme) => {
    const surface = rgb(theme, 'surface-elevated');
    expect(contrastRatio(rgb(theme, 'form-field-hint', surface), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['cindy-light', 'cindy-dark'])('%s reads help text in the description ink tier', (id) => {
    const theme = builtinThemes[id];
    expect(resolve(theme, 'form-field-hint')).toBe(resolve(theme, 'text-secondary-mid'));
  });

  it('fails closed when a translucent hint has no surface to sit on', () => {
    expect(() => rgb(builtinThemes['cindy-light'], 'form-field-hint')).toThrow('Unsupported color');
  });
});
