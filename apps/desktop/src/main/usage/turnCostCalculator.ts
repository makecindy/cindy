/**
 * 单轮费用计算。定价先看实际 billing route，再看模型；模型名不再决定来源。
 */

import {
  getModelPriceQuote,
  providerReferencePriceQuote,
} from '../../shared/modelPriceQuote.js';
import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  usdMoney,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels.js';
import type { ModelUsageDeltaEntry } from './modelUsageDelta.js';

const CODEX_BUDGET_PRICE_MULTIPLIER = 0.15;

export function getCodexBudgetEffectiveCostMultiplier(model: string): number {
  return model.startsWith('codex/') ? CODEX_BUDGET_PRICE_MULTIPLIER : 1;
}

export interface TurnTokenDeltas {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type BillingRoute =
  | 'xd-gateway'
  | 'provider-api'
  | 'subscription'
  | 'unknown';

export interface TurnPricingContext {
  providerId: string | null;
  billingRoute: BillingRoute;
}

export type TurnCostSource = 'sdk' | 'gateway' | 'sdk-fallback' | 'subscription';

export interface TurnCostResolution {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
}

export function normalizeModelIdForPricing(
  model: string | null | undefined,
): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'unknown';
  const stripped = trimmed.replace(/\[[^\]]*\]\s*$/, '').trim();
  return stripped || 'unknown';
}

export function isAnthropicModel(normalizedModel: string): boolean {
  return (
    normalizedModel.startsWith('claude-') ||
    normalizedModel === 'sonnet' ||
    normalizedModel === 'haiku' ||
    normalizedModel === 'opus'
  );
}

/**
 * token × quote → quote 币种金额。cache 价缺失时按输入价计，和详情文案一致。
 */
export function computeGatewayTurnCost(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
): number | null {
  if (!price) return null;
  const cacheReadPrice = price.cacheReadPerMtok ?? price.inputPerMtok;
  const cacheCreatePrice = price.cacheCreatePerMtok ?? price.inputPerMtok;
  return (
    (tokens.inputTokens * price.inputPerMtok +
      tokens.outputTokens * price.outputPerMtok +
      tokens.cacheReadTokens * cacheReadPrice +
      tokens.cacheCreateTokens * cacheCreatePrice) /
    1_000_000
  );
}

export function computePriceQuoteTurnMoney(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
): RegionalMoney | null {
  if (!price) return null;
  const amount = computeGatewayTurnCost(tokens, price);
  if (amount == null) return null;
  const valueEstimate = price.source === 'subscription-reference';
  return {
    amount: Math.max(0, amount),
    currency: price.currency,
    approximate: price.approximate || valueEstimate,
    kind: valueEstimate ? 'value-estimate' : 'actual-cost',
    ...(valueEstimate
      ? { estimateReasons: ['subscription-value', 'reference-price'] }
      : price.approximate
        ? { estimateReasons: ['reference-price'] }
        : {}),
  };
}

export function resolveTurnCost(args: {
  rawModel: string;
  tokens: TurnTokenDeltas;
  sdkCostDelta?: number;
  pricing: ModelPricingCatalog | null | undefined;
  context: TurnPricingContext;
}): TurnCostResolution {
  const { rawModel, tokens, sdkCostDelta, pricing, context } = args;
  const model = normalizeModelIdForPricing(rawModel);

  if (
    context.billingRoute === 'subscription' ||
    isSubscriptionDirectModel(model)
  ) {
    return { model, money: null, source: 'subscription' };
  }

  if (context.billingRoute === 'xd-gateway') {
    const quote = getModelPriceQuote(pricing, 'xd', model);
    if (quote) {
      return {
        model,
        money: computePriceQuoteTurnMoney(tokens, quote),
        source: 'gateway',
      };
    }
    // quote 缺失(冷缓存 / /models 同步失败 / 目录无该模型价):回退 SDK 自报
    // 数字,真实 gateway 计费不能整轮记 0。codex/ 预算路由的 SDK 数字未含 0.15
    // 折扣,这里补乘一次 —— gateway 价路径的价表已折好,两路互斥不双重打折。
    // 目录币种非 USD 时不回退:SDK 自报 USD 既不匹配网关价目、单位也对不上,
    // 记入即错标——按「无可靠报价」语义返回无金额(token 照常统计),与 codex
    // 无价条目的既有处理一致,也让单轮金额不可能混币种。
    const xdQuotes = pricing?.xd ? Object.values(pricing.xd) : [];
    if (xdQuotes.length > 0 && xdQuotes[0].currency !== 'USD') {
      return { model, money: null, source: 'sdk-fallback' };
    }
    const fallbackUsd =
      Math.max(0, sdkCostDelta ?? 0) *
      getCodexBudgetEffectiveCostMultiplier(model);
    return {
      model,
      money: fallbackUsd > 0 ? usdMoney(fallbackUsd) : null,
      source: 'sdk-fallback',
    };
  }

  const sdkAmount = Math.max(
    0,
    (sdkCostDelta ?? 0) * getCodexBudgetEffectiveCostMultiplier(model),
  );
  const money = sdkAmount > 0 ? usdMoney(sdkAmount) : null;
  return {
    model,
    money,
    source:
      context.billingRoute === 'provider-api' ? 'sdk' : 'sdk-fallback',
  };
}

