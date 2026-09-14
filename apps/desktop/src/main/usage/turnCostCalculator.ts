/**
 * 单轮费用计算。定价先看实际 billing route，再看模型；模型名不再决定来源。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { gatewayLedgerCurrency, getModelPriceQuote } from '../../shared/modelPriceQuote.js';
import {
  addRegionalMoney,
  toLedgerCurrency,
  usdToLedgerCurrency,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
  type MoneyEstimateReason,
  type PriceVariant,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { isSubscriptionDirectRoute } from '../../shared/subscriptionModels.js';
import { currentLedgerCurrency } from './ledgerCurrency.js';
import type { ModelUsageDeltaEntry } from './modelUsageDelta.js';

export interface TurnTokenDeltas {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface TurnUsageSegment extends TurnTokenDeltas {
  id?: string;
  model?: string;
  priceVariant?: PriceVariant;
  costUsd?: number;
  complete?: boolean;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeTurnUsageSegments(value: unknown): TurnUsageSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TurnUsageSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const segment: TurnUsageSegment = {
      inputTokens: finiteNonNegative(raw.inputTokens),
      outputTokens: finiteNonNegative(raw.outputTokens),
      cacheReadTokens: finiteNonNegative(raw.cacheReadTokens),
      cacheCreateTokens: finiteNonNegative(raw.cacheCreateTokens),
    };
    const costUsd = finiteNonNegative(raw.costUsd);
    if (
      segment.inputTokens === 0 &&
      segment.outputTokens === 0 &&
      segment.cacheReadTokens === 0 &&
      segment.cacheCreateTokens === 0 &&
      costUsd === 0
    )
      continue;
    if (typeof raw.id === 'string' && raw.id) segment.id = raw.id;
    if (typeof raw.model === 'string' && raw.model.trim()) segment.model = raw.model.trim();
    if (
      raw.priceVariant === 'standard' ||
      raw.priceVariant === 'priority' ||
      raw.priceVariant === 'fast' ||
      raw.priceVariant === 'batch'
    ) {
      segment.priceVariant = raw.priceVariant;
    }
    if (costUsd > 0) segment.costUsd = costUsd;
    if (raw.complete === true || raw.complete === false) segment.complete = raw.complete;
    segments.push(segment);
  }
  return segments;
}

export function sumTurnUsageSegments(segments: readonly TurnUsageSegment[]): TurnTokenDeltas {
  return segments.reduce(
    (sum, segment) => ({
      inputTokens: sum.inputTokens + segment.inputTokens,
      outputTokens: sum.outputTokens + segment.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + segment.cacheReadTokens,
      cacheCreateTokens: sum.cacheCreateTokens + segment.cacheCreateTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  );
}

export type BillingRoute = 'xd-gateway' | 'provider-api' | 'subscription' | 'unknown';

/**
 * 将显式选择的 provider 映射为计费来源。`access.kind` 是目录已有的产品语义，
 * 不能把所有显式 provider 都推断成按量 API：OpenAI / xAI 等内置 OAuth 来源
 * 本身是订阅，SDK 即使上报 cost 也不能写进实际支出。
 */
export function billingRouteForExplicitProvider(
  providerId: string | null,
  accessKind: 'subscription' | 'api' | 'managed' | null | undefined,
): BillingRoute | null {
  if (!providerId) return null;
  if (providerId === 'xd') return 'xd-gateway';
  // 保留旧目录 / LKG 缺 access 时对 Anthropic 的历史订阅判定。
  if (providerId === 'anthropic' || accessKind === 'subscription') return 'subscription';
  return 'provider-api';
}

export interface TurnPricingContext {
  providerId: string | null;
  billingRoute: BillingRoute;
  region: CindyRegion;
}

export type TurnCostSource = 'sdk' | 'gateway' | 'reference' | 'sdk-fallback' | 'subscription';

export interface TurnCostResolution {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
}

