/**
 * claudeSubscriptionValue — Claude 订阅(Anthropic OAuth)会话的「本会话价值」估值定价。
 *
 * 订阅会话没有真实 API 账单(SDK 自报 cost=0),chip 上显示的 $ 是「这轮用量按
 * Anthropic API 牌价折算值多少钱」的参考价值,与 `sessions.total_cost_usd`(真实
 * spend)严格分离 —— 口径与 Codex 订阅估值(shared/codexSubscriptionValue.ts)一致。
 *
 * 选价顺序(main/register.ts 消费):
 *   1. LiteLLM 网关价表的精确 model id 条目(带 cache 读写档价,最准)
 *   2. 本表按模型家族兜底(网关离线 / 冷启动 / 无该行时)
 * 两级都 miss → 本轮不显示估值(绝不用 0 或错价误导)。
 */

import { claudeModelFamily } from './claudeSubscriptionUsage';

/** 与 main/usage/modelPricing 的 ModelPrice 同形(shared 不 import main,自declare)。 */
export interface ClaudeSubscriptionValuePrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok?: number;
  cacheCreateUsdPerMtok?: number;
}

/**
 * Anthropic 公开牌价(USD / Mtok),按模型家族。cacheRead = 0.1x input,
 * cacheCreate = 1.25x input(5m TTL 档),与 platform.claude.com 定价页一致。
 * 家族维度(而非精确版本号)是有意的:版本迭代(4-8 → 4-9)通常沿用同代牌价,
 * 精确价优先走网关价表,这里只兜底。
 */
export const CLAUDE_SUBSCRIPTION_VALUE_PRICING_BY_FAMILY: Record<
  string,
  ClaudeSubscriptionValuePrice
> = {
  fable: { inputUsdPerMtok: 10, outputUsdPerMtok: 50, cacheReadUsdPerMtok: 1, cacheCreateUsdPerMtok: 12.5 },
  mythos: { inputUsdPerMtok: 10, outputUsdPerMtok: 50, cacheReadUsdPerMtok: 1, cacheCreateUsdPerMtok: 12.5 },
  opus: { inputUsdPerMtok: 5, outputUsdPerMtok: 25, cacheReadUsdPerMtok: 0.5, cacheCreateUsdPerMtok: 6.25 },
  sonnet: { inputUsdPerMtok: 3, outputUsdPerMtok: 15, cacheReadUsdPerMtok: 0.3, cacheCreateUsdPerMtok: 3.75 },
  haiku: { inputUsdPerMtok: 1, outputUsdPerMtok: 5, cacheReadUsdPerMtok: 0.1, cacheCreateUsdPerMtok: 1.25 },
};

/** 归一化 model id → 家族兜底价;未识别家族 → undefined(调用方跳过本轮估值)。 */
export function getClaudeSubscriptionValueFallbackPrice(
  normalizedModel: string,
): ClaudeSubscriptionValuePrice | undefined {
  const family = claudeModelFamily(normalizedModel);
  if (!family) return undefined;
  return CLAUDE_SUBSCRIPTION_VALUE_PRICING_BY_FAMILY[family];
}
