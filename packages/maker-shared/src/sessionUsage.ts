/**
 * Conversation usage and cost summary (ROADMAP 1.9a).
 *
 * Turns normalised per-turn usage records into the numbers the session cost panel shows. It owns no
 * clock, reads no store and prices nothing by itself: rates are supplied by the caller (the desktop
 * pricing layer resolves them from the model registry). The panel and the adapter that reads real
 * turns belong to 1.9b.
 *
 * Per-turn detail already exists (`apps/desktop/src/shared/turnUsageDetails.ts`, stored in
 * `messages.agent_meta`, with recorded money on the claude-code path). This module is the roll-up
 * across turns that nothing else provides, plus the rate-based price for turns that carry no
 * recorded money (Hermes, Codex, Pi). It cannot import desktop code, so the adapter maps one to the
 * other.
 *
 * Two rules are deliberate and must not be relaxed:
 * - A local turn is tokens only. It is never priced, even when the caller hands it rates.
 * - A turn is priced only when every non-zero token category has a rate and a currency. A missing
 *   rate makes the turn unpriced instead of silently under-reporting the cost.
 */

import { formatCompactTokens } from './usageFormat.js';

/** Per-million-token rates. `currency` is required: an amount without a unit is not a price. */
export interface UsageRates {
  inputPerMtok?: number;
  outputPerMtok?: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
  currency?: string;
}

/** Recorded money already attached to a stored turn. `currency` is required. */
export interface SessionUsageMoney {
  amount?: number;
  currency?: string;
}

/** One turn as the caller normalises it. Every token field is optional and non-finite input is 0. */
export interface SessionUsageTurn {
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Ran on a local endpoint (LM Studio, Ollama, llama.cpp). Tokens only, never a cost. */
  local?: boolean;
  /** Recorded turn money (e.g. from `turnUsageDetails.perModelCost`). Wins over `rates`. */
  money?: SessionUsageMoney;
  rates?: UsageRates;
}

export interface SessionUsageModelTotal {
  model: string;
  provider?: string;
  local: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Sum of this model's priced turns, or null when the model is tokens-only. */
  cost: number | null;
  currency?: string;
}

/**
 * `complete`: every non-local turn was priced. `partial`: some were, some could not be.
 * `none`: nothing could be priced (all local, all unpriced, or no turns).
 */
export type SessionUsageCostStatus = 'complete' | 'partial' | 'none';

export interface SessionUsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Compact token label, e.g. "12.4k". Same formatter the message footer uses. */
  tokensLabel: string;
  costStatus: SessionUsageCostStatus;
  /** Sum of the priced turns that share `currency`. 0 when nothing is priced. */
  cost: number;
  currency?: string;
  /** Models whose turns could not be priced (missing rate, missing currency, or another currency). */
  unpricedModels: string[];
  models: SessionUsageModelTotal[];
}

/** Money is summed in floats; six decimals is well past any provider's real precision. */
const COST_DECIMALS = 6;

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function toRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundCost(value: number): number {
  const factor = 10 ** COST_DECIMALS;
  return Math.round(value * factor) / factor;
}

interface PricedTurn {
  cost: number;
  currency: string;
}

function priceFromRecordedMoney(money: SessionUsageMoney | undefined): PricedTurn | null {
  if (!money || typeof money !== 'object') return null;
  const currency = typeof money.currency === 'string' ? money.currency.trim() : '';
  const amount = toRate(money.amount);
  if (!currency || amount === undefined || amount <= 0) return null;
  return { cost: amount, currency };
}

/**
 * Prices one turn, or returns null when it cannot be priced honestly.
 * A category with tokens but no rate makes the whole turn unpriced.
 */
