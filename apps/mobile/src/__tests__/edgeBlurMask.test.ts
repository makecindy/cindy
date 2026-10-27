import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_BLUR_FADE_INSIDE, EDGE_BLUR_FADE_OUTSIDE, HEADER_BLUR_FADE_OUTSIDE, edgeBlurMask, headerBlurLayers } from '@/session/edgeBlurMask';

const readTextLf = (path: string): string =>
  String(readFileSync(resolve(process.cwd(), path), 'utf8')).replace(/\r\n/g, '\n');
const alpha = (color: string): number => Number(/rgba\(0, 0, 0, ([\d.]+)\)/.exec(color)?.[1]);

describe('edge blur mask', () => {
  it('feathers the top chrome across its lower edge, from solid to clear', () => {
    const mask = edgeBlurMask(100, 'top');
    expect(EDGE_BLUR_FADE_INSIDE).toBe(24);
    expect(EDGE_BLUR_FADE_OUTSIDE).toBe(16);
    expect(mask.height).toBe(116);
    // The fade starts 24pt inside the chrome and ends at the backdrop edge, 16pt past it.
    expect(mask.startPoint.y * mask.height).toBeCloseTo(100 - 24);
    expect(mask.endPoint.y).toBe(1);
    expect(alpha(mask.colors[0])).toBe(1);
    expect(alpha(mask.colors.at(-1)!)).toBe(0);
  });

  it('mirrors the feather for the bottom chrome, facing up toward content', () => {
    const mask = edgeBlurMask(100, 'bottom');
    expect(mask.height).toBe(116);
    expect(mask.startPoint.y).toBe(0);
    expect(mask.endPoint.y * mask.height).toBeCloseTo(16 + 24);
    expect(alpha(mask.colors[0])).toBe(0);
    expect(alpha(mask.colors.at(-1)!)).toBe(1);
  });

  it('eases both ends of the fade instead of a linear ramp', () => {
    const alphas = edgeBlurMask(100, 'top').colors.map(alpha);
    expect(alphas).toHaveLength(9);
    for (let index = 1; index < alphas.length; index += 1) expect(alphas[index]).toBeLessThan(alphas[index - 1]);
    // Smoothstep: shallow steps at both ends, steep in the middle.
    expect(alphas[0] - alphas[1]).toBeLessThan(alphas[4] - alphas[5]);
    expect(alphas[7] - alphas[8]).toBeLessThan(alphas[4] - alphas[5]);
  });

  it('can keep the whole chrome solid and feather only past its edge', () => {
    const mask = edgeBlurMask(111, 'top', 0);
    expect(mask.height).toBe(127);
    expect(mask.startPoint.y * mask.height).toBeCloseTo(111);
    expect(mask.endPoint.y).toBe(1);
  });

  it('thins the header blur progressively: three layers end at a third, two thirds and the full fade', () => {
    expect(HEADER_BLUR_FADE_OUTSIDE).toBe(24);
    const layers = headerBlurLayers(100);
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      expect(layer.height).toBe(124);
      // Every layer is solid over the chrome until 24pt above its edge.
      expect(layer.startPoint.y * layer.height).toBeCloseTo(100 - 24);
    }
    expect(layers.map(layer => layer.endPoint.y * layer.height)).toEqual([76 + 16, 76 + 32, 124].map(value => expect.closeTo(value)));
  });

  it('keeps a chat header fully solid and starts every header layer at its edge', () => {
    for (const layer of headerBlurLayers(111, 0)) expect(layer.startPoint.y * layer.height).toBeCloseTo(111);
    expect(headerBlurLayers(111, 0).at(-1)!.endPoint.y).toBe(1);
  });

  it('keeps short chrome partly solid by capping the inside feather at half its height', () => {
    const mask = edgeBlurMask(20, 'top');
    expect(mask.startPoint.y * mask.height).toBeCloseTo(10);
  });
});

describe('composer edge backdrop placement', () => {
  const source = readTextLf('app/sessions/[sessionId].tsx');

  it('measures the input start inside the composer, after any recommendation card', () => {
    const composer = source.slice(source.indexOf('function SessionComposerInput('));
    const recommendation = composer.indexOf('<PromptRecommendation');
    const marker = composer.indexOf('testID="session.composerInputTop"');
    const input = composer.indexOf('testID="session.composer"');
    expect(recommendation).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(recommendation);
    expect(input).toBeGreaterThan(marker);
    expect(source.match(/testID="session\.composerInputTop"/g)).toHaveLength(1);
  });

  it('starts the iOS edge blur and the Android frost at the input, not at status rows above it', () => {
    expect(source).toContain('const composerBackdropTop = sessionResourceCards.blocked ? 0 : composerInputTop;');
    expect(source).toContain('height={Math.max(0, bottomOverlayHeight - composerBackdropTop)}');
    const frost = source.slice(source.indexOf('{androidFrostedComposer ? ('), source.indexOf('testID="session.composerFrost"'));
    expect(frost).toContain("sessionOperationLayout.composerSlot === 'editable' && !shareSelectionActive && { top: composerBackdropTop }");
  });

  it('frosts the activity pills with the shared chrome glass', () => {
    const pill = readTextLf('src/session/ComposerActivityPill.tsx');
    expect(pill).toContain("return Platform.OS === 'ios' ? 'transparent' : colors.surfaceTranslucent;");
    const glass = /<BlurBackdrop intensity=\{FLOATING_CHROME_BLUR_INTENSITY\} overlayColor=\{composerActivityPillOverlayColor\(colors\)\}/g;
    // Status pill (shared with the slow-send notice) and the elapsed/rate pill.
    expect(pill.match(glass)).toHaveLength(1);
    expect(source.match(glass)).toHaveLength(1);
  });
});
