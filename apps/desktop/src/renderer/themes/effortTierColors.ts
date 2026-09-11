/**
 * effortTierColors —— 推理强度档位的运行时适配器（统一模型选择器
 * model-selector-unified §1.3）。静态值的唯一编辑源是
 * packages/design-tokens/src/reference/color.json；生成器把表写入 colors.ts。
 *
 * 为什么是「跨主题固定」的功能色而不是普通语义 token:
 *   档色表达的是**这一档有多强**,不是界面的明暗层次 —— 同一个 `high` 在 Light / Dark 下
 *   必须是同一个蓝,否则用户在两种主题间切换时会以为自己换了档。这与 DESIGN.md §10
 *   「语义豁免色(theme-invariant)」是同一类:值绑在事物本身、不绑主题。生成到
 *   colors.ts 的 EFFORT_TIER_COLORS 每项都以同值注册进 `effort-tier-*`，light / dark 一致。
 *
 * 静态表由 DTCG 经 Terrazzo 原位生成到 colors.ts；本模块只适配档位和插值。
 * 导入本模块会初始化同一 ColorRegistry（无 DOM / 磁盘访问），模块缓存保证只注册一次。
 * 插值仍直接拿 hex，不在拖动帧读取 computed style。
 *
 * 紫色只属于真正的顶档:色映射按**档位 key 绝对取值**,不按「该模型的第几档」相对取值 ——
 * 封顶 `high` 的模型拉满也是蓝,只有真的支持 `max` / `ultra` 的模型才出现紫(§1.3)。
 */

import { EFFORT_TIER_COLORS, PRICE_TIER_COLORS } from './colors';
export { EFFORT_TIER_COLORS, PRICE_TIER_COLORS };

/** 未知档位(服务端新下发、客户端还没认识)的兜底色 —— 落中间档,不谎报成顶档。 */
export const EFFORT_TIER_FALLBACK_COLOR = EFFORT_TIER_COLORS.medium;

// Fast(插队加速)开启态的蓝不在本表:它没有插值需求,数值直接注册成语义 token
// `--fast-accent`(colors.ts),组件一律 `var(--fast-accent)` 消费 —— TS 侧不再持有它的
// hex,也就不会出现「组件拿常量、主题拿 token」两条路各画各的。

/** 取某档位的绝对色;未知档回落中间档色。 */
export function effortTierColor(effort: string | null | undefined): string {
  if (!effort) return EFFORT_TIER_FALLBACK_COLOR;
  return (
    (EFFORT_TIER_COLORS as Record<string, string>)[effort] ?? EFFORT_TIER_FALLBACK_COLOR
  );
}

/** `#rrggbb` → [r,g,b];非法输入返回 null(调用方回落,不抛)。 */
function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/**
 * 两个 hex 之间线性插值(t 钳制到 0..1)。任一端非法则原样返回起点色。
 * 输出统一大写,与上面的常量表同形 —— 插值到端点时得到的串要能和表里的值直接比较。
 */
export function hexLerp(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const k = Math.min(1, Math.max(0, t));
  return `#${pa
    .map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/**
 * 连续档位坐标 `t`(0..n-1)上的条色 —— 拖动中每帧调用。
 * `t` 落在两档之间时取相邻两档色的插值;越界钳制到首 / 末档色。
 */
export function effortTierColorAt(stops: readonly string[], t: number): string {
  if (stops.length === 0) return EFFORT_TIER_FALLBACK_COLOR;
  const clamped = Math.min(stops.length - 1, Math.max(0, t));
  const i = Math.floor(clamped);
  const j = Math.min(stops.length - 1, i + 1);
  return hexLerp(effortTierColor(stops[i]), effortTierColor(stops[j]), clamped - i);
}
