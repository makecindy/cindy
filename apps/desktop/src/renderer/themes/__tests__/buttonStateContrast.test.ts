/**
 * DS-4 Button 状态梯守卫。
 *
 * 起因是一个真实缺陷：`--button-primary-hover` 曾 alias 到 `--surface-hover`，而
 * 暗色下 `--surface-hover` 与 `--surface-chip`（primary 的 rest 底色）本就同值，
 * default-dark / cindy-dark / one-dark-pro / monokai-pro 四个主题的悬停完全没有反馈；
 * `--button-secondary-pressed` 同理与 hover 撞色。DESIGN.md §10 双模式交付门槛把
 * 「状态不可区分」定为真实缺陷，必须交付前修。
 *
 * 本守卫对**每个内置主题**逐档解析 rest → hover → pressed，要求相邻两档
 * 至少差 MIN_DELTA（单通道 8/255）。它是 Level 1 静态守卫，改任一状态 token
 * 或改任一主题的 chip / elevated / accent 值都会被它复核。
 *
 * 2026-10-22 起 CINDY 的标签底与文字是半透明墨水：按 CSS 规则（color-mix 预乘
 * alpha）解析后，再叠到按钮实际所在的页面与卡片上比较，两处都要可区分。
 */
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../color-registry';
import '../colors';
import { filledButtonHover, filledButtonPressed } from '../filledButtonStates';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { Theme } from '../types';

/** 单通道最小可见差；低于它人眼在实机上看不出状态变化。 */
const MIN_DELTA = 8;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Rgba extends Rgb {
  a: number;
}

function parseHex(value: string): Rgba {
  const hex = value.slice(1);
  const full = hex.length === 3 ? [...hex].map((d) => d.repeat(2)).join('') : hex;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

const MIX_RE = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+?)\)$/;
const VAR_RE = /^var\(--([a-z0-9-]+)\)$/;
const RGBA_RE = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/;
const HSL_VAR_RE = /^hsl\(var\(--([a-z0-9-]+)\)\)$/;
// themes/filledButtonStates.ts 的产物；形态变化时这里 fail closed，守卫会红。
const FILLED_STATE_RE =
  /^oklch\(from (.+?) calc\(sign\(max\(0, l - 0\.25\)\) \* \(l - ([\d.]+)\) \+ \(1 - sign\(max\(0, l - 0\.25\)\)\) \* ([\d.]+)\) c h\)$/;
const HSL_TRIPLET_RE = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?$/;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clampByte = (c: number) => Math.min(255, Math.max(0, c * 255));

/** 逐项对应 filledButtonStates.ts 的 calc；表达式形态变化时 FILLED_STATE_RE 先红。 */
function filledStateLightness(L: number, step: number, liftTo: number): number {
  const isLight = Math.sign(Math.max(0, L - 0.25));
  return isLight * (L - step) + (1 - isLight) * liftTo;
}

/** 在 OKLab 里改亮度（色度与色相不变，等价于 OKLCH 只动 L）。 */
function applyFilledState(color: Rgba, step: number, liftTo: number): Rgba {
  const [r, g, b] = [color.r, color.g, color.b].map((c) => toLinear(c / 255));
  const lms = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  const L = 0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2];
  const A = 1.9779984951 * lms[0] - 2.428592205 * lms[1] + 0.4505937099 * lms[2];
  const B = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.808675766 * lms[2];
  const next = filledStateLightness(L, step, liftTo);
  const l = (next + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (next - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (next - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: clampByte(toGamma(Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))),
    g: clampByte(toGamma(Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))),
    b: clampByte(toGamma(Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))),
    a: color.a,
  };
}

/**
 * 把一个 token 解析成带 alpha 的颜色。支持：hex 字面量、`rgb()/rgba()`、HSL 三元组
 * （可带 `/ alpha`）、`var(--x)` 转发、`color-mix(in srgb, A p%, B)`（DS-4 状态梯用的
 * 形态，允许嵌套；按 CSS Color 5 预乘 alpha 插值）。其余形态 fail closed —— 守卫宁可红，也不猜。
 */
