import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-reanimated', () => ({ default: { createAnimatedComponent: (component: unknown) => component } }));
vi.mock('react-native-svg', () => ({ Path: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ getCachedReduceMotionEnabled: () => false }));

import { countUpFrames, openingLiquid, randomSlosh } from '@/widgets/usageOpeningMotion';

// Pure functions behind the drawer card's opening (unit, 0.3s standalone). The count-up reads
// text formatted elsewhere (the desktop's locale, abbreviated totals), so a misread separator
// would show amounts orders of magnitude off for a second; the liquid must end exactly on the
// level the still tube draws, or every opening would finish with a visible jump.
describe('counting a displayed amount up from zero', () => {
  it('ends on the exact text and keeps its width on the way', () => {
    for (const [text, locale] of [['68', 'zh-CN'], ['62,500', 'en-US'], ['257K', 'zh-CN'], ['1.2M', 'en-US'], ['31,17', 'de']] as const) {
      const frame = countUpFrames(text, locale)!;
      expect(frame(1)).toBe(text);
      for (const progress of [0, 0.3, 0.9]) expect(frame(progress)).toHaveLength(text.length);
    }
  });
  it('starts at zero with the same decimals, unit and leading figure spaces', () => {
    expect(countUpFrames('68', 'en-US')!(0)).toBe(' 0');
    expect(countUpFrames('1.2M', 'en-US')!(0)).toBe('0.0M');
    expect(countUpFrames('62,500', 'en-US')!(0.5)).toBe('31,250');
  });
  it('reads a decimal comma in its own locale instead of as thousands', () => {
    expect(countUpFrames('31,17', 'de')!(0.5).trim()).toBe('15,59');
  });
  it('leaves text that is not one plain number alone', () => {
    expect(countUpFrames('—', 'en-US')).toBeNull();
    expect(countUpFrames('5d 11h', 'en-US')).toBeNull();
  });
});

describe('the liquid of an opening tube', () => {
  const well = { x: 3, bottom: 43, width: 16, level: 27, fraction: 0.68, phase: 0 };
  /** Vertical extent of the surface: the path's y values above the well floor. */
  function surface(t: number) {
    const ys = [...openingLiquid(t, well, randomSlosh()).matchAll(/[LQ ]-?[\d.]+ (-?[\d.]+)/g)].map(match => Number(match[1])).filter(y => y < well.bottom);
    return { top: Math.min(...ys), spread: Math.max(...ys) - Math.min(...ys) };
  }
  it('is empty before its turn', () => {
    expect(openingLiquid(-0.06, well, randomSlosh())).toBe('M0 0');
    expect(openingLiquid(0, well, randomSlosh())).toBe('M0 0');
  });
  it('leans while it sloshes and comes to rest flat on the final level', () => {
    // A quarter period after arrival the first lean is near its peak.
    expect(surface(0.75).spread).toBeGreaterThan(4.5);
    const rest = surface(6);
    expect(rest.top).toBeCloseTo(well.bottom - well.level, 2);
    // Only the 4pt soft corners remain below the top edge.
    expect(rest.spread).toBeCloseTo(4, 2);
  });
});
