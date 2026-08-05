import { describe, expect, it } from 'vitest';

import { contrastRatio, hslToRgb, type Rgb } from '../../../shared/theme-import/color';
import { buildThemeColorsFromPalette } from '../../../shared/theme-import/palette';
import { colorRegistry } from '../color-registry';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { ColorIdentifier, Theme } from '../types';

function parseHex(value: string): Rgb {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    throw new Error(`Unsupported color format in contrast test: ${value}`);
  }
  const hex = value.slice(1);
  const normalized = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex;
  const number = Number.parseInt(normalized, 16);
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
}

/** hex 或 HSL 三元组(开启态默认链路解析到 --text-primary-hsl 用)→ RGB;其余格式 fail closed。 */
function toRgb(value: string): Rgb {
  const t = value.trim();
  if (t.startsWith('#')) return parseHex(t);
  const triplet = t.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (triplet) {
    return hslToRgb(parseFloat(triplet[1]), parseFloat(triplet[2]) / 100, parseFloat(triplet[3]) / 100);
  }
  throw new Error(`Unsupported color format in contrast test: ${value}`);
}

function contrast(first: string, second: string): number {
  return contrastRatio(toRgb(first), toRgb(second));
}

const SURFACES = [
  'surface',
  'surface-elevated',
  'surface-card-ivory',
  'surface-hover',
  'surface-hover-soft',
] as const;

/** 开/关两态共用一套守卫:轨道×滑块、轨道×全部表面均 ≥3:1(非文字组件底线)。 */
const CONTROL_STATES = [
  { state: 'unchecked', trackId: 'switch-track-off', thumbId: 'switch-thumb-off' },
  { state: 'checked', trackId: 'switch-track-on', thumbId: 'background' },
] as const;

const importedDarkTheme: Theme = {
  id: 'imported-dark-fixture',
  name: 'Imported Dark Fixture',
  type: 'dark',
  colors: buildThemeColorsFromPalette({
    surface: { r: 24, g: 26, b: 30 },
    elevated: { r: 34, g: 37, b: 42 },
    elevatedSoft: { r: 34, g: 37, b: 42 },
    hover: { r: 48, g: 52, b: 58 },
    chip: { r: 48, g: 52, b: 58 },
    border: { r: 72, g: 77, b: 86 },
    textPrimary: { r: 230, g: 232, b: 235 },
    textSecondary: { r: 180, g: 184, b: 190 },
    textTertiary: { r: 132, g: 137, b: 145 },
    textDisabled: { r: 94, g: 99, b: 108 },
    accentPrimary: { r: 92, g: 157, b: 255 },
    accentSoft: { r: 137, g: 185, b: 255 },
    accentDeep: { r: 55, g: 112, b: 205 },
  }, 'dark'),
};

function resolveColor(theme: Theme, id: ColorIdentifier, seen = new Set<string>()): string {
  if (seen.has(id)) {
    throw new Error(`Circular color token reference: ${[...seen, id].join(' -> ')}`);
  }
  seen.add(id);

  const value = resolveThemeValue(theme, id);
  if (value === null) {
    throw new Error(`Theme '${theme.id}' does not resolve --${id}`);
  }

  // 认两种引用形态:var(--x) 与 hsl(var(--x))(开启态默认值 hsl(var(--primary)))。
  const reference = value.match(/^(?:hsl\()?var\(--([^)]+)\)\)?$/);
  return reference ? resolveColor(theme, reference[1], seen) : value;
}

describe('Switch contrast', () => {
  it('registers dedicated track and thumb tokens', () => {
    expect(colorRegistry.resolveDefault('switch-track-off', 'light')).toBe('var(--text-secondary)');
    expect(colorRegistry.resolveDefault('switch-track-off', 'dark')).toBe('var(--text-secondary)');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'light')).toBe('var(--surface-on-card)');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'dark')).toBe('var(--surface-on-card)');
    // 开启态轨道默认沿用 primary:不覆盖的主题(Classic/导入)外观零变化
    expect(colorRegistry.resolveDefault('switch-track-on', 'light')).toBe('hsl(var(--primary))');
    expect(colorRegistry.resolveDefault('switch-track-on', 'dark')).toBe('hsl(var(--primary))');
    // 禁用态两级弱化的全局定稿值(用户裁决 2026-08-05):整体 0.3 × 滑块 0.5
    for (const [id, expected] of [
      ['switch-disabled-opacity', '0.3'],
      ['switch-disabled-thumb-opacity', '0.5'],
    ] as const) {
      expect(colorRegistry.resolveDefault(id, 'light'), id).toBe(expected);
      expect(colorRegistry.resolveDefault(id, 'dark'), id).toBe(expected);
    }
  });

  it('fails closed for unsupported color formats', () => {
    expect(() => parseHex('rgb(130, 130, 130)')).toThrow('Unsupported color format');
    expect(() => toRgb('rgba(130, 130, 130, 0.5)')).toThrow('Unsupported color format');
  });

  it('resolves unchecked colors through imported theme palette aliases', () => {
    const track = resolveColor(importedDarkTheme, 'switch-track-off');
    const thumb = resolveColor(importedDarkTheme, 'switch-thumb-off');

    expect(track).toBe(importedDarkTheme.colors['text-secondary']);
    expect(thumb).toBe(importedDarkTheme.colors['surface-on-card']);
    expect(contrast(thumb, track), 'imported dark: thumb x track').toBeGreaterThanOrEqual(3);

    for (const surface of SURFACES) {
      const background = resolveColor(importedDarkTheme, surface);
      expect(contrast(track, background), `imported dark: track x ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(Object.values(builtinThemes))('$name keeps both switch states distinguishable', (theme) => {
    const surfaces = SURFACES.map((id) => [id, resolveColor(theme, id)] as const);

    for (const { state, trackId, thumbId } of CONTROL_STATES) {
      const track = resolveColor(theme, trackId);
      const thumb = resolveColor(theme, thumbId);

      expect(contrast(thumb, track), `${theme.id}: ${state} thumb x track`).toBeGreaterThanOrEqual(3);

      for (const [surfaceId, surface] of surfaces) {
        expect(contrast(track, surface), `${theme.id}: ${state} track x ${surfaceId}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
