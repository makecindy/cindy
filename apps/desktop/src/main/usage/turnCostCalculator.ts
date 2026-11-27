/**
 * 单轮费用计算。定价先看实际 billing route，再看模型；模型名不再决定来源。
 */

import {
  isByokProviderId,
  providerWireProtocolForApi,
  resolvePiModelRoute,
  type AgentKind,
  type CatalogModel,
  type ProviderWireProtocol,
  type RoutingDescriptor,
} from '@cindy/model-providers';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { UsageBillingSource } from '@cindy/maker-shared/usage-cost-details';

import { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
import {
  sumMoneyByCurrency,
  usdMoney,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyEstimateReason,
  type PriceVariant,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { isSubscriptionDirectRoute, isExclusiveXaiModelId } from '../../shared/subscriptionModels.js';
import type { ModelUsageDeltaEntry } from './modelUsageDelta.js';

export interface TurnTokenDeltas {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** cacheCreateTokens 中按 1h TTL 写入的部分；缺省视为全部 5m 写入。 */
  cacheCreate1hTokens?: number;
}

export interface TurnUsageSegment extends TurnTokenDeltas {
  id?: string;
  model?: string;
  modelConfirmed?: boolean;
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
    if (typeof raw.modelConfirmed === 'boolean') segment.modelConfirmed = raw.modelConfirmed;
    if (
      raw.priceVariant === 'standard' ||
      raw.priceVariant === 'priority' ||
      raw.priceVariant === 'fast' ||
      raw.priceVariant === 'batch' || raw.priceVariant === 'ultrafast'
    ) {
      segment.priceVariant = raw.priceVariant;
    }
    const cacheCreate1hTokens = Math.min(
      finiteNonNegative(raw.cacheCreate1hTokens),
      segment.cacheCreateTokens,
    );
    if (cacheCreate1hTokens > 0) segment.cacheCreate1hTokens = cacheCreate1hTokens;
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
  /** Captured when the request starts, so logout cannot reclassify an in-flight enterprise turn. */
  accessKind?: 'subscription' | 'api' | 'managed' | null;
  /** Selected request model when upstream may return a different routed backend model name. */
  selectedModel?: string;
  /** Model-level flag marking opaque upstream routing whose names must not drive SDK fallback billing. */
  opaqueModelId?: boolean;
  /** Normalized model IDs on this route with opaque upstream routing (multi-model Claude turns). */
  opaqueModelIds?: readonly string[];
  /** True when the turn's runtime route targets the verified official Anthropic API. */
  officialAnthropicApi?: boolean;
  /** Per-model official Anthropic flags when a model's explicit route differs from the runtime default. */
  officialAnthropicModels?: Readonly<Record<string, boolean>>;
}

const CLAUDE_MAIN_USAGE_PARENT = '__main__';

function isClaudeMainSegmentId(segmentId: string | undefined): boolean {
  return typeof segmentId === 'string' && segmentId.endsWith(`:${CLAUDE_MAIN_USAGE_PARENT}`);
}

function isClaudeSubagentSegmentId(segmentId: string | undefined): boolean {
  return (
    typeof segmentId === 'string' &&
    segmentId.startsWith('claude:') &&
    !segmentId.endsWith(`:${CLAUDE_MAIN_USAGE_PARENT}`)
  );
}

function defaultWireProtocolForAgent(agent: AgentKind): ProviderWireProtocol {
  if (agent === 'claude-code') return 'anthropic-messages';
  if (agent === 'pi') return 'openai-chat';
  return 'openai-responses';
}

/** True only for verified official https://api.anthropic.com Anthropic Messages endpoints. */
export function isOfficialAnthropicMessagesEndpoint(endpoint: {
  baseUrl: string | undefined;
  wireProtocol?: ProviderWireProtocol;
  requestPath?: string;
}): boolean {
  if (!endpoint.baseUrl) return false;
  if (endpoint.wireProtocol && endpoint.wireProtocol !== 'anthropic-messages') return false;
  if (endpoint.requestPath && endpoint.requestPath.trim() !== '/v1/messages') return false;
  try {
    const url = new URL(endpoint.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    if (url.hostname.toLowerCase() !== 'api.anthropic.com') return false;
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname === '' || pathname === '/v1';
  } catch {
    return false;
  }
}

export interface OfficialAnthropicRouteProvider {
  id: string;
  routing?: Partial<
    Record<AgentKind, Pick<RoutingDescriptor, 'upstream' | 'wireProtocol' | 'requestPath' | 'disabled'>>
  >;
  models?: Partial<
    Record<AgentKind, readonly Pick<CatalogModel, 'id' | 'api' | 'piApi' | 'route'>[]>
  >;
}

export function isOfficialAnthropicProviderAgentRoute(
  provider: OfficialAnthropicRouteProvider,
  agent: AgentKind,
  modelId?: string,
): boolean {
  if (provider.id === 'anthropic') return true;
  const routing = provider.routing?.[agent];
  if (!routing || routing.disabled) return false;
  const defaultWire = defaultWireProtocolForAgent(agent);
  const normalizedTarget = modelId ? normalizeModelIdForPricing(modelId) : undefined;
  const modelEntry = normalizedTarget
    ? (provider.models?.[agent]?.find((candidate) => candidate.id === modelId) ??
      provider.models?.[agent]?.find(
        (candidate) => normalizeModelIdForPricing(candidate.id) === normalizedTarget,
      ))
    : undefined;
  if (agent === 'pi' && modelEntry) {
    const piRoute = resolvePiModelRoute(modelEntry, {
      baseUrl: routing.upstream,
      wireProtocol: routing.wireProtocol ?? defaultWire,
    });
    if (!piRoute) return false;
    return isOfficialAnthropicMessagesEndpoint({
      baseUrl: piRoute.baseUrl,
      wireProtocol: piRoute.wireProtocol,
      requestPath: piRoute.requestPath ?? (modelEntry.route ? undefined : routing.requestPath),
    });
  }
  return isOfficialAnthropicMessagesEndpoint({
    baseUrl: modelEntry?.route?.baseUrl ?? routing.upstream,
    wireProtocol:
      modelEntry?.route?.wireProtocol ??
      providerWireProtocolForApi(modelEntry?.api ?? modelEntry?.piApi) ??
      routing.wireProtocol ??
      defaultWire,
    requestPath: modelEntry?.route ? modelEntry.route.requestPath : routing.requestPath,
  });
}

export function isOfficialAnthropicProviderConnection(
  providerId: string | null | undefined,
  provider: OfficialAnthropicRouteProvider | undefined,
  agent?: AgentKind,
  modelId?: string,
): boolean {
  if (providerId === 'anthropic' || provider?.id === 'anthropic') return true;
  if (!provider) return false;
  if (agent) return isOfficialAnthropicProviderAgentRoute(provider, agent, modelId);
  const agents = (Object.keys(provider.routing ?? {}) as AgentKind[]).filter(
    (candidate) => provider.routing?.[candidate] && !provider.routing[candidate]!.disabled,
  );
  if (agents.length === 0) return false;
  const normalizedTarget = modelId ? normalizeModelIdForPricing(modelId) : undefined;
  const matchingAgents = normalizedTarget
    ? agents.filter((candidate) =>
        provider.models?.[candidate]?.some(
          (entry) => normalizeModelIdForPricing(entry.id) === normalizedTarget,
        ),
      )
    : [];
  const scope = matchingAgents.length > 0 ? matchingAgents : agents;
  return scope.every((candidate) => isOfficialAnthropicProviderAgentRoute(provider, candidate, modelId));
}

export function resolveOfficialAnthropicModelsForAgent(
  provider: OfficialAnthropicRouteProvider | undefined,
  providerId: string | null | undefined,
  agent?: AgentKind,
): {
  officialAnthropicApi: boolean;
  officialAnthropicModels?: Readonly<Record<string, boolean>>;
} {
  if (providerId === 'anthropic' || provider?.id === 'anthropic') {
    return { officialAnthropicApi: true };
  }
  if (!provider) {
    return { officialAnthropicApi: false };
  }
  if (!agent) {
    return { officialAnthropicApi: isOfficialAnthropicProviderConnection(providerId, provider) };
  }
  const defaultOfficial = isOfficialAnthropicProviderAgentRoute(provider, agent);
  const models = provider.models?.[agent];
  if (!models?.length) {
    return { officialAnthropicApi: defaultOfficial };
  }
  const overrides: Record<string, boolean> = {};
  const ambiguous = new Set<string>();
  for (const model of models) {
    const normalizedId = normalizeModelIdForPricing(model.id);
    if (!normalizedId || normalizedId === 'unknown') continue;
    const modelOfficial = isOfficialAnthropicProviderAgentRoute(provider, agent, model.id);
    if (modelOfficial === defaultOfficial) {
      if (normalizedId in overrides) {
        delete overrides[normalizedId];
        ambiguous.add(normalizedId);
      }
      continue;
    }
    if (!ambiguous.has(normalizedId)) {
      overrides[normalizedId] = modelOfficial;
    }
  }
  return {
    officialAnthropicApi: defaultOfficial,
    ...(Object.keys(overrides).length > 0 ? { officialAnthropicModels: overrides } : {}),
  };
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
  if (variant === 'batch' || variant === 'ultrafast') return null;
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
  // 1h TTL 写入有独立且更高的单价。报价未声明 1h 单价时
  // （如 Gateway）沿用 5m 单价，不让本来可计价的轮次变成无价。
  const cacheCreate1hPrice =
    band?.cacheCreate1hPerMtok ?? tariff.cacheCreate1hPerMtok ?? cacheCreatePrice;
  const cacheCreate1hTokens = Math.min(tokens.cacheCreate1hTokens ?? 0, tokens.cacheCreateTokens);
  const cacheCreate5mTokens = tokens.cacheCreateTokens - cacheCreate1hTokens;
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
      cacheCreate5mTokens * (cacheCreatePrice ?? 0) +
      cacheCreate1hTokens * (cacheCreate1hPrice ?? 0)) /
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

export function computePriceQuoteTurnMoney(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
  segments?: readonly TurnUsageSegment[],
): RegionalMoney | null {
  if (!price) return null;
  const standardAmount =
    segments !== undefined
      ? computeGatewaySegmentedTurnCost(segments, price)
      : computeGatewayTurnCost(tokens, price);
  if (standardAmount == null) return null;
  const discount =
    (price.source === 'gateway' ||
      (price.source === 'provider-reference' && isByokProviderId(price.providerId))) &&
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
  return {
    amount: Math.max(0, amount),
    currency: price.currency,
    approximate: price.approximate || valueEstimate || currencyInferred,
    kind: valueEstimate ? 'value-estimate' : 'actual-cost',
    ...(estimateReasons.length > 0 ? { estimateReasons } : {}),
  };
}

export function resolveTurnCost(args: {
  rawModel: string;
  agent?: AgentKind;
  tokens: TurnTokenDeltas;
  sdkCostDelta?: number;
  pricing: ModelPricingCatalog | null | undefined;
  context: TurnPricingContext;
  segments?: readonly TurnUsageSegment[];
}): TurnCostResolution {
  const { rawModel, agent = 'claude-code', tokens, sdkCostDelta, pricing, context, segments } = args;
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
      money: computePriceQuoteTurnMoney(tokens, quote, segments),
      source: 'gateway',
    };
  }

  const rawSelectedModel = context.selectedModel
    ? normalizeModelIdForPricing(context.selectedModel)
    : undefined;
  const selectedModel =
    rawSelectedModel && rawSelectedModel !== 'unknown' ? rawSelectedModel : undefined;
  const isOpaqueId = (candidate: string | undefined): boolean =>
    candidate !== undefined &&
    context.opaqueModelIds?.some((id) => normalizeModelIdForPricing(id) === candidate) === true;
  const isSelectedOpaque = context.opaqueModelId === true || isOpaqueId(selectedModel);
  const isOpaqueModel = isSelectedOpaque || isOpaqueId(model);
  const providerQuoteModel = isSelectedOpaque && selectedModel ? selectedModel : model;
  const providerQuote =
    context.billingRoute === 'provider-api'
      ? getModelPriceQuote(pricing, context.providerId, providerQuoteModel, agent)
      : undefined;
  const undatedRouteModel = providerQuoteModel.replace(/-\d{8}$/, '');
  const officialOverride =
    context.officialAnthropicModels?.[providerQuoteModel] ??
    context.officialAnthropicModels?.[undatedRouteModel] ??
    context.officialAnthropicModels?.[rawModel.trim()];
  const isOfficialAnthropic =
    officialOverride !== undefined
      ? officialOverride
      : (context.officialAnthropicApi ?? context.providerId === 'anthropic');
  if (context.accessKind === 'managed') {
    return {
      model,
      money: providerQuote ? computePriceQuoteTurnMoney(tokens, providerQuote, segments) : null,
      source: 'reference',
    };
  }
  const hasTokenDeltas =
    tokens.inputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.cacheReadTokens > 0 ||
    tokens.cacheCreateTokens > 0;
  // 非 Anthropic 官方连接且有 token 增量时，供应商报价（发现价、参考表或用户覆写）比
  // Claude Code SDK 的客户端模型估值更权威；Anthropic 官方连接只让用户显式覆写覆盖
  // SDK 账单。只有缺失可报价明细（非不透明模型）或仅有 cost 增量时仍退回 SDK。
  if (
    providerQuote &&
    hasTokenDeltas &&
    (!isOfficialAnthropic || providerQuote.source === 'user-override')
  ) {
    const referenceMoney = computePriceQuoteTurnMoney(
      tokens,
      providerQuote,
      segments,
    );
    if (referenceMoney) {
      return { model, money: referenceMoney, source: 'reference' };
    }
    if (segments !== undefined) {
      return { model, money: null, source: 'reference' };
    }
  }

  // 声明为 opaqueModelId（如网关路由分组）且没有有效供应商报价时，禁止把 SDK 兜底
  // 估值记成 actual-cost，留空让界面明确呈现缺失价格。
  const sdkAmount = Math.max(0, sdkCostDelta ?? 0);
  if (context.billingRoute === 'provider-api' && sdkAmount > 0 && !isOpaqueModel) {
    return { model, money: usdMoney(sdkAmount), source: 'sdk' };
  }
  return {
    model,
    money: providerQuote
      ? computePriceQuoteTurnMoney(tokens, providerQuote, segments)
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
  actualByCurrency: RegionalMoney[];
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
  const normalizedSelectedModel = context.selectedModel
    ? normalizeModelIdForPricing(context.selectedModel)
    : undefined;
  const selectedModel =
    normalizedSelectedModel && normalizedSelectedModel !== 'unknown'
      ? normalizedSelectedModel
      : undefined;
  const hasSelectedOpaque =
    context.opaqueModelId === true ||
    (selectedModel !== undefined &&
      context.opaqueModelIds?.some((id) => normalizeModelIdForPricing(id) === selectedModel) === true);
  // selectedModel and opaqueModelId describe the session's selected main model; subagent
  // requests must resolve quotes and opaque checks for their own model IDs instead.
  const subagentContext: TurnPricingContext = {
    providerId: context.providerId,
    billingRoute: context.billingRoute,
    region: context.region,
    ...(context.accessKind !== undefined ? { accessKind: context.accessKind } : {}),
    ...(context.opaqueModelIds !== undefined ? { opaqueModelIds: context.opaqueModelIds } : {}),
    ...(context.officialAnthropicApi !== undefined
      ? { officialAnthropicApi: context.officialAnthropicApi }
      : {}),
    ...(context.officialAnthropicModels !== undefined
      ? { officialAnthropicModels: context.officialAnthropicModels }
      : {}),
  };

  type ScopedDelta = ModelUsageDeltaEntry & {
    segments?: TurnUsageSegment[];
    isMainRequest: boolean;
  };
  const effectiveDeltas: ScopedDelta[] =
    usageSegments === undefined
      ? (() => {
          const hasSelectedModelDelta =
            selectedModel !== undefined &&
            modelDeltas.some((delta) => normalizeModelIdForPricing(delta.model) === selectedModel);
          return modelDeltas.map((delta) => ({
            ...delta,
            isMainRequest: hasSelectedModelDelta
              ? normalizeModelIdForPricing(delta.model) === selectedModel
              : modelDeltas.length <= 1,
          }));
        })()
      : (() => {
          type ScopeBucket = { all: TurnUsageSegment[]; priceable: TurnUsageSegment[] };
          const observedByModel = new Map<
            string,
            { main: ScopeBucket; subagent: ScopeBucket; unscoped: ScopeBucket }
          >();
          let hasExplicitClaudeMain = false;
          let hasExplicitClaudeSubagent = false;
          for (const segment of usageSegments) {
            const model = normalizeModelIdForPricing(segment.model);
            const group = observedByModel.get(model) ?? {
              main: { all: [], priceable: [] },
              subagent: { all: [], priceable: [] },
              unscoped: { all: [], priceable: [] },
            };
            const copy = { ...segment };
            const bucket = isClaudeMainSegmentId(segment.id)
              ? ((hasExplicitClaudeMain = true), group.main)
              : isClaudeSubagentSegmentId(segment.id)
                ? ((hasExplicitClaudeSubagent = true), group.subagent)
                : group.unscoped;
            bucket.all.push(copy);
            if (usageSegmentsComplete || segment.complete === true) {
              bucket.priceable.push(copy);
            }
            observedByModel.set(model, group);
          }
          const cumulativeByModel = new Map(
            modelDeltas.map((delta) => [normalizeModelIdForPricing(delta.model), delta]),
          );
          const models = new Set([...observedByModel.keys(), ...cumulativeByModel.keys()]);
          const hasSelectedModelInTurn = selectedModel !== undefined && models.has(selectedModel);
          const values: ScopedDelta[] = [];
          const pushBucket = (
            model: string,
            target: TurnTokenDeltas,
            priceableSegments: TurnUsageSegment[],
            initialCost: number,
            isMainRequest: boolean,
          ) => {
            const priceableTotals = sumTurnUsageSegments(priceableSegments);
            let remainingCost = initialCost;
            if (priceableSegments.length > 0) {
              values.push({
                model,
                costUsdDelta: remainingCost,
                inputTokensDelta: priceableTotals.inputTokens,
                outputTokensDelta: priceableTotals.outputTokens,
                cacheReadTokensDelta: priceableTotals.cacheReadTokens,
                cacheCreateTokensDelta: priceableTotals.cacheCreateTokens,
                segments: priceableSegments,
                isMainRequest,
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
                isMainRequest,
              });
            }
          };

          for (const model of models) {
            const observed = observedByModel.get(model);
            const cumulative = cumulativeByModel.get(model);
            const explicitMainCount = observed?.main.all.length ?? 0;
            const subagentCount = observed?.subagent.all.length ?? 0;
            const unscopedCount = observed?.unscoped.all.length ?? 0;

            if (explicitMainCount > 0 && subagentCount > 0 && hasSelectedOpaque) {
              const mainAll = [...observed!.main.all, ...observed!.unscoped.all];
              const mainPriceable = [...observed!.main.priceable, ...observed!.unscoped.priceable];
              const mainTotals = sumTurnUsageSegments(mainAll);
              const subagentTotals = sumTurnUsageSegments(observed!.subagent.all);
              const combinedInput = mainTotals.inputTokens + subagentTotals.inputTokens;
              const combinedOutput = mainTotals.outputTokens + subagentTotals.outputTokens;
              const combinedCacheRead =
                mainTotals.cacheReadTokens + subagentTotals.cacheReadTokens;
              const combinedCacheCreate =
                mainTotals.cacheCreateTokens + subagentTotals.cacheCreateTokens;
              pushBucket(
                model,
                {
                  inputTokens:
                    mainTotals.inputTokens +
                    Math.max(0, (cumulative?.inputTokensDelta ?? 0) - combinedInput),
                  outputTokens:
                    mainTotals.outputTokens +
                    Math.max(0, (cumulative?.outputTokensDelta ?? 0) - combinedOutput),
                  cacheReadTokens:
                    mainTotals.cacheReadTokens +
                    Math.max(0, (cumulative?.cacheReadTokensDelta ?? 0) - combinedCacheRead),
                  cacheCreateTokens:
                    mainTotals.cacheCreateTokens +
                    Math.max(0, (cumulative?.cacheCreateTokensDelta ?? 0) - combinedCacheCreate),
                },
                mainPriceable,
                cumulative?.costUsdDelta ?? 0,
                true,
              );
              pushBucket(model, subagentTotals, observed!.subagent.priceable, 0, false);
              continue;
            }

            const allSegments = observed
              ? [...observed.main.all, ...observed.subagent.all, ...observed.unscoped.all]
              : [];
            const priceableSegments = observed
              ? [
                  ...observed.main.priceable,
                  ...observed.subagent.priceable,
                  ...observed.unscoped.priceable,
                ]
              : [];
            const observedTotals = sumTurnUsageSegments(allSegments);
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
            const isMainRequest =
              explicitMainCount > 0
                ? true
                : subagentCount > 0
                  ? false
                  : hasExplicitClaudeMain
                    ? false
                    : hasExplicitClaudeSubagent
                      ? hasSelectedModelInTurn
                        ? model === selectedModel
                        : unscopedCount > 0 || models.size - observedByModel.size <= 1
                      : hasSelectedModelInTurn
                        ? model === selectedModel
                        : models.size <= 1;
            pushBucket(
              model,
              target,
              priceableSegments,
              cumulative?.costUsdDelta ?? 0,
              isMainRequest,
            );
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
      context: delta.isMainRequest ? context : subagentContext,
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
  const actualByCurrency = sumMoneyByCurrency(actualMoney);
  return {
    actualByCurrency,
    turnMoney: actualByCurrency[0] ?? null,
    estimatedTurnMoney: sumMoneyByCurrency(estimatedMoney)[0] ?? null,
    perModel,
  };
}

export function estimateClaudeSubscriptionTurnValue(
  perModel: ResolvedModelCost[],
  pricing: ModelPricingCatalog | null | undefined = undefined,
): RegionalMoney | null {
  const values: RegionalMoney[] = [];
  for (const item of perModel) {
    if (!isAnthropicModel(item.model) || item.money?.amount) continue;
    const quote = getModelPriceQuote(pricing, 'anthropic', item.model, 'claude-code');
    if (!quote) continue;
    const value = computePriceQuoteTurnMoney(item.deltas, quote);
    if (value && value.amount > 0) values.push(value);
  }
  return sumMoneyByCurrency(values)[0] ?? null;
}

export function claudeModelBilling(item: ResolvedModelCost, billing?: UsageBillingSource): UsageBillingSource {
  const billingSource = item.source === 'gateway' ? 'cindy-ai' : item.source === 'subscription'
    ? 'subscription' : billing?.billingSource;
  if (billingSource === 'subscription') {
    const bridge = item.model.startsWith('chatgpt/') ? 'openai' : isExclusiveXaiModelId(item.model) ? 'xai' : undefined;
    if (bridge && billing?.providerId !== bridge && item.source === 'subscription') {
      return { providerId: bridge, billingSource };
    }
    if (billing?.billingSource === 'subscription' && !billing.providerId) {
      return { providerId: bridge ?? 'anthropic', billingSource };
    }
  }
  return { ...(billingSource === billing?.billingSource ? billing : {}), billingSource };
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
  billing?: UsageBillingSource,
  trace?: unknown,
): TurnUsageDetails | null {
  const hasModelUsageDeltas = Boolean(deltas && deltas.length > 0);
  const uniqueModels = hasModelUsageDeltas ? [...new Set(deltas!.map((delta) => delta.model))] : undefined;
  const perModelCost = perModel
    ?.filter(item => item.money && item.money.amount > 0)
    .map(item => ({ model: item.model, money: item.money!, ...claudeModelBilling(item, billing) }));
  return buildTurnUsageDetails({
    ...billing,
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
    model: uniqueModels?.length === 1 ? uniqueModels[0] : hasModelUsageDeltas ? undefined : fallbackModel,
    models: uniqueModels,
    perModelTokens: perModel?.map(item => ({ model: item.model, ...item.deltas, ...claudeModelBilling(item, billing) })),
    perModelCost: perModelCost && perModelCost.length > 0 ? perModelCost : undefined,
    durationMs,
    turnDurationMs,
    trace,
  });
}
