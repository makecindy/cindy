import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import {
  resolveModelReferencePrice,
  type AgentKind,
  type ModelRegistry,
} from '@cindy/model-providers';

import type { ModelAccessGatewayModel } from './modelAccess.js';
import {
  gatewayCurrencyForRegion,
  type ModelPriceQuote,
  type ModelPricingCatalog,
} from './regionalMoney.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from './subscriptionModels.js';

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

function gatewayInputTokenPriceBands(
  model: ModelAccessGatewayModel,
): ModelPriceQuote['inputTokenPriceBands'] {
  const explicit = model.tieredPricing
    ?.map((tier) => {
      const inputPerMtok = perMtok(tier.inputCostPerToken);
      const outputPerMtok = perMtok(tier.outputCostPerToken);
      const cacheReadPerMtok = perMtok(tier.cacheReadInputTokenCost);
      const cacheCreatePerMtok = perMtok(tier.cacheCreationInputTokenCost);
      if (
        inputPerMtok === undefined &&
        outputPerMtok === undefined &&
        cacheReadPerMtok === undefined &&
        cacheCreatePerMtok === undefined
      ) {
        return null;
      }
      return {
        minInputTokens: tier.range[0],
        maxInputTokens: tier.range[1],
        ...(inputPerMtok !== undefined ? { inputPerMtok } : {}),
        ...(outputPerMtok !== undefined ? { outputPerMtok } : {}),
        ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
        ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
      };
    })
    .filter((tier): tier is NonNullable<typeof tier> => tier !== null);
  if (explicit?.length) return explicit;

  const thresholdBands = [
    {
      minInputTokens: 200_001,
      inputPerMtok: perMtok(model.inputCostPerTokenAbove200kTokens),
      outputPerMtok: perMtok(model.outputCostPerTokenAbove200kTokens),
      cacheReadPerMtok: perMtok(model.cacheReadInputTokenCostAbove200kTokens),
    },
    {
      minInputTokens: 272_001,
      inputPerMtok: perMtok(model.inputCostPerTokenAbove272kTokens),
      outputPerMtok: perMtok(model.outputCostPerTokenAbove272kTokens),
      cacheReadPerMtok: perMtok(model.cacheReadInputTokenCostAbove272kTokens),
    },
  ].filter(
    (tier) =>
      tier.inputPerMtok !== undefined ||
      tier.outputPerMtok !== undefined ||
      tier.cacheReadPerMtok !== undefined,
  );
  return thresholdBands.length > 0 ? thresholdBands : undefined;
}

/**
 * Cindy AI Gateway 的价格币种由构建 region 决定。CN /models 的数字原生是
 * CNY,Global 原生是 USD；条目缺少 currency 不改变该契约。
 */
/** 该条目是否会产生报价(与币种无关;目录币种裁决与覆盖率统计共用此判定)。 */
export function isPricedGatewayModel(model: ModelAccessGatewayModel): boolean {
  // 币种不影响“是否有价格”的判断，这里显式传值，避免计费 API 隐式回落 Global。
  return gatewayModelPriceQuote(model, 'global') !== undefined;
}

export function gatewayModelPriceQuote(
  model: ModelAccessGatewayModel,
  region: CindyRegion,
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
  const inputTokenPriceBands = gatewayInputTokenPriceBands(model);
  return {
    providerId: 'xd',
    modelId,
    currency: gatewayCurrencyForRegion(region),
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
    ...(inputTokenPriceBands ? { inputTokenPriceBands } : {}),
    ...(costDiscount !== undefined ? { costDiscount } : {}),
  };
}

export function gatewayPricingCatalog(
  models: readonly ModelAccessGatewayModel[],
  region: CindyRegion,
): ModelPricingCatalog {
  const xd: Record<string, ModelPriceQuote> = {};
  for (const model of models) {
    const quote = gatewayModelPriceQuote(model, region);
    if (quote) xd[quote.modelId] = quote;
  }
  return Object.keys(xd).length > 0 ? { xd } : {};
}

function referenceQuote(
  providerId: string,
  modelId: string,
  price: {
    inputPerMtok: number;
    outputPerMtok: number;
    cacheReadPerMtok?: number;
    cacheCreatePerMtok?: number;
    inputTokenPriceBands?: ModelPriceQuote['inputTokenPriceBands'];
  },
): ModelPriceQuote {
  return {
    providerId,
    modelId,
    currency: 'USD',
    source: 'provider-reference',
    approximate: true,
    ...price,
  };
}

