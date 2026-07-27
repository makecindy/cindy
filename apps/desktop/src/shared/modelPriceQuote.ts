import { getClaudeSubscriptionValueFallbackPrice } from './claudeSubscriptionValue.js';
import { CODEX_SUBSCRIPTION_VALUE_PRICING } from './codexSubscriptionValue.js';
import type { ModelAccessGatewayModel } from './modelAccess.js';
import {
  GATEWAY_NATIVE_CURRENCY,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from './regionalMoney.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from './subscriptionModels.js';

const CODEX_BUDGET_PRICE_MULTIPLIER = 0.15;

const XAI_SUBSCRIPTION_VALUE_PRICING: Record<
  string,
  {
    inputPerMtok: number;
    outputPerMtok: number;
    cacheReadPerMtok?: number;
    cacheCreatePerMtok?: number;
  }
> = {
  'grok-4.5': { inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5 },
  'grok-4.3': { inputPerMtok: 3, outputPerMtok: 15 },
  'grok-4.20': { inputPerMtok: 3, outputPerMtok: 15 },
  'grok-code-fast': { inputPerMtok: 0.2, outputPerMtok: 1.5 },
};

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function perMtok(value: unknown): number | undefined {
  return isNonNegativeFinite(value) ? value * 1_000_000 : undefined;
}

function applyCodexBudgetDiscount(quote: ModelPriceQuote): ModelPriceQuote {
  if (!quote.modelId.startsWith('codex/')) return quote;
  return {
    ...quote,
    inputPerMtok: quote.inputPerMtok * CODEX_BUDGET_PRICE_MULTIPLIER,
    outputPerMtok: quote.outputPerMtok * CODEX_BUDGET_PRICE_MULTIPLIER,
    ...(quote.cacheReadPerMtok !== undefined
      ? { cacheReadPerMtok: quote.cacheReadPerMtok * CODEX_BUDGET_PRICE_MULTIPLIER }
      : {}),
    ...(quote.cacheCreatePerMtok !== undefined
      ? { cacheCreatePerMtok: quote.cacheCreatePerMtok * CODEX_BUDGET_PRICE_MULTIPLIER }
      : {}),
  };
}

function declaredCurrency(
  model: ModelAccessGatewayModel,
): MoneyCurrency | undefined {
  return model.currency === 'USD' || model.currency === 'CNY'
    ? model.currency
    : undefined;
}

/**
 * 目录级币种:本地记账账本(daily / session / schedule)都是单币种,逐条目
 * 混用币种会造成同端多币种金额被聚合层丢弃。规则:
 *   - 只有**会产生报价**的条目参与裁决:免费/无价条目本就不出报价,它们缺失
 *     currency 声明不能把整个目录钉回 USD、连带丢弃全部已声明的报价
 *     (对外 CNY 目录曾因此全军覆没,#587);
 *   - 未声明的计价条目恒为 Gateway 原生 USD(契约缺省),绝不被其它条目的声明改标;
 *   - 只有当每个计价条目都显式声明同一非 USD 币种时,目录才整体切换;
 *   - 与目录币种冲突的声明条目由 gatewayPricingCatalog 丢弃报价(退回 SDK
 *     实报 USD 兜底),而不是改标币种——错标单位正是本模块要杜绝的事。
 */
/** 该条目是否会产生报价(与币种无关;目录币种裁决与覆盖率统计共用此判定)。 */
export function isPricedGatewayModel(model: ModelAccessGatewayModel): boolean {
  return gatewayModelPriceQuote(model) !== undefined;
}

export function resolveGatewayCatalogCurrency(
  models: readonly ModelAccessGatewayModel[],
): MoneyCurrency {
  const priced = models.filter(isPricedGatewayModel);
  if (priced.length === 0) return GATEWAY_NATIVE_CURRENCY;
  const first = declaredCurrency(priced[0]);
  if (!first || first === GATEWAY_NATIVE_CURRENCY) return GATEWAY_NATIVE_CURRENCY;
  return priced.every((model) => declaredCurrency(model) === first)
    ? first
    : GATEWAY_NATIVE_CURRENCY;
}

export function gatewayModelPriceQuote(
  model: ModelAccessGatewayModel,
  currency: MoneyCurrency = GATEWAY_NATIVE_CURRENCY,
): ModelPriceQuote | undefined {
  const modelId = model.id.trim();
  const inputPerMtok = perMtok(model.inputCostPerToken);
  const outputPerMtok = perMtok(model.outputCostPerToken);
  if (!modelId || inputPerMtok === undefined || outputPerMtok === undefined) {
    return undefined;
  }
  const cacheReadPerMtok = perMtok(model.cacheReadInputTokenCost);
  const cacheCreatePerMtok = perMtok(model.cacheCreationInputTokenCost);
  if (
    inputPerMtok === 0 &&
    outputPerMtok === 0 &&
    (cacheReadPerMtok === undefined || cacheReadPerMtok === 0) &&
    (cacheCreatePerMtok === undefined || cacheCreatePerMtok === 0)
  ) {
    return undefined;
  }
  // quote 是用量估算用的标准价;costDiscount 只在 effectiveGatewayModelCost 侧应用到
  // cost,UI 展示价一致时取 cost(见 modelPriceFormat),不再并排展示标准价。
  // 币种由 resolveGatewayCatalogCurrency 目录级统一解析后传入;不按构建区域改标。
  return applyCodexBudgetDiscount({
    providerId: 'xd',
    modelId,
    currency,
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
  });
}

export function gatewayPricingCatalog(
  models: readonly ModelAccessGatewayModel[],
): ModelPricingCatalog {
  const currency = resolveGatewayCatalogCurrency(models);
  const xd: Record<string, ModelPriceQuote> = {};
  for (const model of models) {
    // 声明与目录币种冲突的条目不出报价:宁可让该模型的单轮费用退回 SDK
    // 实报 USD 兜底,也不给它标一个和价格数值不匹配的单位。
    const declared = declaredCurrency(model);
    if (declared && declared !== currency) continue;
    const quote = gatewayModelPriceQuote(model, currency);
    if (quote) xd[quote.modelId] = quote;
  }
  return Object.keys(xd).length > 0 ? { xd } : {};
}

function subscriptionQuote(
  providerId: string,
  modelId: string,
  price: {
    inputPerMtok: number;
    outputPerMtok: number;
    cacheReadPerMtok?: number;
    cacheCreatePerMtok?: number;
  },
): ModelPriceQuote {
  return {
    providerId,
    modelId,
    currency: 'USD',
    source: 'subscription-reference',
    approximate: true,
    ...price,
  };
}

export function providerReferencePriceQuote(
  providerId: string,
  modelId: string,
): ModelPriceQuote | undefined {
  if (providerId === 'anthropic') {
    const price = getClaudeSubscriptionValueFallbackPrice(modelId);
    if (!price) return undefined;
    return subscriptionQuote(providerId, modelId, {
      inputPerMtok: price.inputUsdPerMtok,
      outputPerMtok: price.outputUsdPerMtok,
      ...(price.cacheReadUsdPerMtok !== undefined
        ? { cacheReadPerMtok: price.cacheReadUsdPerMtok }
        : {}),
      ...(price.cacheCreateUsdPerMtok !== undefined
        ? { cacheCreatePerMtok: price.cacheCreateUsdPerMtok }
        : {}),
    });
  }
  if (providerId === 'openai') {
    const bareModel = modelId.startsWith(CHATGPT_MODEL_PREFIX)
      ? modelId.slice(CHATGPT_MODEL_PREFIX.length)
      : modelId;
    const price = CODEX_SUBSCRIPTION_VALUE_PRICING[bareModel];
    if (!price) return undefined;
    return subscriptionQuote(providerId, modelId, {
      inputPerMtok: price.inputUsdPerMtok,
      outputPerMtok: price.outputUsdPerMtok,
      ...(price.cacheReadUsdPerMtok !== undefined
        ? { cacheReadPerMtok: price.cacheReadUsdPerMtok }
        : {}),
      ...(price.cacheCreateUsdPerMtok !== undefined
        ? { cacheCreatePerMtok: price.cacheCreateUsdPerMtok }
        : {}),
    });
  }
  if (providerId === 'xai') {
    const bareModel = modelId.startsWith(XAI_MODEL_PREFIX)
      ? modelId.slice(XAI_MODEL_PREFIX.length)
      : modelId;
    const price = XAI_SUBSCRIPTION_VALUE_PRICING[bareModel];
    return price ? subscriptionQuote(providerId, modelId, price) : undefined;
  }
  return undefined;
}

export function getModelPriceQuote(
  pricing: ModelPricingCatalog | null | undefined,
  providerId: string | null | undefined,
  modelId: string,
): ModelPriceQuote | undefined {
  const normalizedProvider = providerId?.trim();
  const normalizedModel = modelId.trim();
  if (!normalizedProvider || !normalizedModel) return undefined;
  return (
    pricing?.[normalizedProvider]?.[normalizedModel] ??
    providerReferencePriceQuote(normalizedProvider, normalizedModel)
  );
}

export function subscriptionDirectPriceQuote(
  modelId: string,
): ModelPriceQuote | undefined {
  if (modelId.startsWith(CHATGPT_MODEL_PREFIX)) {
    return providerReferencePriceQuote('openai', modelId);
  }
  if (modelId.startsWith(XAI_MODEL_PREFIX)) {
    return providerReferencePriceQuote('xai', modelId);
  }
  return undefined;
}

