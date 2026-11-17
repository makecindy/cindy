import { describe, expect, it } from 'vitest';

import { giftCardAmountArt, giftCardAmountLabel } from '../giftCardAmount';

describe('gift card amount on the face', () => {
  it('writes the amount with the currency symbol and without trailing zeros', () => {
    expect(giftCardAmountLabel('20', 'usd')).toBe('$20');
    expect(giftCardAmountLabel('20.000000000', 'USD')).toBe('$20');
    expect(giftCardAmountLabel('19.990000000', 'usd')).toBe('$19.99');
    expect(giftCardAmountLabel('100', 'cny')).toBe('¥100');
    expect(giftCardAmountLabel('1e3', 'usd')).toBeNull();
    expect(giftCardAmountLabel('', 'usd')).toBeNull();
  });

  it('places glyphs left to right and shrinks long amounts to stay on the card', () => {
    const short = giftCardAmountArt('cindy', '$20');
    const long = giftCardAmountArt('cindy', '$199.99');
    expect(short?.glyphs.map((glyph) => glyph.x)).toEqual([0, 946, 1958]);
    const scaleOf = (transform: string) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1]);
    expect(scaleOf(long!.transform)).toBeLessThan(scaleOf(short!.transform));
    // 象牙白卡面用墨色，其余用象牙白：两种卡面的金额颜色不同。
    expect(giftCardAmountArt('leap', '$20')?.fill).not.toBe(short?.fill);
  });

  // 回归：按字符个数估宽时，$1000 在铃铛卡面上会压到铃铛。金额必须按字形实际宽度收进
  // 每张卡面留给它的区域，位数再多也一样；常见的小面额保持原来的大小。
  it('keeps any amount inside the area each face leaves for it', () => {
    const room = { cindy: 430, cat: 480, bell: 440, leap: 500 };
    for (const [face, max] of Object.entries(room)) {
      for (const label of ['$1000', '\u00a51000', '$9999.99', '$100000']) {
        expect(giftCardAmountArt(face, label)!.width).toBeLessThanOrEqual(max);
      }
    }
    const scaleOf = (face: string, label: string) =>
      Number(/scale\(([\d.]+)\)/.exec(giftCardAmountArt(face, label)!.transform)?.[1]);
    for (const face of Object.keys(room)) {
      expect(scaleOf(face, '$100')).toBe(scaleOf(face, '$20'));
    }
    expect(scaleOf('bell', '$1000')).toBeLessThan(scaleOf('bell', '$100'));
  });

  it('declines faces and characters it cannot draw', () => {
    expect(giftCardAmountArt('unknown', '$20')).toBeNull();
    expect(giftCardAmountArt('cindy', 'USD 20')).toBeNull();
    expect(giftCardAmountArt('cindy', '')).toBeNull();
  });
});
