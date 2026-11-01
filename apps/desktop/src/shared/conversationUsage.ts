/**
 * Shared pure conversation usage adapter (ROADMAP 1.9b-2 / 1.9b-3).
 *
 * Maps stored per-turn usage facts (`messages.agent_meta.turnUsageDetails`) into
 * the 1.9a conversation usage model (`@cindy/maker-shared/session-usage`).
 * Lives in `src/shared/` so both `src/main/usage/conversationUsageAdapter.ts` and
 * the renderer (`SessionUsagePanel.tsx`) can consume it without crossing the
 * `renderer -> main` process boundary.
 */

import type { AgentKind } from '@cindy/model-providers';
import {
  buildSessionUsage,
  type SessionUsageMoney,
  type SessionUsageSummary,
  type SessionUsageTurn,
  type UsageRates,
} from '@cindy/maker-shared/session-usage';

import { getModelPriceQuote } from './modelPriceQuote.js';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type RegionalMoney,
} from './regionalMoney.js';
import {
  normalizeTurnUsageDetails,
  type TurnUsageDetails,
} from './turnUsageDetails.js';

/** One stored turn input accepted by the conversation usage adapter. */
export interface StoredConversationUsageTurn {
  /** Parsed or raw `messages.agent_meta.turnUsageDetails`. */
  turnUsageDetails?: TurnUsageDetails | unknown;
  /** Optional turn-level recorded money fallback when `perModelCost` is absent. */
  turnMoney?: RegionalMoney | unknown;
  /** Session or message model fallback when `turnUsageDetails.model` is absent. */
  model?: string | null;
  /** Session provider fallback when `turnUsageDetails.provider` is absent. */
  provider?: string | null;
  /** Agent kind that produced the turn (`hermes`, `claude-code`, `codex`, `pi`). */
  agent?: AgentKind | null;
  /** True when the turn ran on a local endpoint (Ollama, LM Studio, llama.cpp). */
  local?: boolean;
}

export interface ConversationUsagePricingContext {
  /** XD gateway pricing catalog (`getGatewayModelPricingForModel()`). */
  gatewayPricing?: ModelPricingCatalog | null;
  /** Non-XD reference pricing catalog (`getReferenceModelPricing()`). */
  referencePricing?: ModelPricingCatalog | null;
  /** Default session model when a turn omitted `model`. */
  defaultModel?: string | null;
  /** Default session provider when a turn omitted `provider`. */
  defaultProvider?: string | null;
  /** Default session agent kind used for agent-scoped reference quotes. */
  agent?: AgentKind | null;
  /** Provider ids known to be local endpoints (tokens only, never priced). */
  localProviders?: ReadonlySet<string> | readonly string[];
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeModelIdForPricing(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'unknown';
  const stripped = trimmed.replace(/\[[^\]]*\]\s*$/, '').trim();
  return stripped || 'unknown';
}

function toProviderSet(
  localProviders: ConversationUsagePricingContext['localProviders'],
): ReadonlySet<string> {
  if (!localProviders) return new Set();
  if (localProviders instanceof Set) return localProviders;
  return new Set(
    Array.from(localProviders)
      .map((item) => cleanText(item))
      .filter((item): item is string => Boolean(item)),
  );
}

/**
 * Extracts recorded money from a turn's `perModelCost` list (or `turnMoney` fallback).
 * Returns undefined when no positive money is recorded or when `perModelCost` entries
 * span incompatible currencies (so `buildSessionUsage` leaves the mixed turn unpriced
 * rather than silently dropping one currency's share).
 */
export function resolveRecordedTurnMoney(
  details: TurnUsageDetails,
  fallbackTurnMoney?: RegionalMoney | unknown,
): SessionUsageMoney | undefined {
  if (details.perModelCost && details.perModelCost.length > 0) {
    const monies = details.perModelCost
      .map((entry) => normalizeRegionalMoney(entry?.money))
      .filter((money): money is RegionalMoney => Boolean(money && money.amount > 0));
    if (monies.length === 0) return undefined;
    const currencies = new Set(monies.map((money) => money.currency));
    if (currencies.size > 1) return undefined;
    const summed = addCompatibleRegionalMoney(monies, monies[0].currency);
    return summed && summed.amount > 0
      ? { amount: summed.amount, currency: summed.currency }
      : undefined;
  }
  const direct = normalizeRegionalMoney(fallbackTurnMoney);
  if (direct && direct.amount > 0) {
    return { amount: direct.amount, currency: direct.currency };
  }
  return undefined;
}

/**
 * Projects a `ModelPriceQuote` into `UsageRates` for a specific turn's token counts.
 * Respects `inputTokenPriceBands` and gateway `costDiscount`. Returns undefined when
 * the turn falls outside bounded reference bands.
 */
