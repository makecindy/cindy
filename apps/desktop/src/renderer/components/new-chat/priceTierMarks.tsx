/**
 * 行内价格档串 —— 模型选择器与设置页 → 模型列表**共用同一份实现**。
 *
 * 原先只长在 `UnifiedModelRow.tsx` 里。设置页要显示同样的价格档时，如果各写一份，
 * 两边必然漂（点亮公式、裁切基准、徽标底色浓度都是容易各自微调的地方），而这一列的
 * 产品要求恰恰是「和选择器一模一样」。所以抽到这里，两处都从这里 import。
 *
 * 语义（Chris 2026-08-14 裁决，第二版）：**颜色只由点亮格数决定** —— 亮 1 格绿、
 * 2 格黄、3 格红，与模型档位无关。`$$$` 打六折亮两格就是黄，`$$` 打六折亮一格就是绿；
 * 无折扣行全亮，自然落回档位色。精确省幅由 ↓X% 与悬停说明表达。
 */

import { EFFORT_TIER_COLORS, PRICE_TIER_COLORS } from '@/themes/effortTierColors';

/**
 * 不传 = 无报价，调用方**不要渲染任何价格节点**（别把每行都加宽）。
 */
export interface UnifiedRowPriceDisplay {
  kind: 'free' | 'tier';
  /** 符号个数:按标准价分档(折扣不改变)。 */
  tier?: 1 | 2 | 3;
  /**
   * 档串用的货币符号,按**该行报价的币种**取(CNY → ¥、USD → $)。设计稿里中文报价
   * 是 ¥¥¥,写死 $ 会让国内用户看到一串对不上账单的美元号。
   */
  symbol?: string;
  /** 折扣行:折后价占比(0-100,亮段宽度);无折扣不传。 */
  paidPct?: number;
  /** 折扣行:↓X% 的 X。 */
  discountPct?: number;
  /** 已本地化的悬停说明(折扣幅度全文)。 */
  title?: string;
}

/**
 * $ 档串节点 —— classic 与 badge **共用同一份结构**,两套样式的差别只有三处,全部参数化:
 * 点亮量公式、亮段裁切百分比的字符串格式、要不要把点亮量暴露成 `data-price-lit`。
 * (抽出来之前是逐字复制的两段 ~55 行,改一处必漏另一处。)
 */
export function PriceTierMarks({
  priceDisplay,
  symbol,
  tier,
  litOf,
  formatClipPct,
  exposeLit,
}: {
  priceDisplay: UnifiedRowPriceDisplay;
  symbol: string;
  tier: 1 | 2 | 3;
  /** 点亮量(单位:字符数)。classic 整格(≥1),badge 允许半格(≥0.5)。 */
  litOf: (paidPct: number, tier: 1 | 2 | 3) => number;
  /** 亮段裁切百分比的字符串格式:classic 不带小数,badge 一位小数(既有 DOM 断言按此)。 */
  formatClipPct: (pct: number) => string;
  /** badge 才把点亮量暴露成 `data-price-lit`(调试 / 测试锚点)。 */
  exposeLit: boolean;
}) {
  const marks = symbol.repeat(tier);
  const { paidPct, discountPct } = priceDisplay;
  return (
    <span
      data-price-tier
      className="flex shrink-0 items-center gap-1"
      {...(priceDisplay.title ? { title: priceDisplay.title } : {})}
    >
      {paidPct !== undefined && discountPct !== undefined ? (
        (() => {
          const lit = litOf(paidPct, tier);
          // 颜色按点亮字符数四舍五入取 1 绿 / 2 黄 / 3 红(见 UnifiedRowPriceDisplay 头注)。
          const colorTier = Math.min(3, Math.max(1, Math.round(lit))) as 1 | 2 | 3;
          return (
            <>
              <span
                aria-hidden
                className="relative inline-block text-11 font-semibold leading-none tracking-[0.5px]"
              >
                <span className="invisible">{marks}</span>
                <span className="absolute inset-0 text-[var(--text-tertiary)] opacity-55">
                  {marks}
                </span>
                <span
                  {...(exposeLit ? { 'data-price-lit': lit.toFixed(2) } : {})}
                  className="absolute inset-0"
                  style={{
                    color: PRICE_TIER_COLORS[`t${colorTier}`],
                    // 裁切百分比必须以**档串自身宽度**为基准。曾经给档串套过一层定宽外层
                    // 做表格对齐,裁切基准跟着变成外层,↓50% 只灰掉一小截。
                    clipPath: `inset(0 ${formatClipPct(100 - (lit / tier) * 100)}% 0 0)`,
                  }}
                >
                  {marks}
                </span>
              </span>
              <span
                data-discount-badge
                // 设计稿 `.badge.save-tint`:淡染胶囊(14% 底 + 同色字),不是裸绿字 ——
                // 裸字在长模型名旁边会被读成名字的一部分。
                className="inline-flex shrink-0 items-center rounded-full px-2 py-[1px] text-10 font-medium leading-[1.45]"
                style={{
                  color: EFFORT_TIER_COLORS.low,
                  backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
                }}
              >
                {`↓${discountPct}%`}
              </span>
            </>
          );
        })()
      ) : (
        // 无折扣:全格点亮 → 颜色按格数(1 绿 / 2 黄 / 3 红),与折扣行同一条规则。
        <span
          className="text-11 font-semibold leading-none tracking-[0.5px]"
          style={{ color: PRICE_TIER_COLORS[`t${tier}`] }}
        >
          {marks}
        </span>
      )}
    </span>
  );
}

/** 整格点亮(classic,Chris 2026-08-14 第二版):亮几格 = round(实付比例 × 格数),至少 1 格。 */
export const litWholeMarks = (paidPct: number, tier: 1 | 2 | 3): number =>
  Math.min(tier, Math.max(1, Math.round((paidPct / 100) * tier)));

/**
 * 按比例点亮(badge,Chris 2026-08-16 裁决):亮宽 = 档数 × 实付比例,**下限 0.5 个字符**
 * (↓85% 这类只按比例会剩一条彩缝,太少上色很怪)。
 */
export const litFractionalMarks = (paidPct: number, tier: 1 | 2 | 3): number =>
  Math.min(tier, Math.max(0.5, (paidPct / 100) * tier));

/**
 * 「限时免费」淡染徽标 —— 与折扣胶囊同一套形制(14% 底 + 同色字)，两处都要用，
 * 所以也收在这里。文案由调用方传（i18n 在组件外解析）。
 */
export function PriceFreeBadge({ label }: { label: string }) {
  return (
    <span
      data-price-free
      className="inline-flex shrink-0 items-center rounded-full px-2 py-[1px] text-10 font-medium leading-[1.45]"
      style={{
        color: EFFORT_TIER_COLORS.low,
        backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}
