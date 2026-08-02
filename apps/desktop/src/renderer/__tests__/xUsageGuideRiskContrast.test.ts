/**
 * X 用法与风险告知 —— 风险那两段的对比度守卫。
 *
 * 为什么单独立一条:这两段是「回帖公开」与「默认工作目录可能随之公开」,是用户绑定后
 * 必须读清的后果,而它们坐在 `--warning-bg-soft` 的橙色 alpha 底上 —— 底色一合成,
 * 前景色的对比度就跟卡底上的数字不一样了,光看 token 名判断不出来。
 *
 * 初版用了 `--text-secondary`,四种主题/模式下实测 2.09 ~ 3.96,全部低于正文 4.5:1。
 * DESIGN.md §15.5 的 U2 裁决**明确把它的低对比限定在「二级信息」**(cindy-dark.ts 就把
 * 这个 token 标成「直映: 二级信息; U2 例外」),而这两段不是二级信息。同一条裁决还写明
 * text-secondary 的值 "never darken unilaterally" —— 所以修法只能是在组件内换语义色,
 * 不能去动全局 token(#1347 review 由 codex 指出 P2)。
 *
 * **本测试从组件源码里读出风险块实际用的 token**,再按四种主题/模式算合成后的对比度。
 * 这样写而不是把 'text-primary' 硬编码进断言:硬编码的话,谁把组件改回
 * `--text-secondary`,这条用例照样绿 —— 那就不是锚点了。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cindyDark } from '../themes/builtin/cindy-dark';
import { cindyLight } from '../themes/builtin/cindy-light';
import { colorRegistry } from '../themes/color-registry';
// 触发整表 registerColor 注册,resolveDefault 才拿得到 default 主题的值。
import '../themes/colors';

const guideSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/settings/XUsageGuide.tsx'),
  'utf8',
);

/** 从源码里切出风险块(warning callout 那个 div 到它闭合前),读出正文用的颜色 token。 */
function riskBodyColorToken(): string {
  const start = guideSource.indexOf('bg-[var(--warning-bg-soft)]');
  expect(start, '找不到 warning callout —— 风险块的形态被改过, 请同步本测试').toBeGreaterThan(0);
  const block = guideSource.slice(start, start + 900);
  const tokens = [...block.matchAll(/text-\[var\(--([a-z0-9-]+)\)\]/g)].map((m) => m[1]!);
  // callout 里有图标色(warning-fg)和正文色,取正文那个(出现在 span 上、非 warning-fg)
  const bodyTokens = [...new Set(tokens.filter((t) => t !== 'warning-fg'))];
  expect(bodyTokens, '风险块里的正文颜色 token 应当只有一个').toHaveLength(1);
  return bodyTokens[0]!;
}

type RGB = [number, number, number];

function parseHex(v: string): RGB {
  const h = v.replace('#', '');
  const full = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba(r, g, b, a)` → [r,g,b,a]。warning-bg-soft 是 alpha 面,必须先合成再算对比度。 */
function parseRgba(v: string): { rgb: RGB; alpha: number } {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v.trim());
  expect(m, `warning-bg-soft 不是 rgba(): ${v}`).not.toBeNull();
  return {
    rgb: [Number(m![1]), Number(m![2]), Number(m![3])],
    alpha: m![4] === undefined ? 1 : Number(m![4]),
  };
}

function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as RGB;
}

function luminance(rgb: RGB): number {
  const f = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
}

function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** CINDY 主题没 override 的 token 落回 default(warning 系按规则 15 属语义豁免,不被 override)。 */
function resolve4(themeColors: Record<string, string> | null, id: string, mode: 'light' | 'dark'): string {
  const overridden = themeColors?.[id];
  if (overridden !== undefined) return overridden;
  const fallback = colorRegistry.resolveDefault(id, mode);
  expect(fallback, `token 未注册: ${id}`).not.toBeNull();
  return fallback!;
}

const SCENES = [
  { name: 'default light', colors: null, mode: 'light' as const },
  { name: 'default dark', colors: null, mode: 'dark' as const },
  { name: 'CINDY light', colors: cindyLight.colors as Record<string, string>, mode: 'light' as const },
  { name: 'CINDY dark', colors: cindyDark.colors as Record<string, string>, mode: 'dark' as const },
];

// 本组件渲染在两处:X 卡(surface-card-ivory)与首次绑定确认门(confirm-bg)。两处都要过。
const SURFACES = ['surface-card-ivory', 'confirm-bg'] as const;

describe('XUsageGuide 风险告知的对比度', () => {
  it('风险正文在四种主题/模式 × 卡底与弹窗底上都 ≥4.5:1(正文 AA)', () => {
    const token = riskBodyColorToken();
    const failures: string[] = [];
    for (const scene of SCENES) {
      const fg = parseHex(resolve4(scene.colors, token, scene.mode));
      const warn = parseRgba(resolve4(scene.colors, 'warning-bg-soft', scene.mode));
      for (const surface of SURFACES) {
        const base = parseHex(resolve4(scene.colors, surface, scene.mode));
        const ratio = contrast(fg, composite(warn.rgb, warn.alpha, base));
        if (ratio < 4.5) {
          failures.push(`${scene.name} × ${surface}: --${token} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures, `风险告知的对比度不达正文 AA:\n${failures.join('\n')}`).toEqual([]);
  });

  it('风险块不得退回 --text-secondary:U2 例外只覆盖二级信息', () => {
    // 单独钉一条:上一条是数值守卫,这条把「为什么不能用它」写成可执行的判据 ——
    // 万一将来 text-secondary 的值被调亮到刚好过 4.5,数值守卫会放它过去,
    // 但 §15.5 的语义边界(U2 只给二级信息)仍然不允许拿它承载必读风险。
    expect(riskBodyColorToken()).not.toBe('text-secondary');
  });
});
