import { describe, expect, it } from 'vitest';

import { buildThemeColorsFromPalette } from '../../../shared/theme-import/palette';
import { colorRegistry } from '../color-registry';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { ColorIdentifier, Theme } from '../types';

type RGB = readonly [number, number, number];

function parseHex(value: string): RGB {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    throw new Error(`Unsupported color format in contrast test: ${value}`);
  }
  const hex = value.slice(1);
  const normalized = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex;
  const number = Number.parseInt(normalized, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

const UNCHECKED_SURFACES = [
  'surface',
  'surface-elevated',
  'surface-card-ivory',
  'surface-hover',
  'surface-hover-soft',
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

function luminance(value: string): number {
  const channels = parseHex(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveColor(theme: Theme, id: ColorIdentifier, seen = new Set<string>()): string {
  if (seen.has(id)) {
    throw new Error(`Circular color token reference: ${[...seen, id].join(' -> ')}`);
  }
  seen.add(id);

  const value = resolveThemeValue(theme, id);
  if (value === null) {
    throw new Error(`Theme '${theme.id}' does not resolve --${id}`);
  }

  const reference = value.match(/^var\(--([^)]+)\)$/);
  return reference ? resolveColor(theme, reference[1], seen) : value;
}

describe('unchecked Switch contrast', () => {
  it('registers dedicated track and thumb tokens', () => {
    expect(colorRegistry.resolveDefault('switch-track-off', 'light')).toBe('var(--text-secondary)');
    expect(colorRegistry.resolveDefault('switch-track-off', 'dark')).toBe('var(--text-secondary)');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'light')).toBe('var(--surface-on-card)');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'dark')).toBe('var(--surface-on-card)');
  });

  it('fails closed for unsupported color formats', () => {
    expect(() => parseHex('rgb(130, 130, 130)')).toThrow('Unsupported color format');
  });

  it('resolves unchecked colors through imported theme palette aliases', () => {
    const track = resolveColor(importedDarkTheme, 'switch-track-off');
    const thumb = resolveColor(importedDarkTheme, 'switch-thumb-off');

    expect(track).toBe(importedDarkTheme.colors['text-secondary']);
    expect(thumb).toBe(importedDarkTheme.colors['surface-on-card']);
    expect(contrast(thumb, track), 'imported dark: thumb x track').toBeGreaterThanOrEqual(3);

    for (const surface of UNCHECKED_SURFACES) {
      const background = resolveColor(importedDarkTheme, surface);
      expect(contrast(track, background), `imported dark: track x ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(Object.values(builtinThemes))('$name keeps the unchecked control distinguishable', (theme) => {
    const track = resolveColor(theme, 'switch-track-off');
    const thumb = resolveColor(theme, 'switch-thumb-off');

    expect(contrast(thumb, track), `${theme.id}: thumb x track`).toBeGreaterThanOrEqual(3);

    for (const surface of UNCHECKED_SURFACES) {
      const background = resolveColor(theme, surface);
      expect(contrast(track, background), `${theme.id}: track x ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});
