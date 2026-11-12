import { describe, expect, it } from 'vitest';
import { composerBottomContentPadding, composerGeometry, composerPillHeight, composerRestingBottom } from '@/session/composerGeometry';

const source = { id: 'entry', x: 326, y: 776, width: 56, height: 56, windowWidth: 402, windowHeight: 874 };
describe('shared composer bottom edge', () => {
  it('uses the actual source button edge, including a different safe area', () => {
    expect(composerRestingBottom(source, 402, 874, 34)).toBe(42);
    expect(874 - composerRestingBottom(source, 402, 874, 0)).toBe(source.y + source.height);
  });
  it('does not reuse portrait coordinates after folding or rotating', () => {
    expect(composerRestingBottom(source, 874, 402, 21)).toBe(29);
    expect(composerRestingBottom({ ...source, y: 900 }, 402, 874, 34)).toBe(42);
  });
  it('accounts for keyboard lift and existing composer padding exactly once', () => {
    const keyboard = 320, safeArea = 34, innerPadding = 4, gap = 8;
    const layerBottom = keyboard - safeArea;
    const content = composerBottomContentPadding(keyboard + gap, layerBottom, innerPadding);
    expect(layerBottom + content + innerPadding).toBe(keyboard + gap);
    const resting = composerBottomContentPadding(42, 0, innerPadding);
    expect(resting + innerPadding).toBe(42);
  });
  it('sizes the compact pill to the button only for the same window', () => {
    expect(composerPillHeight(source, 402, 874)).toBe(56);
    // Without a usable button frame the pill keeps the shared button size.
    expect(composerPillHeight(source, 874, 402)).toBe(composerGeometry.pillHeight);
    expect(composerPillHeight(null, 402, 874)).toBe(composerGeometry.pillHeight);
  });
  it('never makes negative padding when a reserved region already lifts the composer', () => {
    expect(composerBottomContentPadding(42, 80, 4)).toBe(0);
  });
});
