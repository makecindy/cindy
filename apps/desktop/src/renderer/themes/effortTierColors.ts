/**
 * effortTierColors —— 推理强度**档位绝对色**的单一事实源(统一模型选择器
 * model-selector-unified §1.3)。
 *
 * 为什么是「跨主题固定」的功能色而不是普通语义 token:
 *   档色表达的是**这一档有多强**,不是界面的明暗层次 —— 同一个 `high` 在 Light / Dark 下
 *   必须是同一个蓝,否则用户在两种主题间切换时会以为自己换了档。这与 DESIGN.md §10
 *   「语义豁免色(theme-invariant)」是同一类:值绑在事物本身、不绑主题。故下表的每个
 *   hex 都以同值注册进 colors.ts(`effort-tier-*`),light / dark 一致。
 *
 * 为什么表放在这里、而不是只写在 colors.ts 里:
 *   滑杆拖动时条色要在**相邻档色之间逐像素插值**(§1.3「拖动中滑块连续跟手、条色按位置
 *   在相邻档色值间连续过渡」),插值必须拿到数值 hex —— CSS 变量在拖动帧里读 computed
 *   style 既贵又会被主题层间接引用打断。所以数值表在 TS 里定义一次,colors.ts 从这里
 *   `import` 去注册 token,组件从这里取值做插值:**两处同源,不可能漂移**。
 *
 * 紫色只属于真正的顶档:色映射按**档位 key 绝对取值**,不按「该模型的第几档」相对取值 ——
 * 封顶 `high` 的模型拉满也是蓝,只有真的支持 `max` / `ultra` 的模型才出现紫(§1.3)。
 */

/**
 * 档位 key → 绝对色。键集覆盖 `EFFORT_VALUES` 全部七档:
 *   - `minimal` 与 `low` 同绿:两者都在「更高效」那一端,产品文案上也常合并表达;
 *     给 minimal 单独造一个色只会在同一段色带里塞进第二个难分辨的绿。
 *   - `ultra` 与 `max` 同紫:规格 §1.3 明写 `max·ultra` 共用顶档紫。
 */
export const EFFORT_TIER_COLORS = {
  minimal: '#2AAE5B',
  low: '#2AAE5B',
  medium: '#14B8A6',
  high: '#3B82F6',
  xhigh: '#4F46E5',
  max: '#8B5CF6',
  ultra: '#8B5CF6',
} as const satisfies Record<string, string>;

/** 未知档位(服务端新下发、客户端还没认识)的兜底色 —— 落中间档,不谎报成顶档。 */
export const EFFORT_TIER_FALLBACK_COLOR = EFFORT_TIER_COLORS.medium;

// Fast(插队加速)开启态的蓝不在本表:它没有插值需求,数值直接注册成语义 token
// `--fast-accent`(colors.ts),组件一律 `var(--fast-accent)` 消费 —— TS 侧不再持有它的
// hex,也就不会出现「组件拿常量、主题拿 token」两条路各画各的。

/**
 * 价格档($ 串)的档位色 —— 设计稿 v4 定稿(saveStyle F)的三档:便宜绿 / 中档琥珀 /
 * 高价红。与档位色同理是跨主题固定的功能色(价格档表达「这个模型贵不贵」,不随明暗
 * 主题变),同值注册进 colors.ts(`price-tier-*`)。t1 与推理强度 low 共用同一支绿 ——
 * 折扣填充亮段也是它,同一支绿在面板里统一表达「省」。
 */
export const PRICE_TIER_COLORS = {
  t1: EFFORT_TIER_COLORS.low,
  t2: '#B58A1F',
  t3: '#C05353',
} as const satisfies Record<string, string>;

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