export function providerReferencePriceQuote(
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  options: {
    agent?: AgentKind;
    inputTokens?: number;
    at?: string | Date;
    variant?: 'standard' | 'priority' | 'batch' | 'fast';
  } = {},
): ModelPriceQuote | undefined {
  const resolved = resolveModelReferencePrice(registry, providerId, modelId, options);
  if (!resolved) return undefined;
  const day =
    options.at instanceof Date
      ? options.at.toISOString().slice(0, 10)
      : typeof options.at === 'string'
        ? options.at.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
  const variant = options.variant ?? 'standard';
  const inputTokenPriceBands = resolved.route.referencePrices
    ?.filter(
      (price) =>
        price.variant === variant &&
        day >= price.effectiveFrom &&
        (price.effectiveUntil === undefined || day < price.effectiveUntil),
    )
    .map((price) => ({
      minInputTokens: price.minInputTokens ?? 0,
      ...(price.maxInputTokens !== undefined
        ? { maxInputTokens: price.maxInputTokens }
        : {}),
      inputPerMtok: price.inputPerMtok,
      outputPerMtok: price.outputPerMtok,
      ...(price.cacheReadPerMtok !== undefined
        ? { cacheReadPerMtok: price.cacheReadPerMtok }
        : {}),
      ...(price.cacheWritePerMtok !== undefined
        ? { cacheCreatePerMtok: price.cacheWritePerMtok }
        : {}),
    }))
    .sort((a, b) => a.minInputTokens - b.minInputTokens);
  return referenceQuote(providerId, modelId, {
    inputPerMtok: resolved.price.inputPerMtok,
    outputPerMtok: resolved.price.outputPerMtok,
    ...(resolved.price.cacheReadPerMtok !== undefined
      ? { cacheReadPerMtok: resolved.price.cacheReadPerMtok }
      : {}),
    ...(resolved.price.cacheWritePerMtok !== undefined
      ? { cacheCreatePerMtok: resolved.price.cacheWritePerMtok }
      : {}),
    ...(inputTokenPriceBands && inputTokenPriceBands.length > 1
      ? { inputTokenPriceBands }
      : {}),
  });
}

export function registryPricingCatalog(
  registry: ModelRegistry | null | undefined,
): ModelPricingCatalog {
  const catalog: ModelPricingCatalog = {};
  if (!registry) return catalog;
  for (const entry of registry.models) {
    for (const route of entry.routes) {
      const quote = providerReferencePriceQuote(route.providerId, route.modelId, registry);
      if (!quote) continue;
      (catalog[route.providerId] ??= {})[route.modelId] = quote;
    }
  }
  return catalog;
}

export function modelPricingKey(modelId: string, agent?: AgentKind): string {
  return agent ? `${modelId}\u0000${agent}` : modelId;
}

export function getModelPriceQuote(
  pricing: ModelPricingCatalog | null | undefined,
  providerId: string | null | undefined,
  modelId: string,
  agent?: AgentKind,
): ModelPriceQuote | undefined {
  const normalizedProvider = providerId?.trim();
  const normalizedModel = modelId.trim();
  if (!normalizedProvider || !normalizedModel) return undefined;
  const providerPricing = pricing?.[normalizedProvider];
  if (!providerPricing) return undefined;
  if (agent && providerPricing[modelPricingKey(normalizedModel, agent)]) {
    return providerPricing[modelPricingKey(normalizedModel, agent)];
  }
  if (providerPricing[normalizedModel]) return providerPricing[normalizedModel];
  if (normalizedProvider === 'openai' && normalizedModel.startsWith(CHATGPT_MODEL_PREFIX)) {
    const bareModel = normalizedModel.slice(CHATGPT_MODEL_PREFIX.length);
    if (agent && providerPricing[modelPricingKey(bareModel, agent)]) {
      return providerPricing[modelPricingKey(bareModel, agent)];
    }
    return providerPricing[bareModel];
  }
  return undefined;
}

export function subscriptionDirectPriceQuote(
  modelId: string,
  registry: ModelRegistry | null | undefined,
  agent?: AgentKind,
): ModelPriceQuote | undefined {
  if (modelId.startsWith(CHATGPT_MODEL_PREFIX)) {
    return providerReferencePriceQuote('openai', modelId, registry, { agent });
  }
  if (modelId.startsWith(XAI_MODEL_PREFIX)) {
    return providerReferencePriceQuote('xai', modelId, registry, { agent });
  }
  return undefined;
}
