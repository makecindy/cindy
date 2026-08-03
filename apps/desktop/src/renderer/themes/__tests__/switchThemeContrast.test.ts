import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../color-registry';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { ColorIdentifier, Theme } from '../types';

type RGB = readonly [number, number, number];

function parseHex(value: string): RGB {
  const hex = value.slice(1);
  const normalized = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex;
  const number = Number.parseInt(normalized, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

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
    expect(colorRegistry.resolveDefault('switch-track-off', 'light')).toBe('#828282');
    expect(colorRegistry.resolveDefault('switch-track-off', 'dark')).toBe('#858585');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'light')).toBe('var(--surface-on-card)');
    expect(colorRegistry.resolveDefault('switch-thumb-off', 'dark')).toBe('var(--surface-on-card)');
  });

  it.each(Object.values(builtinThemes))('$name keeps the unchecked control distinguishable', (theme) => {
    const track = resolveColor(theme, 'switch-track-off');
    const thumb = resolveColor(theme, 'switch-thumb-off');

    expect(contrast(thumb, track), `${theme.id}: thumb x track`).toBeGreaterThanOrEqual(3);

    for (const surface of ['surface', 'surface-elevated', 'surface-card-ivory'] as const) {
      const background = resolveColor(theme, surface);
      expect(contrast(track, background), `${theme.id}: track x ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});
