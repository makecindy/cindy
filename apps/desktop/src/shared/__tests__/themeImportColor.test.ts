import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  isDarkBackground,
  mix,
  parseCssColor,
  shade,
  toHex,
  toHslTriplet,
  toRgbaString,
} from '../theme-import/color';

describe('theme-import 颜色解析', () => {
  it.each([
    ['#282c34', { r: 40, g: 44, b: 52 }],
    ['282c34', { r: 40, g: 44, b: 52 }],
    ['#333', { r: 51, g: 51, b: 51 }],
    ['#FFF', { r: 255, g: 255, b: 255 }],
    // 8 位 hex：VSCode 主题里的半透明边框，剥掉 alpha 当实色用。
    ['#30363d80', { r: 48, g: 54, b: 61 }],
    // 4 位简写同理。
    ['#333a', { r: 51, g: 51, b: 51 }],
    ['rgb(97, 175, 239)', { r: 97, g: 175, b: 239 }],
    ['rgba(97, 175, 239, 0.5)', { r: 97, g: 175, b: 239 }],
  ])('解析 %s', (input, expected) => {
    expect(parseCssColor(input)).toEqual(expected);
  });

  // 回归:百分号通道是 0-100% → 0-255，不能当原值用（`rgb(100%,0%,0%)` 是纯红，
  // 按原值会解析成 {r:100} 这个几乎全黑的暗红）。
  it.each([
    ['rgb(100%, 0%, 0%)', { r: 255, g: 0, b: 0 }],
    ['rgb(0%, 100%, 0%)', { r: 0, g: 255, b: 0 }],
    ['rgb(50%, 50%, 50%)', { r: 128, g: 128, b: 128 }],
    ['rgba(100%, 100%, 100%, 0.5)', { r: 255, g: 255, b: 255 }],
  ])('解析百分号通道 %s', (input, expected) => {
    expect(parseCssColor(input)).toEqual(expected);
  });

  it('解析 hsl()（Obsidian 主题常用 hsl(var(--accent-h) ...) 展开后的形态）', () => {
    expect(parseCssColor('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor('hsl(0, 0%, 0%)')).toEqual({ r: 0, g: 0, b: 0 });
    // 空格分隔的现代语法也要认。
    expect(parseCssColor('hsl(120 100% 50%)')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it.each([
    ['color-mix(in srgb, #000 12%, transparent)'],
    ['var(--undefined-var)'],
    ['transparent'],
    ['currentColor'],
    [''],
    ['   '],
  ])('无法静态求值的 %s 返回 null（绝不猜值）', (input) => {
    expect(parseCssColor(input)).toBeNull();
  });

  it('非字符串输入返回 null', () => {
    expect(parseCssColor(undefined)).toBeNull();
    expect(parseCssColor(null)).toBeNull();
  });
});

describe('theme-import HSL 三元组换算', () => {
  it.each([
    // one-dark-pro.ts 里手写的精确换算样本（该主题的 HSL 与 hex 严格对应）。
    ['#282c34', '220 13% 18%'],
    ['#abb2bf', '219 14% 71%'],
    ['#ffffff', '0 0% 100%'],
    ['#000000', '0 0% 0%'],
  ])('%s → %s', (hex, expected) => {
    const rgb = parseCssColor(hex);
    expect(rgb).not.toBeNull();
    expect(toHslTriplet(rgb!)).toBe(expected);
  });

  it('格式与既有主题一致：三段、带百分号、整数', () => {
    expect(toHslTriplet({ r: 13, g: 17, b: 23 })).toMatch(/^\d+ \d+% \d+%$/);
  });
});

describe('theme-import 输出格式', () => {
  it('toHex 输出小写 6 位', () => {
    expect(toHex({ r: 40, g: 44, b: 52 })).toBe('#282c34');
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  it('toRgbaString 与既有主题 drop-overlay-bg 的书写形态一致', () => {
    expect(toRgbaString({ r: 97, g: 175, b: 239 }, 0.1)).toBe('rgba(97, 175, 239, 0.1)');
  });
});

describe('theme-import 派生与判定', () => {
  it('shade 正向提亮、负向压暗，且不越界', () => {
    expect(shade({ r: 100, g: 100, b: 100 }, 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(shade({ r: 100, g: 100, b: 100 }, -1)).toEqual({ r: 0, g: 0, b: 0 });
    const lighter = shade({ r: 40, g: 44, b: 52 }, 0.1);
    expect(lighter.r).toBeGreaterThan(40);
  });

  it('mix 两端取值正确', () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 100, g: 200, b: 50 };
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
    expect(mix(a, b, 0.5)).toEqual({ r: 50, g: 100, b: 25 });
  });

  it('isDarkBackground 判定常见主题底色', () => {
    expect(isDarkBackground({ r: 40, g: 44, b: 52 })).toBe(true); // #282c34
    expect(isDarkBackground({ r: 250, g: 250, b: 250 })).toBe(false); // #FAFAFA
    expect(isDarkBackground({ r: 253, g: 246, b: 227 })).toBe(false); // solarized base3
  });

  it('contrastRatio 黑白为 21:1', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1);
  });
});