export function quoteToUsageRates(
  quote: ModelPriceQuote | undefined,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  },
): UsageRates | undefined {
  if (!quote) return undefined;
  const totalInputTokens =
    tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  const band = quote.inputTokenPriceBands
    ?.filter(
      (candidate) =>
        totalInputTokens >= candidate.minInputTokens &&
        (candidate.maxInputTokens === undefined || totalInputTokens < candidate.maxInputTokens),
    )
    .sort((a, b) => b.minInputTokens - a.minInputTokens)[0];
  if (quote.inputTokenPriceBands?.length && !band && quote.source !== 'gateway') {
    return undefined;
  }

  const discount =
    quote.source === 'gateway' &&
    typeof quote.costDiscount === 'number' &&
    Number.isFinite(quote.costDiscount) &&
    quote.costDiscount > 0 &&
    quote.costDiscount <= 1
      ? quote.costDiscount
      : 0;
  const factor = 1 - discount;
  const scale = (rate: number | undefined): number | undefined =>
    typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate * factor : undefined;

  const inputPerMtok = scale(band?.inputPerMtok ?? quote.inputPerMtok);
  const outputPerMtok = scale(band?.outputPerMtok ?? quote.outputPerMtok);
  const cacheReadPerMtok = scale(band?.cacheReadPerMtok ?? quote.cacheReadPerMtok);
  const cacheWritePerMtok = scale(band?.cacheCreatePerMtok ?? quote.cacheCreatePerMtok);

  return {
    currency: quote.currency,
    ...(inputPerMtok !== undefined ? { inputPerMtok } : {}),
    ...(outputPerMtok !== undefined ? { outputPerMtok } : {}),
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheWritePerMtok !== undefined ? { cacheWritePerMtok } : {}),
  };
}

/**
 * Looks up a `ModelPriceQuote` for `(providerId, modelId, agent)` across the
 * desktop pricing catalogs: `'xd'` reads `gatewayPricing` only; every other
 * provider reads `referencePricing` only (matching `resolveModelPricePresentation`).
 */
export function lookupTurnPriceQuote(
  providerId: string | undefined,
  modelId: string | undefined,
  agent: AgentKind | undefined,
  context: Pick<ConversationUsagePricingContext, 'gatewayPricing' | 'referencePricing'>,
): ModelPriceQuote | undefined {
  const normalizedProvider = cleanText(providerId);
  const rawModel = cleanText(modelId);
  if (!normalizedProvider || !rawModel) return undefined;
  const pricingModel = normalizeModelIdForPricing(rawModel);
  if (!pricingModel || pricingModel === 'unknown') return undefined;
  const catalog =
    normalizedProvider === 'xd' ? context.gatewayPricing : context.referencePricing;
  return (
    getModelPriceQuote(catalog, normalizedProvider, pricingModel, agent) ??
    (pricingModel !== rawModel
      ? getModelPriceQuote(catalog, normalizedProvider, rawModel, agent)
      : undefined)
  );
}

/**
 * Adapts one stored turn (`messages.agent_meta.turnUsageDetails`) into a
 * `SessionUsageTurn` ready for `buildSessionUsage`. Returns `null` when the
 * input carries no usable token details or model id.
 */
export function adaptStoredTurnToSessionUsageTurn(
  stored: StoredConversationUsageTurn,
  context: ConversationUsagePricingContext = {},
): SessionUsageTurn | null {
  if (!stored || typeof stored !== 'object') return null;
  const details =
    normalizeTurnUsageDetails(stored.turnUsageDetails) ??
    (stored.turnUsageDetails && typeof stored.turnUsageDetails === 'object'
      ? normalizeTurnUsageDetails(stored)
      : undefined);
  if (!details || details.totalTokens <= 0) return null;

  const model =
    cleanText(details.model) ??
    (details.models?.length === 1 ? cleanText(details.models[0]) : undefined) ??
    cleanText(stored.model) ??
    cleanText(context.defaultModel);
  if (!model) return null;

  const provider =
    cleanText(details.provider) ??
    cleanText(stored.provider) ??
    cleanText(context.defaultProvider);
  const agent = stored.agent ?? context.agent ?? undefined;
  const localProviders = toProviderSet(context.localProviders);
  const local = stored.local === true || Boolean(provider && localProviders.has(provider));

  const tokens = {
    inputTokens: details.inputTokens,
    outputTokens: details.outputTokens,
    cacheReadTokens: details.cacheReadTokens,
    cacheCreateTokens: details.cacheCreateTokens,
  };

  if (local) {
    return {
      model,
      ...(provider ? { provider } : {}),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheCreateTokens,
      local: true,
    };
  }

  const recordedMoney = resolveRecordedTurnMoney(details, stored.turnMoney);
  if (recordedMoney) {
    return {
      model,
      ...(provider ? { provider } : {}),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheCreateTokens,
      money: recordedMoney,
    };
  }

  const quote = lookupTurnPriceQuote(provider, model, agent, context);
  const rates = quoteToUsageRates(quote, tokens);

  return {
    model,
    ...(provider ? { provider } : {}),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheCreateTokens,
    ...(rates ? { rates } : {}),
  };
}

/**
 * Synchronous conversation usage summary from stored turns + already-resolved
 * pricing catalogs.
 */
export function buildConversationUsageFromStoredTurns(
  storedTurns: readonly StoredConversationUsageTurn[],
  context: ConversationUsagePricingContext = {},
): SessionUsageSummary {
  const adapted: SessionUsageTurn[] = [];
  for (const item of Array.isArray(storedTurns) ? storedTurns : []) {
    const turn = adaptStoredTurnToSessionUsageTurn(item, context);
    if (turn) adapted.push(turn);
  }
  return buildSessionUsage(adapted);
}