export interface ResolvedModelCost {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
  deltas: TurnTokenDeltas;
}

export interface ClaudeTurnCostResolution {
  turnMoney: RegionalMoney | null;
  perModel: ResolvedModelCost[];
}

export function resolveClaudeTurnCostSinks(
  modelDeltas: ModelUsageDeltaEntry[],
  pricing: ModelPricingCatalog | null | undefined,
  context: TurnPricingContext,
): ClaudeTurnCostResolution {
  const perModel: ResolvedModelCost[] = [];
  const money: RegionalMoney[] = [];
  for (const delta of modelDeltas) {
    const tokens: TurnTokenDeltas = {
      inputTokens: delta.inputTokensDelta,
      outputTokens: delta.outputTokensDelta,
      cacheReadTokens: delta.cacheReadTokensDelta,
      cacheCreateTokens: delta.cacheCreateTokensDelta,
    };
    const resolved = resolveTurnCost({
      rawModel: delta.model,
      tokens,
      sdkCostDelta: delta.costUsdDelta,
      pricing,
      context,
    });
    perModel.push({
      model: resolved.model,
      money: resolved.money,
      source: resolved.source,
      deltas: tokens,
    });
    if (resolved.money && resolved.money.amount > 0) money.push(resolved.money);
  }
  if (money.length === 0) return { turnMoney: null, perModel };
  // 非 USD 目录下若某模型缺报价,其 SDK fallback 段是 USD——同轮混币种时按
  // gateway 报价段的币种聚合、弃掉冲突段(单币种账本约束),绝不能 throw
  // 打断 turn 收尾管道。
  const preferredCurrency: MoneyCurrency =
    perModel.find((item) => item.source === 'gateway' && item.money)?.money
      ?.currency ?? money[0].currency;
  return {
    turnMoney: addCompatibleRegionalMoney(money, preferredCurrency),
    perModel,
  };
}

export function estimateClaudeSubscriptionTurnValue(
  perModel: ResolvedModelCost[],
): RegionalMoney | null {
  const values: RegionalMoney[] = [];
  for (const item of perModel) {
    if (!isAnthropicModel(item.model) || item.money?.amount) continue;
    const quote = providerReferencePriceQuote('anthropic', item.model);
    if (!quote) continue;
    const value = computePriceQuoteTurnMoney(item.deltas, quote);
    if (value && value.amount > 0) values.push(value);
  }
  return values.length > 0 ? addRegionalMoney(values) : null;
}

export function buildClaudeTurnUsageDetails(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined,
  deltas: ModelUsageDeltaEntry[] | undefined,
  fallbackModel: string,
  perModel?: ResolvedModelCost[],
): TurnUsageDetails | null {
  const hasModelUsageDeltas = Boolean(deltas && deltas.length > 0);
  const perModelCost = perModel
    ?.filter((item) => item.money && item.money.amount > 0)
    .map((item) => ({ model: item.model, money: item.money! }));
  return buildTurnUsageDetails({
    inputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.inputTokensDelta, 0)
      : usage?.input_tokens,
    outputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.outputTokensDelta, 0)
      : usage?.output_tokens,
    cacheReadTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.cacheReadTokensDelta, 0)
      : usage?.cache_read_input_tokens,
    cacheCreateTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.cacheCreateTokensDelta, 0)
      : usage?.cache_creation_input_tokens,
    model:
      deltas?.length === 1
        ? deltas[0].model
        : hasModelUsageDeltas
          ? undefined
          : fallbackModel,
    models: hasModelUsageDeltas ? deltas?.map((delta) => delta.model) : undefined,
    perModelCost:
      perModelCost && perModelCost.length > 0 ? perModelCost : undefined,
  });
}