export function normalizeModelIdForPricing(model: string | null | undefined): string {
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

/** token × quote → quote 币种金额。缺少实际使用桶的价格时拒绝猜价。 */
export function computeGatewayTurnCost(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
  variant: PriceVariant = 'standard',
): number | null {
  if (!price) return null;
  if (variant === 'batch') return null;
  const priority = variant === 'priority' || variant === 'fast';
  const tariff = priority ? price.priority : price;
  if (!tariff) return null;
  const totalInputTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  const band = tariff.inputTokenPriceBands
    ?.filter(
      (candidate) =>
        totalInputTokens >= candidate.minInputTokens &&
        (candidate.maxInputTokens === undefined || totalInputTokens < candidate.maxInputTokens),
    )
    .sort((a, b) => b.minInputTokens - a.minInputTokens)[0];
  // Provider reference bands describe the complete set of ranges for which the
  // provider published a price. Falling back to the baseline outside every band
  // would silently extend a bounded quote (for example <200k) to the model's
  // whole context window. Gateway bands remain overlays because its legacy
  // threshold fields intentionally omit the baseline range.
  if (tariff.inputTokenPriceBands?.length && !band && price.source !== 'gateway') {
    return null;
  }
  const inputPrice = band?.inputPerMtok ?? tariff.inputPerMtok;
  const outputPrice = band?.outputPerMtok ?? tariff.outputPerMtok;
  const cacheReadPrice = band?.cacheReadPerMtok ?? tariff.cacheReadPerMtok;
  // Gateway currently publishes no dedicated Priority cache-write field. Its
  // contract keeps cache creation on the standard tariff while Fast changes
  // input/output/cache-read prices. Do not turn every cached Claude Fast
  // request into an unpriceable turn merely because that redundant field is
  // absent from the Priority overlay.
  const cacheCreatePrice =
    band?.cacheCreatePerMtok ??
    tariff.cacheCreatePerMtok ??
    (priority && price.source === 'gateway' ? price.cacheCreatePerMtok : undefined);
  if (
    (tokens.inputTokens > 0 && inputPrice === undefined) ||
    (tokens.outputTokens > 0 && outputPrice === undefined) ||
    (tokens.cacheReadTokens > 0 && cacheReadPrice === undefined) ||
    (tokens.cacheCreateTokens > 0 && cacheCreatePrice === undefined)
  ) {
    return null;
  }
  return (
    (tokens.inputTokens * (inputPrice ?? 0) +
      tokens.outputTokens * (outputPrice ?? 0) +
      tokens.cacheReadTokens * (cacheReadPrice ?? 0) +
      tokens.cacheCreateTokens * (cacheCreatePrice ?? 0)) /
    1_000_000
  );
}

export function computeGatewaySegmentedTurnCost(
  segments: readonly TurnUsageSegment[],
  price: ModelPriceQuote | undefined,
): number | null {
  if (!price || segments.length === 0) return null;
  let total = 0;
  for (const segment of segments) {
    const amount = computeGatewayTurnCost(segment, price, segment.priceVariant ?? 'standard');
    if (amount == null) return null;
    total += amount;
  }
  return total;
}

/**
 * @param ledgerCurrency 本账号的账本币种（结算币种）。非 Gateway 来源的 USD 口径金额
 *   按它投影，而不是按构建区域 —— 本地账本单币种，按区域投影会让以 USD 结算的账号在
 *   CN 构建上收到 CNY 金额并被账本守卫整批丢弃。
 */
export function computePriceQuoteTurnMoney(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
  ledgerCurrency: MoneyCurrency,
  segments?: readonly TurnUsageSegment[],
): RegionalMoney | null {
  if (!price) return null;
  const standardAmount =
    segments !== undefined
      ? computeGatewaySegmentedTurnCost(segments, price)
      : computeGatewayTurnCost(tokens, price);
  if (standardAmount == null) return null;
  const discount =
    price.source === 'gateway' &&
    typeof price.costDiscount === 'number' &&
    Number.isFinite(price.costDiscount) &&
    price.costDiscount > 0 &&
    price.costDiscount <= 1
      ? price.costDiscount
      : 0;
  const amount = standardAmount * (1 - discount);
  const valueEstimate =
    price.source === 'subscription-reference' ||
    price.source === 'provider-reference' ||
    price.source === 'user-override';
  // 币种是本地推断出来的时候，金额仍是真实计费(kind 保持 actual-cost，否则会被并进
  // 订阅价值统计)，但不能再自称精确：报价数值来自服务端、币种却是猜的，这一笔与账单
  // 能不能对上取决于猜得对不对。标 approximate + 原因，让 UI 与对账口径看得见。
  const currencyInferred = price.currencyInferred === true;
  const baseReasons =
    price.source === 'subscription-reference'
      ? (['subscription-value', 'reference-price'] as const)
      : valueEstimate || price.approximate
        ? (['reference-price'] as const)
        : undefined;
  const estimateReasons: MoneyEstimateReason[] = [
    ...(baseReasons ?? []),
    ...(currencyInferred ? (['inferred-currency'] as const) : []),
  ];
  const money: RegionalMoney = {
    amount: Math.max(0, amount),
    currency: price.currency,
    approximate: price.approximate || valueEstimate || currencyInferred,
    kind: valueEstimate ? 'value-estimate' : 'actual-cost',
    ...(estimateReasons.length > 0 ? { estimateReasons } : {}),
  };
  // Gateway 报价的币种就是该账号的实际结算币种,原样记账才能与账单对账 —— 不做任何换算。
  // 否则以 USD 结算的账号在 CN 构建上,turn 会被 USD_TO_CNY_FIXED_RATE 折成 CNY,而同一
  // 界面的账号配额(走 gatewayMoney,不换算)仍是 USD 原值,造成同一行 $ / ¥ 混排且金额差
  // 一个汇率倍数、无法与服务端账单核对。
  //
  // 其余来源(第三方参考价、订阅价值估算)是 USD 口径,投影到**账本币种**而不是构建区域:
  // 账本是单币种的,按区域投影会让这些金额在 USD 结算账号上变成 CNY,继而被账本写入守卫
  // 当异币种整批丢弃,订阅估算与自定义供应商花费就再也记不进来。
  return price.source === 'gateway' ? money : toLedgerCurrency(money, ledgerCurrency);
}

export function resolveTurnCost(args: {
  rawModel: string;
  tokens: TurnTokenDeltas;
  sdkCostDelta?: number;
  pricing: ModelPricingCatalog | null | undefined;
  context: TurnPricingContext;
  segments?: readonly TurnUsageSegment[];
}): TurnCostResolution {
  const { rawModel, tokens, sdkCostDelta, pricing, context, segments } = args;
  const model = normalizeModelIdForPricing(rawModel);

  // An explicit provider API route is authoritative. User-defined providers may legitimately
  // expose namespaced model ids such as `xai/grok-4.5`; treating the prefix alone as proof of a
  // subscription would discard both the provider's SDK cost and the user's price override.
  // Prefix inference remains the compatibility fallback for routes whose upstream is not an
  // explicitly selected provider API (for example a bridge sub-agent inside an XD session).
  if (
    context.billingRoute === 'subscription' ||
    (context.billingRoute !== 'provider-api' && isSubscriptionDirectRoute(model))
  ) {
    return { model, money: null, source: 'subscription' };
  }

  // 本账号的账本币种:目录里有报价时以报价声明为准；目录为空时沿用模型同步已经写入的
  // 活动账本币种。不能重新按构建区域推断——目录可能只是因为模型都缺标准价格而为空，
  // 但账号结算币种仍已由完整模型目录确定，按区域回落会让金额被账本守卫拒收。
  const ledgerCurrency = gatewayLedgerCurrency(pricing) ?? currentLedgerCurrency();

  if (context.billingRoute === 'xd-gateway') {
    // 长上下文档不看模型 id 后缀：computeGatewayTurnCost 按本轮实际 input token 落进
    // quote 的 inputTokenPriceBands，比 `[1m]` 这类后缀更权威（后缀只表示会话开了大
    // 窗口，不代表这一轮真的超过阈值）。
    const quote = getModelPriceQuote(pricing, 'xd', model);
    if (!quote) {
      return { model, money: null, source: 'sdk-fallback' };
    }
    return {
      model,
      money: computePriceQuoteTurnMoney(tokens, quote, ledgerCurrency, segments),
      source: 'gateway',
    };
  }

  const providerQuote =
    context.billingRoute === 'provider-api'
      ? getModelPriceQuote(pricing, context.providerId, model, 'claude-code')
      : undefined;
  const hasTokenDeltas =
    tokens.inputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.cacheReadTokens > 0 ||
    tokens.cacheCreateTokens > 0;
  // DeepSeek 的缓存命中价与未命中价相差数十倍。Claude SDK 的 costUSD 是客户端
  // 对第三方模型的估值，不是 DeepSeek 账单事实；一旦把缓存 token 按普通输入价算，
  // 前台金额就会被成倍放大。有 token 增量且官方参考价存在时，按实际 token/cache
  // 分桶重算并保留 value-estimate 标记；只有 cost 增量或目录价格不覆盖本轮时仍退回
  // SDK，避免把有费用但无 token 明细的轮次误算成 $0。
  if (context.providerId === 'deepseek' && providerQuote && hasTokenDeltas) {
    const referenceMoney = computePriceQuoteTurnMoney(
      tokens,
      providerQuote,
      ledgerCurrency,
      segments,
    );
    if (referenceMoney) {
      return { model, money: referenceMoney, source: 'reference' };
    }
    if (segments !== undefined) {
      return { model, money: null, source: 'reference' };
    }
  }

  // 其它第三方供应商 / 未知路由:SDK 值是 USD 口径,投影到账本币种而不是构建区域,
  // 否则 USD 结算账号上这些花费会变成 CNY 并被账本守卫丢弃。
  const sdkAmount = Math.max(0, sdkCostDelta ?? 0);
  if (context.billingRoute === 'provider-api' && sdkAmount > 0) {
    return { model, money: usdToLedgerCurrency(sdkAmount, ledgerCurrency), source: 'sdk' };
  }
  return {
    model,
    money: providerQuote
      ? computePriceQuoteTurnMoney(tokens, providerQuote, ledgerCurrency, segments)
      : null,
    source: context.billingRoute === 'provider-api' ? 'reference' : 'sdk-fallback',
  };
}

export interface ResolvedModelCost {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
  deltas: TurnTokenDeltas;
  segments?: TurnUsageSegment[];
}

export interface ClaudeTurnCostResolution {
  /** Actual provider/Gateway spend only. Never includes reference-price estimates. */
  turnMoney: RegionalMoney | null;
  /** Reference-price value only. Kept out of actual spend/session ledgers. */
  estimatedTurnMoney: RegionalMoney | null;
  perModel: ResolvedModelCost[];
}

export function resolveClaudeTurnCostSinks(
  modelDeltas: ModelUsageDeltaEntry[],
  pricing: ModelPricingCatalog | null | undefined,
  context: TurnPricingContext,
  usageSegments?: readonly TurnUsageSegment[],
  usageSegmentsComplete = false,
): ClaudeTurnCostResolution {
  type DeltaWithSegments = ModelUsageDeltaEntry & { segments?: TurnUsageSegment[] };
  const effectiveDeltas: DeltaWithSegments[] =
    usageSegments === undefined
      ? modelDeltas
      : (() => {
          const observedByModel = new Map<
            string,
            { all: TurnUsageSegment[]; priceable: TurnUsageSegment[] }
          >();
          for (const segment of usageSegments) {
            const model = normalizeModelIdForPricing(segment.model);
            const group = observedByModel.get(model) ?? { all: [], priceable: [] };
            const copy = { ...segment };
            group.all.push(copy);
            if (usageSegmentsComplete || segment.complete === true) {
              group.priceable.push(copy);
            }
            observedByModel.set(model, group);
          }
          const cumulativeByModel = new Map(
            modelDeltas.map((delta) => [normalizeModelIdForPricing(delta.model), delta]),
          );
          const models = new Set([...observedByModel.keys(), ...cumulativeByModel.keys()]);
          const values: DeltaWithSegments[] = [];
          for (const model of models) {
            const observed = observedByModel.get(model);
            const cumulative = cumulativeByModel.get(model);
            const observedTotals = sumTurnUsageSegments(observed?.all ?? []);
            const priceableSegments = observed?.priceable ?? [];
            const priceableTotals = sumTurnUsageSegments(priceableSegments);
            const target: TurnTokenDeltas = {
              inputTokens: Math.max(observedTotals.inputTokens, cumulative?.inputTokensDelta ?? 0),
              outputTokens: Math.max(
                observedTotals.outputTokens,
                cumulative?.outputTokensDelta ?? 0,
              ),
              cacheReadTokens: Math.max(
                observedTotals.cacheReadTokens,
                cumulative?.cacheReadTokensDelta ?? 0,
              ),
              cacheCreateTokens: Math.max(
                observedTotals.cacheCreateTokens,
                cumulative?.cacheCreateTokensDelta ?? 0,
              ),
            };
            let remainingCost = cumulative?.costUsdDelta ?? 0;
            if (priceableSegments.length > 0) {
              values.push({
                model,
                costUsdDelta: remainingCost,
                inputTokensDelta: priceableTotals.inputTokens,
                outputTokensDelta: priceableTotals.outputTokens,
                cacheReadTokensDelta: priceableTotals.cacheReadTokens,
                cacheCreateTokensDelta: priceableTotals.cacheCreateTokens,
                segments: priceableSegments,
              });
              // Provider-reported cost is already represented once. The
              // unpriceable residual below carries token facts only.
              remainingCost = 0;
            }
            const residual = {
              inputTokensDelta: Math.max(0, target.inputTokens - priceableTotals.inputTokens),
              outputTokensDelta: Math.max(0, target.outputTokens - priceableTotals.outputTokens),
              cacheReadTokensDelta: Math.max(
                0,
                target.cacheReadTokens - priceableTotals.cacheReadTokens,
              ),
              cacheCreateTokensDelta: Math.max(
                0,
                target.cacheCreateTokens - priceableTotals.cacheCreateTokens,
              ),
            };
            if (
              remainingCost > 0 ||
              residual.inputTokensDelta > 0 ||
              residual.outputTokensDelta > 0 ||
              residual.cacheReadTokensDelta > 0 ||
              residual.cacheCreateTokensDelta > 0
            ) {
              values.push({
                model,
                costUsdDelta: remainingCost,
                ...residual,
                // Never collapse an unmatched aggregate or unfinished request
                // into one synthetic provider call. Only explicitly completed
                // request segments above are eligible for token pricing.
                segments: [],
              });
            }
          }
          return values;
        })();
  const perModel: ResolvedModelCost[] = [];
  const actualMoney: RegionalMoney[] = [];
  const estimatedMoney: RegionalMoney[] = [];
  for (const delta of effectiveDeltas) {
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
      segments: delta.segments,
    });
    perModel.push({
      model: resolved.model,
      money: resolved.money,
      source: resolved.source,
      deltas: tokens,
      ...(delta.segments ? { segments: delta.segments } : {}),
    });
    if (resolved.money && resolved.money.amount > 0) {
      (resolved.money.kind === 'actual-cost' ? actualMoney : estimatedMoney).push(resolved.money);
    }
  }
  return {
    turnMoney: actualMoney.length > 0 ? addRegionalMoney(actualMoney) : null,
    estimatedTurnMoney: estimatedMoney.length > 0 ? addRegionalMoney(estimatedMoney) : null,
    perModel,
  };
}