function resolveRgba(theme: Theme, expr: string, depth = 0): Rgba {
  if (depth > 8) throw new Error(`token 解析层数过深: ${expr}`);
  const text = expr.trim();

  const varMatch = VAR_RE.exec(text);
  if (varMatch) {
    const next = resolveThemeValue(theme, varMatch[1]);
    if (next == null) throw new Error(`解析不到 token --${varMatch[1]}`);
    return resolveRgba(theme, next, depth + 1);
  }

  const mix = MIX_RE.exec(text);
  if (mix) {
    const first = resolveRgba(theme, mix[1], depth + 1);
    const second = resolveRgba(theme, mix[3], depth + 1);
    const k = Number(mix[2]) / 100;
    const a = first.a * k + second.a * (1 - k);
    const channel = (key: keyof Rgb) => (a === 0 ? 0 : (first[key] * first.a * k + second[key] * second.a * (1 - k)) / a);
    return { r: channel('r'), g: channel('g'), b: channel('b'), a };
  }

  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return parseHex(text);

  const rgba = RGBA_RE.exec(text);
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }

  const hslVar = HSL_VAR_RE.exec(text);
  if (hslVar) {
    const next = resolveThemeValue(theme, hslVar[1]);
    if (next == null) throw new Error(`解析不到 token --${hslVar[1]}`);
    return resolveRgba(theme, next, depth + 1);
  }

  const filled = FILLED_STATE_RE.exec(text);
  if (filled) {
    return applyFilledState(resolveRgba(theme, filled[1], depth + 1), Number(filled[2]), Number(filled[3]));
  }

  const triplet = HSL_TRIPLET_RE.exec(text);
  if (triplet) {
    const rgb = hslToRgb(Number(triplet[1]), Number(triplet[2]) / 100, Number(triplet[3]) / 100);
    return { ...rgb, a: triplet[4] === undefined ? 1 : Number(triplet[4]) };
  }
  throw new Error(`守卫不认识的颜色形态: ${text}`);
}

/** 把 token 叠到按钮所在的不透明底色上，得到屏幕上实际看到的颜色。 */
function tokenRgb(theme: Theme, id: string, base: Rgb): Rgb {
  const value = resolveThemeValue(theme, id);
  if (value == null) throw new Error(`主题 ${theme.id} 解析不到 --${id}`);
  const color = resolveRgba(theme, value);
  return {
    r: Math.round(color.r * color.a + base.r * (1 - color.a)),
    g: Math.round(color.g * color.a + base.g * (1 - color.a)),
    b: Math.round(color.b * color.a + base.b * (1 - color.a)),
  };
}

/** 按钮实际所在的底：页面与卡片，必须不透明。 */
const BASES = ['surface', 'surface-elevated'] as const;

function baseRgb(theme: Theme, id: (typeof BASES)[number]): Rgb {
  const value = resolveThemeValue(theme, id);
  if (value == null) throw new Error(`主题 ${theme.id} 解析不到 --${id}`);
  const color = resolveRgba(theme, value);
  if (color.a !== 1) throw new Error(`主题 ${theme.id} 的 --${id} 作底色必须不透明`);
  return color;
}

function delta(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** 与 components/ui/button.tsx 的 VARIANT_STYLES 一一对应。 */
const LADDERS = [
  { variant: 'primary', rest: 'surface-chip', hover: 'button-primary-hover', pressed: 'button-primary-pressed' },
  { variant: 'secondary', rest: 'surface-elevated', hover: 'button-secondary-hover', pressed: 'button-secondary-pressed' },
  { variant: 'cta', rest: 'accent-cta-bg-pure', hover: 'button-cta-hover', pressed: 'button-cta-pressed' },
  { variant: 'send', rest: 'send-btn-bg', hover: 'send-btn-hover-bg', pressed: 'send-btn-pressed-bg' },
  { variant: 'confirmation', rest: 'confirm-btn-primary-bg', hover: 'confirm-btn-primary-hover', pressed: 'confirm-btn-primary-pressed' },
  { variant: 'permission', rest: 'perm-allow-btn-bg', hover: 'perm-allow-btn-hover', pressed: 'perm-allow-btn-pressed' },
  { variant: 'danger-solid', rest: 'destructive', hover: 'button-danger-solid-hover', pressed: 'button-danger-solid-pressed' },
] as const;

const FILLED_VARIANTS = new Set<string>(['cta', 'send', 'confirmation', 'permission', 'danger-solid']);
const relativeLuminance = ({ r, g, b }: Rgb) =>
  0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);