function priceTurn(turn: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rates: UsageRates;
}): PricedTurn | null {
  const currency = typeof turn.rates.currency === 'string' ? turn.rates.currency.trim() : '';
  if (!currency) return null;
  const categories: Array<[number, number | undefined]> = [
    [turn.inputTokens, toRate(turn.rates.inputPerMtok)],
    [turn.outputTokens, toRate(turn.rates.outputPerMtok)],
    [turn.cacheReadTokens, toRate(turn.rates.cacheReadPerMtok)],
    [turn.cacheWriteTokens, toRate(turn.rates.cacheWritePerMtok)],
  ];
  let cost = 0;
  for (const [tokens, rate] of categories) {
    if (tokens === 0) continue;
    if (rate === undefined) return null;
    cost += (tokens / 1_000_000) * rate;
  }
  // Unrounded on purpose: rounding every turn first would lose sub-micro precision before the sum.
  return { cost, currency };
}

interface Accumulator {
  model: string;
  provider?: string;
  local: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
  currency?: string;
}

/**
 * Aggregates turns into a summary. Never throws: malformed records are skipped rather than
 * reported, because the panel must still show the turns that are readable.
 */
export function buildSessionUsage(turns: readonly SessionUsageTurn[]): SessionUsageSummary {
  const byModel = new Map<string, Accumulator>();
  let currency: string | undefined;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  const unpricedModels = new Set<string>();

  for (const turn of Array.isArray(turns) ? turns : []) {
    const model = typeof turn?.model === 'string' ? turn.model.trim() : '';
    if (!model) continue;

    const inputTokens = toCount(turn.inputTokens);
    const outputTokens = toCount(turn.outputTokens);
    const cacheReadTokens = toCount(turn.cacheReadTokens);
    const cacheWriteTokens = toCount(turn.cacheWriteTokens);
    const local = turn.local === true;
    const provider = typeof turn.provider === 'string' && turn.provider.trim()
      ? turn.provider.trim()
      : undefined;

    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        model,
        ...(provider ? { provider } : {}),
        local,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: null,
      };
      byModel.set(model, acc);
    }
    acc.turns += 1;
    // A model counts as local only when every one of its turns was local.
    acc.local = acc.local && local;
    acc.inputTokens += inputTokens;
    acc.outputTokens += outputTokens;
    acc.cacheReadTokens += cacheReadTokens;
    acc.cacheWriteTokens += cacheWriteTokens;

    if (local) continue;

    const priced =
      priceFromRecordedMoney(turn.money) ??
      (turn.rates
        ? priceTurn({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, rates: turn.rates })
        : null);
    if (!priced) {
      unpricedTurns += 1;
      unpricedModels.add(model);
      continue;
    }
    currency ??= priced.currency;
    if (priced.currency !== currency) {
      // Summing across currencies would produce a number with no unit. Leave it out instead.
      unpricedTurns += 1;
      unpricedModels.add(model);
      continue;
    }
    pricedTurns += 1;
    acc.cost = (acc.cost ?? 0) + priced.cost;
    acc.currency = currency;
  }

  const models: SessionUsageModelTotal[] = [...byModel.values()]
    .map((acc) => ({
      ...acc,
      cost: acc.cost === null ? null : roundCost(acc.cost),
      totalTokens: acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cost = 0;
  for (const acc of byModel.values()) {
    inputTokens += acc.inputTokens;
    outputTokens += acc.outputTokens;
    cacheReadTokens += acc.cacheReadTokens;
    cacheWriteTokens += acc.cacheWriteTokens;
    cost += acc.cost ?? 0;
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const costStatus: SessionUsageCostStatus =
    pricedTurns === 0 ? 'none' : unpricedTurns > 0 ? 'partial' : 'complete';

  return {
    turns: models.reduce((sum, model) => sum + model.turns, 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    tokensLabel: formatCompactTokens(totalTokens),
    costStatus,
    cost: roundCost(cost),
    ...(currency ? { currency } : {}),
    unpricedModels: [...unpricedModels].sort((a, b) => a.localeCompare(b)),
    models,
  };
}
