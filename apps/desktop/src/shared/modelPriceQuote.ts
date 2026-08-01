import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { getClaudeSubscriptionValueFallbackPrice } from './claudeSubscriptionValue.js';
import { CODEX_SUBSCRIPTION_VALUE_PRICING } from './codexSubscriptionValue.js';
import type { ModelAccessGatewayModel } from './modelAccess.js';
import {
  gatewayCurrencyForRegion,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from './regionalMoney.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from './subscriptionModels.js';

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

function normalizedCostDiscount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

/** Gateway 原生币种优先；旧服务端未声明时才按构建 region 回退。 */
/** 该条目是否会产生报价(与币种无关;目录币种裁决与覆盖率统计共用此判定)。 */
export function isPricedGatewayModel(model: ModelAccessGatewayModel): boolean {
  // 币种不影响“是否有价格”的判断，这里显式传值，避免计费 API 隐式回落 Global。
  return gatewayModelPriceQuote(model, 'global') !== undefined;
}

/**
 * @param fallbackCurrency 该模型未声明 currency 时的回落币种。调用方(gatewayPricingCatalog)
 *   会传同一目录里已声明的币种，让整份目录保持单一币种；缺省才按区域回落。
 */
export function gatewayModelPriceQuote(
  model: ModelAccessGatewayModel,
  region: CindyRegion,
  fallbackCurrency?: MoneyCurrency,
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
  // quote 保留标准价供模型选择器展示原价；所有 Gateway 模型统一把
  // costDiscount 带入计费计算，CatalogModel.cost 继续承载折后展示价。
  const costDiscount = normalizedCostDiscount(model.costDiscount);
  return {
    providerId: 'xd',
    modelId,
    currency: model.currency ?? fallbackCurrency ?? gatewayCurrencyForRegion(region),
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
    ...(costDiscount !== undefined ? { costDiscount } : {}),
  };
}

export function gatewayPricingCatalog(
  models: readonly ModelAccessGatewayModel[],
  region: CindyRegion,
): ModelPricingCatalog {
  // 整份目录必须是单一币种。
  //
  // 同一账号的目录币种本就统一，所以个别模型省略 currency 时跟随同目录已声明的币种，
  // 而不是各自回落构建区域 —— 否则新旧字段混合的响应(一条声明 USD、一条省略)会产出
  // 跨币种目录，那些回落成区域币种的模型金额会被账本写入守卫当异币种丢弃。
  //
  // 出现两种以上显式声明则整份拒绝:此时 resolveGatewayAccountCurrency 已判定该目录不可信
  // 并让账本回退构建币种，若这里继续产出混币 catalog，非账本币种的那部分模型会被守卫
  // 选择性丢弃 —— 形成"按模型漏记账"，比整份没有报价更难发现。
  const declared = new Set(
    models
      .map((model) => model.currency)
      .filter((currency): currency is MoneyCurrency => currency === 'CNY' || currency === 'USD'),
  );
  if (declared.size > 1) return {};
  const fallbackCurrency = declared.values().next().value ?? gatewayCurrencyForRegion(region);
  const xd: Record<string, ModelPriceQuote> = {};
  for (const model of models) {
    const quote = gatewayModelPriceQuote(model, region, fallbackCurrency);
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

/**
 * 从报价目录推断当前账号的 Gateway 结算币种。
 *
 * 结算币种由服务端按账号所属租户下发,不保证等于客户端发行区域：多数账号跟随区域
 * (cn=CNY / global=USD),但也存在以 USD 结算的账号运行在 CN 构建上的正常情形。
 * 所以凡是需要判断"这个账号按什么币种记账"的地方都应问本函数,既不看 region,
 * 也不需要判断账号属于哪类租户。
 *
 * 同一账号的目录币种是统一的,所以任取一条即可;目录为空或出现混合币种(目录本身不可信)
 * 时返回 null,由调用方回落到构建默认值。与 main 侧 modelPricing.getGatewayAccountCurrency
 * 的判定口径一致。
 */
export function gatewayLedgerCurrency(
  pricing: ModelPricingCatalog | null | undefined,
): MoneyCurrency | null {
  const currencies = new Set(Object.values(pricing?.xd ?? {}).map((quote) => quote.currency));
  return currencies.size === 1 ? (currencies.values().next().value ?? null) : null;
}

export function subscriptionDirectPriceQuote(modelId: string): ModelPriceQuote | undefined {
  if (modelId.startsWith(CHATGPT_MODEL_PREFIX)) {
    return providerReferencePriceQuote('openai', modelId);
  }
  if (modelId.startsWith(XAI_MODEL_PREFIX)) {
    return providerReferencePriceQuote('xai', modelId);
  }
  return undefined;
}