/**
 * @param ledgerCurrency 本账号账本币种。订阅参考价是 USD 口径，按它投影而不是按区域，
 *   否则以 USD 结算的账号上这些估值会变成 CNY 并被账本守卫丢弃。
 */
export function estimateClaudeSubscriptionTurnValue(
  perModel: ResolvedModelCost[],
  ledgerCurrency: MoneyCurrency,
  pricing: ModelPricingCatalog | null | undefined = undefined,
): RegionalMoney | null {
  const values: RegionalMoney[] = [];
  for (const item of perModel) {
    if (!isAnthropicModel(item.model) || item.money?.amount) continue;
    const quote = getModelPriceQuote(pricing, 'anthropic', item.model, 'claude-code');
    if (!quote) continue;
    const value = computePriceQuoteTurnMoney(item.deltas, quote, ledgerCurrency);
    if (value && value.amount > 0) values.push(value);
  }
  return values.length > 0 ? addRegionalMoney(values) : null;
}

export function buildClaudeTurnUsageDetails(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined,
  deltas: ModelUsageDeltaEntry[] | undefined,
  fallbackModel: string,
  perModel?: ResolvedModelCost[],
  durationMs?: number,
  turnDurationMs?: number,
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
    model: deltas?.length === 1 ? deltas[0].model : hasModelUsageDeltas ? undefined : fallbackModel,
    models: hasModelUsageDeltas ? deltas?.map((delta) => delta.model) : undefined,
    perModelCost: perModelCost && perModelCost.length > 0 ? perModelCost : undefined,
    durationMs,
    turnDurationMs,
  });
}