describe('填充按钮的按下与悬停同向（DESIGN.md §4 Filled button states）', () => {
  // 守的是一个真实缺陷：cta 曾朝文字色混合，白字按钮悬停变深、按下反而变亮。
  for (const theme of Object.values(builtinThemes)) {
    for (const ladder of LADDERS.filter((item) => FILLED_VARIANTS.has(item.variant))) {
      it(`${theme.id} · ${ladder.variant}`, () => {
        const page = baseRgb(theme, 'surface');
        const [rest, hover, pressed] = [ladder.rest, ladder.hover, ladder.pressed].map((id) =>
          relativeLuminance(tokenRgb(theme, id, page)),
        );
        expect(Math.sign(pressed - hover)).toBe(Math.sign(hover - rest));
      });
    }
  }

  // 自定义主题的底色可以落在任何亮度，阈值附近不能混合出反向的中间值。
  it('亮度阈值两侧都同向', () => {
    const lightnessOf = (expression: string, L: number) => {
      const parts = FILLED_STATE_RE.exec(expression);
      if (!parts) throw new Error(`填充按钮状态表达式形态已变化: ${expression}`);
      return filledStateLightness(L, Number(parts[2]), Number(parts[3]));
    };
    for (let i = 2400; i <= 2600; i += 1) {
      const L = i / 10000;
      const hover = lightnessOf(filledButtonHover('var(--x)'), L);
      const pressed = lightnessOf(filledButtonPressed('var(--x)'), L);
      expect(Math.sign(pressed - hover), `L=${L}`).toBe(Math.sign(hover - L));
    }
  });
});

describe('DS-4 · Button 状态梯在每个内置主题都可区分', () => {
  it('状态 token 都已注册', () => {
    for (const ladder of LADDERS) {
      expect(colorRegistry.resolveDefault(ladder.hover, 'light'), ladder.hover).toBeTruthy();
      expect(colorRegistry.resolveDefault(ladder.pressed, 'light'), ladder.pressed).toBeTruthy();
    }
  });

  for (const theme of Object.values(builtinThemes)) {
    for (const ladder of LADDERS) {
      it(`${theme.id} · ${ladder.variant}：rest → hover → pressed 每档 ΔRGB ≥ ${MIN_DELTA}`, () => {
        for (const baseId of BASES) {
          const base = baseRgb(theme, baseId);
          const rest = tokenRgb(theme, ladder.rest, base);
          const hover = tokenRgb(theme, ladder.hover, base);
          const pressed = tokenRgb(theme, ladder.pressed, base);

          expect(
            delta(rest, hover),
            `${theme.id} ${ladder.variant} 在 ${baseId} 上悬停不可见：rest 与 hover 同色`,
          ).toBeGreaterThanOrEqual(MIN_DELTA);
          expect(
            delta(hover, pressed),
            `${theme.id} ${ladder.variant} 在 ${baseId} 上按下不可见：hover 与 pressed 同色`,
          ).toBeGreaterThanOrEqual(MIN_DELTA);
        }
      });
    }
  }

  it('自证伪：把 hover 换回撞色的 --surface-hover，暗色主题必然红', () => {
    const darkTheme = builtinThemes['default-dark'];
    expect(darkTheme).toBeTruthy();
    // 复刻修复前的绑定：primary hover alias 到 --surface-hover。
    const base = baseRgb(darkTheme!, 'surface');
    const rest = tokenRgb(darkTheme!, 'surface-chip', base);
    const brokenHover = tokenRgb(darkTheme!, 'surface-hover', base);
    expect(delta(rest, brokenHover)).toBeLessThan(MIN_DELTA);
  });

  it('自证伪：半透明标签底若不叠到底色上比较，CINDY 悬停差会被算错', () => {
    const theme = builtinThemes['cindy-light']!;
    // 黑 5% 与黑 ~11.6% 的 RGB 分量都是 0：只比 RGB 会误判为同色，叠色后才是真实差距。
    const rest = resolveRgba(theme, 'var(--surface-chip)');
    const hover = resolveRgba(theme, 'var(--button-primary-hover)');
    expect(delta(rest, hover)).toBe(0);
    const base = baseRgb(theme, 'surface');
    expect(delta(tokenRgb(theme, 'surface-chip', base), tokenRgb(theme, 'button-primary-hover', base))).toBeGreaterThanOrEqual(MIN_DELTA);
  });

  it('自证伪：不认识的颜色形态 fail closed，不静默放行', () => {
    const theme = builtinThemes["default-light"];
    expect(() => resolveRgba(theme, 'oklch(0.5 0.1 200)')).toThrow(/不认识的颜色形态/);
  });
});
