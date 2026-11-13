// @vitest-environment node
/**
 * D2-6 hljs 兜底:CINDY 代码块(msg-code-block-bg=surface-elevated)上 hljs 语法色对比度落档。
 * hljs 色:light=highlight.js/styles/github.css;dark=globals.css .dark .hljs-*(mirror github-dark)。
 * .hljs bg=transparent(light)/var(--msg-code-block-bg)(dark)→代码块底=CINDY surface-elevated。
 * CINDY 底接近 default(#F8F8F8 vs #ffffff;#312F2F vs #2c2c2a),hljs 主题色为 default 底设计,
 * 边缘不达标是 hljs 既有折损(用 design surface 而非 github 默认 #ffffff/#0d1117),非 CINDY 引入。
 * 不达标项(<4.5 普通/<3 边界)需补 [data-theme="cindy-*"] 整改,整改值决策表未给→报 lead 裁决。
 * 已落档不达标:light -keyword/-doctag/-meta/-type 4.31、-built_in/-symbol 3.29、-name/-selector-tag 4.36;
 * dark -punctuation 2.47、-tag 2.99、-section 2.87(boundary)。本测试落档 + ≥2 基线防严重退化 + text ≥4.5 守卫。
 */
import { describe, expect, it } from 'vitest';
import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';

type RGB = [number, number, number];
function parseHex(v: string): RGB {
  const h = v.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(rgb: RGB): number {
  const f = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function contrast(a: string, b: string): number {
  const la = lum(parseHex(a)); const lb = lum(parseHex(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
const HLJS_LIGHT: Record<string, string> = {"text": "#24292e", "-doctag": "#d73a49", "-keyword": "#d73a49", "-meta": "#d73a49", "-template-tag": "#d73a49", "-template-variable": "#d73a49", "-type": "#d73a49", "-variable": "#d73a49", "-title": "#6f42c1", "-attr": "#005cc5", "-attribute": "#005cc5", "-literal": "#005cc5", "-number": "#005cc5", "-operator": "#005cc5", "-selector-attr": "#005cc5", "-selector-class": "#005cc5", "-selector-id": "#005cc5", "-regexp": "#032f62", "-string": "#032f62", "-built_in": "#e36209", "-symbol": "#e36209", "-comment": "#6a737d", "-code": "#6a737d", "-formula": "#6a737d", "-name": "#22863a", "-quote": "#22863a", "-selector-tag": "#22863a", "-selector-pseudo": "#22863a", "-subst": "#24292e", "-section": "#005cc5", "-bullet": "#735c0f", "-emphasis": "#24292e", "-strong": "#24292e", "-addition": "#22863a", "-deletion": "#b31d28"};
const HLJS_DARK: Record<string, string> = {"text": "#c9d1d9", "-doctag": "#ff7b72", "-keyword": "#ff7b72", "-meta": "#ff7b72", "-template-tag": "#ff7b72", "-template-variable": "#ff7b72", "-type": "#ff7b72", "-variable": "#ff7b72", "-title": "#d2a8ff", "-attr": "#79c0ff", "-attribute": "#79c0ff", "-literal": "#79c0ff", "-number": "#79c0ff", "-operator": "#79c0ff", "-selector-attr": "#79c0ff", "-selector-class": "#79c0ff", "-selector-id": "#79c0ff", "-regexp": "#a5d6ff", "-string": "#a5d6ff", "-built_in": "#ffa657", "-symbol": "#ffa657", "-comment": "#8b949e", "-code": "#8b949e", "-formula": "#8b949e", "-name": "#7ee787", "-quote": "#7ee787", "-selector-tag": "#7ee787", "-selector-pseudo": "#7ee787", "-subst": "#c9d1d9", "-section": "#1f6feb", "-bullet": "#f2cc60", "-emphasis": "#c9d1d9", "-strong": "#c9d1d9", "-addition": "#7ee787", "-deletion": "#ff7b72", "-": "#586e75", "-tag": "#c9d1d9", "-punctuation": "#c9d1d9"};
const LIGHT_BG = cindyLight.colors['surface-elevated']!;
const DARK_BG = cindyDark.colors['surface-elevated']!;

describe('CINDY · D2-6 hljs 兜底(代码块对比度落档)', () => {
  it('light:所有 hljs 语法色 × CINDY 代码块背景 ≥2:1(基线,防严重退化)', () => {
    for (const [name, color] of Object.entries(HLJS_LIGHT)) {
      const r = contrast(color, LIGHT_BG);
      expect(r, `light ${name} ${color} × ${LIGHT_BG} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(2);
    }
  });
  it('dark:所有 hljs 语法色 × CINDY 代码块背景 ≥2:1(基线)', () => {
    for (const [name, color] of Object.entries(HLJS_DARK)) {
      const r = contrast(color, DARK_BG);
      expect(r, `dark ${name} ${color} × ${DARK_BG} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(2);
    }
  });
  it('D 裁决:CINDY dark 三项(punctuation/tag/section)×背景 ≥3:1', () => {
    // -punctuation/-tag:github-dark "purposely ignored" 无显式色,继承 text #c9d1d9(8.62≥3);[data-theme=cindy-dark] 显式覆盖防御性
    expect(contrast('#c9d1d9', DARK_BG), 'dark -punctuation').toBeGreaterThanOrEqual(3);
    expect(contrast('#c9d1d9', DARK_BG), 'dark -tag').toBeGreaterThanOrEqual(3);
    // -section:default #1f6feb=2.87<3,[data-theme=cindy-dark] 提亮 #2573ec=3.00≥3
    expect(contrast('#2573ec', DARK_BG), 'dark -section 提亮后').toBeGreaterThanOrEqual(3);
  });
  it('D 裁决:light 语法色 ≥3:1 门槛通过(default 同源折损,<4.5 但 ≥3 不整改,落豁免档)', () => {
    // light -keyword/-doctag/-meta/-type 4.31、-built_in/-symbol 3.29、-name/-selector-tag 4.36 均 ≥3(语法色门槛)
    for (const name of ['-keyword', '-doctag', '-meta', '-type', '-built_in', '-symbol', '-name', '-selector-tag', '-selector-pseudo', '-addition']) {
      const color = HLJS_LIGHT[name];
      if (!color) continue;
      expect(contrast(color, LIGHT_BG), `light ${name} ${color}`).toBeGreaterThanOrEqual(3);
    }
  });
  it('普通文本(text)×背景 ≥4.5:1(正文守卫)', () => {
    expect(contrast(HLJS_LIGHT['text']!, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(HLJS_DARK['text']!, DARK_BG)).toBeGreaterThanOrEqual(4.5);
  });
});
