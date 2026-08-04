import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { darkColors, lightColors } from '@/theme/tokens';

type Rgb = [number, number, number];

function parseColor(color: string): { rgb: Rgb; alpha: number } {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return {
      rgb: [
        Number.parseInt(hex[1].slice(0, 2), 16),
        Number.parseInt(hex[1].slice(2, 4), 16),
        Number.parseInt(hex[1].slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }

  const rgba = color.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/i);
  if (!rgba) throw new Error(`Unsupported color: ${color}`);

  return {
    rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    alpha: Number(rgba[4]),
  };
}

function composite(foreground: string, background: string): string {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const alpha = fg.alpha + bg.alpha * (1 - fg.alpha);
  const rgb = fg.rgb.map((value, index) =>
    Math.round((value * fg.alpha + bg.rgb[index] * bg.alpha * (1 - fg.alpha)) / alpha),
  );
  return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function luminance(color: string): number {
  const { rgb } = parseColor(color);
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const [higher, lower] = [foregroundLuminance, backgroundLuminance].sort((a, b) => b - a);
  return (higher + 0.05) / (lower + 0.05);
}

describe('mobile message text selection contrast', () => {
  it('uses a dedicated translucent selection token at every Markdown selectable text site', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).not.toContain('selectionColor={colors.surfaceChip}');
    expect(source).not.toContain('selectionColor={colors.inputCaret}');
    expect(source.match(/selectionColor=\{colors\.selectionHighlight\}/g)).toHaveLength(8);
  });

  it('keeps selected light and dark body/code text above WCAG AA contrast', () => {
    const themes = [
      { colors: lightColors, bodySurface: lightColors.surface, codeSurface: lightColors.chatCodeSurface },
      { colors: darkColors, bodySurface: darkColors.surface, codeSurface: darkColors.chatCodeSurface },
    ];

    for (const { colors, bodySurface, codeSurface } of themes) {
      const selectedBodySurface = composite(colors.selectionHighlight, bodySurface);
      const selectedCodeSurface = composite(colors.selectionHighlight, codeSurface);

      expect(contrastRatio(colors.textPrimary, selectedBodySurface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.syntaxNumber, selectedCodeSurface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(selectedBodySurface, bodySurface)).toBeGreaterThanOrEqual(1.1);
    }
  });
});
