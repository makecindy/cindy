import {
  resolveModelReferencePrice,
  type AgentKind,
  type ModelRegistry,
} from '@cindy/model-providers';

import type { ModelAccessGatewayModel } from './modelAccess.js';
import {
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from './regionalMoney.js';
import {
  CHATGPT_MODEL_PREFIX,
  exclusiveXaiCatalogModelId,
  XAI_MODEL_PREFIX,
} from './subscriptionModels.js';

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

function gatewayPriorityInputTokenPriceBands(
  model: ModelAccessGatewayModel,
): ModelPriceQuote['inputTokenPriceBands'] {
  const thresholdBands = [
    {
      minInputTokens: 200_001,
      inputPerMtok: perMtok(model.inputCostPerTokenAbove200kTokensPriority),
      outputPerMtok: perMtok(model.outputCostPerTokenAbove200kTokensPriority),
      cacheReadPerMtok: perMtok(model.cacheReadInputTokenCostAbove200kTokensPriority),
    },
    {
      minInputTokens: 272_001,
      inputPerMtok: perMtok(model.inputCostPerTokenAbove272kTokensPriority),
      outputPerMtok: perMtok(model.outputCostPerTokenAbove272kTokensPriority),
      cacheReadPerMtok: perMtok(model.cacheReadInputTokenCostAbove272kTokensPriority),
    },
  ].filter(
    (tier) =>
      tier.inputPerMtok !== undefined ||
      tier.outputPerMtok !== undefined ||
      tier.cacheReadPerMtok !== undefined,
  );
  return thresholdBands.length > 0 ? thresholdBands : undefined;
}

/** 该条目是否会产生报价(与币种无关;目录币种裁决与覆盖率统计共用此判定)。 */
export function isPricedGatewayModel(model: ModelAccessGatewayModel): boolean {
  // 币种不影响“是否有价格”的判断，随便传一个具体币种即可。
  return gatewayModelPriceQuote(model, 'USD') !== undefined;
}

/**
 * @param fallbackCurrency 该模型未声明 currency 时的回落币种。调用方(gatewayPricingCatalog)
 *   先传同一目录里已声明的币种，让整份目录保持单一币种；整份都没声明时才传账本币种。
 * @param fallbackIsInferred fallbackCurrency 本身是否是猜出来的。为 true 时产出的报价带
 *   currencyInferred 标记，让下游金额降级成估算而不是冒充精确账单。
 */
export function gatewayModelPriceQuote(
  model: ModelAccessGatewayModel,
  fallbackCurrency: MoneyCurrency,
  fallbackIsInferred = false,
): ModelPriceQuote | undefined {
  const modelId = model.id.trim();
  const inputPerMtok = perMtok(model.inputCostPerToken);
  const outputPerMtok = perMtok(model.outputCostPerToken);
  if (!modelId || inputPerMtok === undefined || outputPerMtok === undefined) {
    return undefined;
  }
  const cacheReadPerMtok = perMtok(model.cacheReadInputTokenCost);
  const cacheCreatePerMtok = perMtok(model.cacheCreationInputTokenCost);
  const priorityInputPerMtok = perMtok(model.inputCostPerTokenPriority);
  const priorityOutputPerMtok = perMtok(model.outputCostPerTokenPriority);
  const priorityCacheReadPerMtok = perMtok(model.cacheReadInputTokenCostPriority);
  const priorityInputTokenPriceBands = gatewayPriorityInputTokenPriceBands(model);
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
  const declaredCurrency = model.currency;
  return {
    providerId: 'xd',
    modelId,
    currency: declaredCurrency ?? fallbackCurrency,
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
    ...(priorityInputPerMtok !== undefined ||
    priorityOutputPerMtok !== undefined ||
    priorityCacheReadPerMtok !== undefined ||
    priorityInputTokenPriceBands
      ? {
          priority: {
            ...(priorityInputPerMtok !== undefined ? { inputPerMtok: priorityInputPerMtok } : {}),
            ...(priorityOutputPerMtok !== undefined
              ? { outputPerMtok: priorityOutputPerMtok }
              : {}),
            ...(priorityCacheReadPerMtok !== undefined
              ? { cacheReadPerMtok: priorityCacheReadPerMtok }
              : {}),
            ...(priorityInputTokenPriceBands
              ? { inputTokenPriceBands: priorityInputTokenPriceBands }
              : {}),
          },
        }
      : {}),
    ...(inputTokenPriceBands ? { inputTokenPriceBands } : {}),
    ...(costDiscount !== undefined ? { costDiscount } : {}),
    ...(!declaredCurrency && fallbackIsInferred ? { currencyInferred: true } : {}),
  };
}

/**
 * @param ledgerCurrency 整份目录都没声明币种时的回落值。传本账号的账本币种（见
 *   main/usage/ledgerCurrency），**不要**传按区域推出来的值：服务端漏发 currency 时
 *   按区域猜会把 USD 口径的报价数值盖上 CNY 戳，产生 6.7 倍量级的错账。这种回落出来的
 *   报价一律带 currencyInferred 标记。
 */
export function gatewayPricingCatalog(
  models: readonly ModelAccessGatewayModel[],
  ledgerCurrency: MoneyCurrency,
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
  const declaredCurrency = declared.values().next().value;
  const fallbackCurrency = declaredCurrency ?? ledgerCurrency;
  const xd: Record<string, ModelPriceQuote> = {};
  for (const model of models) {
    const quote = gatewayModelPriceQuote(model, fallbackCurrency, declaredCurrency === undefined);
    if (quote) xd[quote.modelId] = quote;
  }
  return Object.keys(xd).length > 0 ? { xd } : {};
}

function referenceQuote(
  providerId: string,
  modelId: string,
  price: {
    currency: MoneyCurrency;
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
    source: 'provider-reference',
    approximate: true,
    ...price,
  };
}

function referencePriceCalendarDate(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/** Selects a dated provider reference tariff, optionally for a specific agent/input size. */
interface ReferencePriceOptions {
  agent?: AgentKind;
  inputTokens?: number;
  at?: string | Date;
  variant?: 'standard' | 'priority' | 'batch' | 'fast';
}

export function providerReferencePriceQuote(
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  options: ReferencePriceOptions = {},
): ModelPriceQuote | undefined {
  const quote = referencePriceQuoteForVariant(providerId, modelId, registry, options);
  if (!quote || (options.variant ?? 'standard') !== 'standard') return quote;
  // Usage segments call Fast "priority". Keep the standard quote for display,
  // and project the independently declared Fast tariff for the cost calculator.
  const fast =
    referencePriceQuoteForVariant(providerId, modelId, registry, { ...options, variant: 'fast' }) ??
    referencePriceQuoteForVariant(providerId, modelId, registry, { ...options, variant: 'priority' });
  if (!fast || fast.currency !== quote.currency) return quote;
  const { inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheCreatePerMtok, inputTokenPriceBands } = fast;
  return {
    ...quote,
    priority: { inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheCreatePerMtok, inputTokenPriceBands },
  };
}

function referencePriceQuoteForVariant(
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  options: ReferencePriceOptions = {},
): ModelPriceQuote | undefined {
  // 参考价 registry 的 agent 维度只有 claude-code / codex;Pi(动态 BYOM,按 provider/模型
  // 路由)在此按 agent 无关的参考价解析 —— pi 一律降级为 undefined 传给协议函数。
  const resolved = resolveModelReferencePrice(registry, providerId, modelId, {
    ...options,
    agent: options.agent === 'pi' ? undefined : options.agent,
  });
  if (!resolved) return undefined;
  const day = referencePriceCalendarDate(options.at);
  const variant = options.variant ?? 'standard';
  const inputTokenPriceBands = resolved.route.referencePrices
    ?.filter(
      (price) =>
        price.variant === variant &&
        price.currency === resolved.price.currency &&
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
    currency: resolved.price.currency,
    inputPerMtok: resolved.price.inputPerMtok,
    outputPerMtok: resolved.price.outputPerMtok,
    ...(resolved.price.cacheReadPerMtok !== undefined
      ? { cacheReadPerMtok: resolved.price.cacheReadPerMtok }
      : {}),
    ...(resolved.price.cacheWritePerMtok !== undefined
      ? { cacheCreatePerMtok: resolved.price.cacheWritePerMtok }
      : {}),
    ...(inputTokenPriceBands && inputTokenPriceBands.length > 0
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
      // XD/Cindy AI 的售价只认登录账号对应的 Gateway /models 响应。公共 registry
      // 只提供用户自带 API/OAuth 的参考价，绝不能在 Gateway 离线时伪装成 XD 售价。
      if (route.providerId === 'xd') continue;
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
  const exactQuote = (candidate: string): ModelPriceQuote | undefined =>
    (agent ? providerPricing[modelPricingKey(candidate, agent)] : undefined) ??
    providerPricing[candidate];
  const exact = exactQuote(normalizedModel);
  if (exact) return exact;
  if (normalizedProvider === 'openai' && normalizedModel.startsWith(CHATGPT_MODEL_PREFIX)) {
    const bareModel = normalizedModel.slice(CHATGPT_MODEL_PREFIX.length);
    return exactQuote(bareModel);
  }
  if (normalizedProvider === 'anthropic') {
    // Claude Code may report a dated wire id although the registry route uses the stable id.
    const undatedModel = normalizedModel.replace(/-\d{8}$/, '');
    if (undatedModel !== normalizedModel) {
      const undated = exactQuote(undatedModel);
      if (undated) return undated;
    }
    // Historical Claude sessions can report a bare family alias. The pricing catalog preserves
    // server registry order, so the first matching route is the server-curated current family.
    if (normalizedModel === 'opus' || normalizedModel === 'sonnet' || normalizedModel === 'haiku') {
      const familyPrefix = `claude-${normalizedModel}-`;
      for (const key of Object.keys(providerPricing)) {
        const routeModel = key.split('\u0000', 1)[0];
        if (!routeModel.startsWith(familyPrefix)) continue;
        // Select the server-curated canonical family route first, then resolve that route through
        // exactQuote so an agent-specific user override wins over its generic reference quote.
        const familyQuote = exactQuote(routeModel);
        if (familyQuote) return familyQuote;
      }
    }
  }
  return undefined;
}

/**
 * 从报价目录推断当前账号的 Gateway 结算币种。
 *
 * 结算币种由服务端按账号所属租户下发,不保证等于客户端发行区域。目录为空或出现
 * 混合币种时返回 null,由调用方回落到当前活动账本币种。
 */
export function gatewayLedgerCurrency(
  pricing: ModelPricingCatalog | null | undefined,
): MoneyCurrency | null {
  const currencies = new Set(Object.values(pricing?.xd ?? {}).map((quote) => quote.currency));
  return currencies.size === 1 ? (currencies.values().next().value ?? null) : null;
}

export function subscriptionDirectPriceQuote(
  modelId: string,
  registry: ModelRegistry | null | undefined,
  agent?: AgentKind,
  at?: string | Date,
): ModelPriceQuote | undefined {
  const routedId = exclusiveXaiCatalogModelId(modelId) ?? modelId;
  let quote: ModelPriceQuote | undefined;
  if (routedId.startsWith(CHATGPT_MODEL_PREFIX)) {
    quote = providerReferencePriceQuote('openai', routedId, registry, { agent, at });
  } else if (routedId.startsWith(XAI_MODEL_PREFIX)) {
    quote = providerReferencePriceQuote('xai', routedId, registry, { agent, at });
  }
  return quote
    ? {
        ...quote,
        modelId,
        source:
          quote.source === 'provider-reference' ? 'subscription-reference' : quote.source,
      }
    : undefined;
}
