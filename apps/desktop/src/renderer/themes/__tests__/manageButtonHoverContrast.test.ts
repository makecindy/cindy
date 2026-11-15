/**
 * Ghost 管理小按钮（manage）hover 配对守卫（WCAG 1.4.11 非文本 ≥3:1）。
 *
 * 起因是 #5101 的真实回归：one-dark-pro 在 DS-8 注册了 `--sidebar-item-active-border`
 * （#61afef），而 GhostMainViewNavEntries.tsx 曾把同一 token 复用为该按钮的 hover 背景；
 * 按钮前景仍是 `--sidebar-item-active-foreground`（one-dark-pro 未覆盖，落到默认
 * `--foreground` ≈ #abb2bf 档），叠加后对比度 ≈1.1:1，远低于 DESIGN.md §10/§15
 * 反复援引的非文本 3:1 硬底——同一 token 同时服务"选中描边"与"hover 底"两个消费者，
 * 颜色语义打架。
 *
 * 修复：该按钮 hover 底与 border token 解耦，改用全仓同款柔和悬停底
 * `--surface-hover-soft`（非选中分支与 ModelSelector / PermissionSelector /
 * SidebarTopNav 均用它作 hover 底），border token 回归只服务描边消费者。
 *
 * 本守卫对**每个内置主题**锁定上述配对 ≥3:1；半透明墨水按 CSS 规则预乘 alpha，
 * 逐层叠到实际所在的底（侧栏面板 → 选中行填充）后再比较。解析器与守卫写法参照
 * buttonStateContrast.test.ts，叠色法参照 switchThemeContrast.test.ts。
 */
import { describe, expect, it } from 'vitest';

import { contrastRatio, hslToRgb, type Rgb } from '../../../shared/theme-import/color';
import { colorRegistry } from '../color-registry';
import '../colors';
import { builtinThemes } from '../registry';
import { resolveThemeValue } from '../theme-service';
import type { Theme } from '../types';

interface Rgba extends Rgb {
  a: number;
}

function parseHex(value: string): Rgba {
  const hex = value.slice(1);
  const full = hex.length === 3 ? [...hex].map((d) => d.repeat(2)).join('') : hex;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

const VAR_RE = /^var\(--([a-z0-9-]+)\)$/;
const MIX_RE = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+?)\)$/;
const RGBA_RE = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/;
const HSL_TRIPLET_RE = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?$/;

/**
 * 把一个 token 解析成带 alpha 的颜色。支持：hex 字面量、`rgb()/rgba()`、HSL 三元组
 * （可带 `/ alpha`）、`var(--x)` 转发、`color-mix(in srgb, A p%, B)`（允许嵌套；
 * 按 CSS Color 5 预乘 alpha 插值）。其余形态 fail closed —— 守卫宁可红，也不猜。
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

  const triplet = HSL_TRIPLET_RE.exec(text);
  if (triplet) {
    const rgb = hslToRgb(Number(triplet[1]), Number(triplet[2]) / 100, Number(triplet[3]) / 100);
    return { ...rgb, a: triplet[4] === undefined ? 1 : Number(triplet[4]) };
  }
  throw new Error(`守卫不认识的颜色形态: ${text}`);
}

/** 把 token 叠到其所在的不透明底色上，得到屏幕上实际看到的颜色。 */
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

/** manage 按钮实际所在的底：侧栏面板（最外层，必须不透明）→ 选中行填充。 */
const MANAGE_BACKDROP = ['sidebar', 'sidebar-item-active'] as const;

function backdropRgb(theme: Theme): Rgb {
  let base: Rgb | null = null;
  for (const id of MANAGE_BACKDROP) {
    const value = resolveThemeValue(theme, id);
    if (value == null) throw new Error(`主题 ${theme.id} 解析不到 --${id}`);
    const color = resolveRgba(theme, value);
    if (base === null) {
      if (color.a !== 1) throw new Error(`主题 ${theme.id} 的 --${id} 作最外层底色必须不透明`);
    }
    base = tokenRgb(theme, id, base ?? { r: 255, g: 255, b: 255 });
  }
  return base!;
}

describe('Ghost manage 按钮 hover 配对在每个内置主题 ≥3:1', () => {
  it('受管 token 均已注册（双模式）', () => {
    const ids = [...MANAGE_BACKDROP, 'surface-hover-soft', 'sidebar-item-active-foreground'] as const;
    for (const id of ids) {
      expect(colorRegistry.resolveDefault(id, 'light'), `${id} light`).toBeTruthy();
      expect(colorRegistry.resolveDefault(id, 'dark'), `${id} dark`).toBeTruthy();
    }
  });

  for (const theme of Object.values(builtinThemes)) {
    it(`${theme.id}：hover 前景 × 悬停底对比度 ≥ 3:1`, () => {
      const rowFill = backdropRgb(theme);
      const hoverBg = tokenRgb(theme, 'surface-hover-soft', rowFill);
      const fg = tokenRgb(theme, 'sidebar-item-active-foreground', hoverBg);

      const ratio = contrastRatio(fg, hoverBg);
      expect(ratio, `${theme.id} 管理按钮 hover 底 --surface-hover-soft 上的图标对比度 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });
  }

  it('自证伪：若 hover 底退回 --sidebar-item-active-border（#61afef），one-dark-pro 必然跌破 3:1', () => {
    const theme = builtinThemes['one-dark-pro']!;
    expect(theme).toBeTruthy();
    // 复刻修复前的复用：把该 token 当作 hover 底（当前按钮已解耦，仅证明守卫能抓住此回归）。
    const rowFill = backdropRgb(theme);
    const brokenHoverBg = tokenRgb(theme, 'sidebar-item-active-border', rowFill);
    const fg = tokenRgb(theme, 'sidebar-item-active-foreground', brokenHoverBg);
    expect(contrastRatio(fg, brokenHoverBg)).toBeLessThan(3);
  });

  it('自证伪：不认识的颜色形态 fail closed，不静默放行', () => {
    const theme = builtinThemes['default-light']!;
    expect(() => resolveRgba(theme, 'oklch(0.5 0.1 200)')).toThrow(/守卫不认识的颜色形态|不认识的颜色形态/);
  });
});
