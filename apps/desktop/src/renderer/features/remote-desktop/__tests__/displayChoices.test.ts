import { describe, expect, it } from 'vitest';
import {
  fittedChoices,
  ratioLabel,
  recommendedFit,
  sameRatio,
  tagRecommendedModes,
} from '../displayChoices';

const listed = (choices: { width: number; height: number; tier?: string; current: boolean }[]) =>
  choices.map((choice) => [`${choice.width}x${choice.height}`, choice.tier, choice.current]);

describe('ratioLabel', () => {
  it('names familiar ratios and falls back to long edge per short edge', () => {
    expect(ratioLabel({ width: 2560, height: 1440 })).toBe('16:9');
    expect(ratioLabel({ width: 1440, height: 900 })).toBe('16:10');
    expect(ratioLabel({ width: 900, height: 1440 })).toBe('10:16');
    expect(ratioLabel({ width: 1512, height: 982 })).toBe('1.54:1');
  });
});

describe('sameRatio', () => {
  it('tolerates even-pixel rounding but not a different shape', () => {
    expect(sameRatio({ width: 1512, height: 982 }, { width: 1210, height: 786 })).toBe(true);
    expect(sameRatio({ width: 1600, height: 900 }, { width: 1600, height: 1000 })).toBe(false);
    expect(sameRatio(null, { width: 1, height: 1 })).toBe(false);
  });
});

describe('fitted sizes', () => {
  const macbook = { width: 1512, height: 982 };

  it('applies this screen’s own size first, or the host’s largest', () => {
    expect(recommendedFit(macbook, macbook)).toEqual(macbook);
    expect(recommendedFit({ width: 3440, height: 1440 }, { width: 3440, height: 1440 })).toEqual({
      width: 2560,
      height: 1072,
    });
  });

  it('offers more space only where a HiDPI screen keeps it sharp', () => {
    expect(listed(fittedChoices(macbook, macbook, macbook, 2))).toEqual([
      ['1210x786', 'larger', false],
      ['1512x982', 'same', true],
      ['1890x1228', 'more', false],
    ]);
    expect(listed(fittedChoices(macbook, macbook, macbook, 1))).toEqual([
      ['1210x786', 'larger', false],
      ['1512x982', 'same', true],
    ]);
  });

  it('merges sizes the host limit collapses and keeps a larger-text one', () => {
    const qhd = { width: 2560, height: 1440 };
    // More space would exceed the host's 2560 limit and lands on the same size.
    expect(listed(fittedChoices(qhd, qhd, qhd, 1.5))).toEqual([
      ['2048x1152', 'larger', false],
      ['2560x1440', 'same', true],
    ]);
    const wide = { width: 3440, height: 1440 };
    expect(listed(fittedChoices(wide, wide, { width: 2560, height: 1072 }, 1))).toEqual([
      ['2048x858', 'larger', false],
      ['2560x1072', 'max', true],
    ]);
  });

  it('calls a size the host limit shrank the largest, however slightly', () => {
    const screen = { width: 2600, height: 1625 };
    expect(listed(fittedChoices(screen, screen, { width: 2560, height: 1600 }, 1))).toEqual([
      ['2080x1300', 'larger', false],
      ['2560x1600', 'max', true],
    ]);
  });

  it('keeps a current size that is not recommended', () => {
    expect(listed(fittedChoices(macbook, macbook, { width: 1920, height: 1246 }, 1))).toEqual([
      ['1210x786', 'larger', false],
      ['1512x982', 'same', false],
      ['1920x1246', undefined, true],
    ]);
  });
});

describe('tagRecommendedModes', () => {
  it('marks the computer’s own modes close to a recommended size', () => {
    const modes = [
      { id: 'a', width: 1280, height: 720, current: false },
      { id: 'b', width: 1920, height: 1080, current: false },
      { id: 'c', width: 2560, height: 1440, current: true, native: true },
    ];
    expect(tagRecommendedModes(modes, { width: 2560, height: 1600 }, 1).map((m) => m.tier)).toEqual(
      [undefined, undefined, 'same'],
    );
    expect(tagRecommendedModes(modes, { width: 1600, height: 1000 }, 2).map((m) => m.tier)).toEqual(
      ['larger', 'more', undefined],
    );
  });
});
