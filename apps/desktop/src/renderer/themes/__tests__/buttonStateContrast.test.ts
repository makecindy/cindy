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
 */
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../color-registry';
import '../colors';
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

function parseHex(value: string): Rgb {
  const hex = value.slice(1);
  const full = hex.length === 3 ? [...hex].map((d) => d.repeat(2)).join('') : hex;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const MIX_RE = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+?)\)$/;
const VAR_RE = /^var\(--([a-z0-9-]+)\)$/;

/**
 * 把一个 token 解析成 RGB。支持三种形态：hex 字面量、`var(--x)` 转发、
 * `color-mix(in srgb, A p%, B)`（DS-4 状态梯用的形态，允许嵌套）。
 * 其余形态 fail closed —— 守卫宁可红，也不猜。
 */
function resolveRgb(theme: Theme, expr: string, depth = 0): Rgb {
  if (depth > 8) throw new Error(`token 解析层数过深: ${expr}`);
  const text = expr.trim();

  const varMatch = VAR_RE.exec(text);
  if (varMatch) {
    const next = resolveThemeValue(theme, varMatch[1]);
    if (next == null) throw new Error(`解析不到 token --${varMatch[1]}`);
    return resolveRgb(theme, next, depth + 1);
  }

  const mix = MIX_RE.exec(text);
  if (mix) {
    const a = resolveRgb(theme, mix[1], depth + 1);
    const b = resolveRgb(theme, mix[3], depth + 1);
    const k = Number(mix[2]) / 100;
    return {
      r: Math.round(a.r * k + b.r * (1 - k)),
      g: Math.round(a.g * k + b.g * (1 - k)),
      b: Math.round(a.b * k + b.b * (1 - k)),
    };
  }

  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return parseHex(text);
  throw new Error(`守卫不认识的颜色形态: ${text}`);
}

function tokenRgb(theme: Theme, id: string): Rgb {
  const value = resolveThemeValue(theme, id);
  if (value == null) throw new Error(`主题 ${theme.id} 解析不到 --${id}`);
  return resolveRgb(theme, value);
}

function delta(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** 与 components/ui/button.tsx 的 VARIANT_STYLES 一一对应。 */
const LADDERS = [
  { variant: 'primary', rest: 'surface-chip', hover: 'button-primary-hover', pressed: 'button-primary-pressed' },
  { variant: 'secondary', rest: 'surface-elevated', hover: 'button-secondary-hover', pressed: 'button-secondary-pressed' },
  { variant: 'cta', rest: 'accent-cta-bg-pure', hover: 'button-cta-hover', pressed: 'button-cta-pressed' },
] as const;

describe('DS-4 · Button 状态梯在每个内置主题都可区分', () => {
  it('六个状态 token 都已注册', () => {
    for (const ladder of LADDERS) {
      expect(colorRegistry.resolveDefault(ladder.hover, 'light'), ladder.hover).toBeTruthy();
      expect(colorRegistry.resolveDefault(ladder.pressed, 'light'), ladder.pressed).toBeTruthy();
    }
  });

  for (const theme of Object.values(builtinThemes)) {
    for (const ladder of LADDERS) {
      it(`${theme.id} · ${ladder.variant}：rest → hover → pressed 每档 ΔRGB ≥ ${MIN_DELTA}`, () => {
        const rest = tokenRgb(theme, ladder.rest);
        const hover = tokenRgb(theme, ladder.hover);
        const pressed = tokenRgb(theme, ladder.pressed);

        expect(
          delta(rest, hover),
          `${theme.id} ${ladder.variant} 悬停不可见：rest 与 hover 同色`,
        ).toBeGreaterThanOrEqual(MIN_DELTA);
        expect(
          delta(hover, pressed),
          `${theme.id} ${ladder.variant} 按下不可见：hover 与 pressed 同色`,
        ).toBeGreaterThanOrEqual(MIN_DELTA);
      });
    }
  }

  it('自证伪：把 hover 换回撞色的 --surface-hover，暗色主题必然红', () => {
    const darkTheme = builtinThemes['default-dark'];
    expect(darkTheme).toBeTruthy();
    // 复刻修复前的绑定：primary hover alias 到 --surface-hover。
    const rest = tokenRgb(darkTheme!, 'surface-chip');
    const brokenHover = tokenRgb(darkTheme!, 'surface-hover');
    expect(delta(rest, brokenHover)).toBeLessThan(MIN_DELTA);
  });

  it('自证伪：不认识的颜色形态 fail closed，不静默放行', () => {
    const theme = builtinThemes["default-light"];
    expect(() => resolveRgb(theme, 'oklch(0.5 0.1 200)')).toThrow(/不认识的颜色形态/);
  });
});
