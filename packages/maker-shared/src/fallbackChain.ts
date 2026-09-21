/**
 * Fallback model chains — pure decision logic, no I/O.
 *
 * A chain is an ordered list: the main model first, then one or more fallbacks.
 * When an attempt fails, this module answers one question: retry the same
 * model, move to the next one, or stop.
 *
 * The retry rule mirrors the one Cindy already applies to terminal 429s
 * (see `agents/codex/terminal-rate-limit-retry.ts`): a transient failure is
 * worth one more attempt, but account/plan quota exhaustion is not — a short
 * backoff cannot refill a weekly bucket, so waiting only delays the fallback.
 * Keeping that distinction here means a chain never burns time retrying a
 * model that has definitively run out.
 */

import { matchesDeterministicUsageExhaustionText } from './errorRedaction.js';

/** One model in a chain. `uid` is stable across reorders; the rest is routing. */
export interface FallbackChainEntry {
  uid: string;
  providerId: string;
  modelId: string;
  /** Engine/harness id (`codex`, `claude-code`, `pi`, …). */
  agent: string;
  effort?: string | undefined;
  fast?: boolean | undefined;
}

/**
 * A saved chain. `entries[0]` is the main model; `entries[1..]` are fallbacks
 * in order. A chain with fewer than two entries carries no fallback behaviour
 * and is treated as absent.
 */
export interface FallbackChain {
  entries: FallbackChainEntry[];
  /** Disabled chains keep their configuration but never alter routing. */
  enabled: boolean;
}

/** Maximum retries of a single entry before advancing. Deliberately one. */
export const FALLBACK_CHAIN_MAX_RETRIES_PER_ENTRY = 1;

/** Hard ceiling on chain length; keeps the picker row readable and bounds worst-case latency. */
export const FALLBACK_CHAIN_MAX_ENTRIES = 8;

/**
 * Convert legacy vendor engine ids to the canonical harness ids used by the
 * picker and runtime. Older Cindy builds persisted Claude rows as `cc`.
 */
export function normalizeFallbackAgent(agent: string): string {
  return agent === 'cc' ? 'claude-code' : agent;
}

/**
 * Why an attempt failed, reduced to what the chain needs to decide.
 *
 * `usageExhausted` means the account or plan is out of capacity: retrying is
 * pointless. `transient` covers overload, timeouts and short rate limits,
 * where one more attempt is reasonable. `fatal` covers request-shaped errors
 * (bad input, context overflow) that another identical attempt cannot fix and
 * that a different model probably cannot fix either.
 */
export type FallbackFailureKind = 'usageExhausted' | 'transient' | 'fatal';

export interface FallbackFailure {
  message: string;
  status?: number | undefined;
  /** Structured vendor tag when the runtime supplies one. */
  tag?: string | undefined;
}

/** Vendor tags that mean "out of capacity", not "try again shortly". */
const USAGE_EXHAUSTION_TAGS = new Set(['usageLimitExceeded', 'sessionBudgetExceeded']);

/** Tags and statuses that no retry and no sibling model can repair. */
const FATAL_TAGS = new Set(['context_length_exceeded', 'invalid_request_error']);

/**
 * Classify a failure.
 *
 * Order matters: the structured tag wins when present, because it is the
 * runtime's own verdict. Deterministic quota text is checked next — a message
 * saying the plan is exhausted is authoritative even when it also carries 429.
 * Only then do bare status codes apply.
 */
export function classifyFallbackFailure(failure: FallbackFailure): FallbackFailureKind {
  const tag = failure.tag ?? '';
  if (USAGE_EXHAUSTION_TAGS.has(tag)) return 'usageExhausted';
  if (FATAL_TAGS.has(tag)) return 'fatal';
  if (matchesDeterministicUsageExhaustionText(failure.message)) return 'usageExhausted';
  const status = failure.status;
  if (status === 401 || status === 403) return 'fatal';
  if (status === 400 || status === 404 || status === 422) return 'fatal';
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) {
    return 'transient';
  }
  return 'transient';
}

/** Position within a chain run. */
export interface FallbackChainState {
  /** Index into `entries`. */
  index: number;
  /** Retries already spent on `entries[index]`. */
  retries: number;
}

export type FallbackDecision =
  | { action: 'retry'; entry: FallbackChainEntry; state: FallbackChainState }
  | { action: 'advance'; entry: FallbackChainEntry; state: FallbackChainState; from: FallbackChainEntry }
  | { action: 'stop'; reason: 'chain-exhausted' | 'fatal' };

/**
 * Decide what to do after `entries[state.index]` fails.
 *
 * - `fatal` stops the chain: a malformed request or revoked credential is not
 *   a capacity problem, and silently rerunning it against every model in the
 *   list wastes quota to reach the same error.
 * - `usageExhausted` advances immediately, with no retry.
 * - `transient` retries once, then advances.
 */
export function decideFallbackStep(
  chain: FallbackChain,
  state: FallbackChainState,
  failure: FallbackFailure,
): FallbackDecision {
  const entry = chain.entries[state.index];
  if (!entry) return { action: 'stop', reason: 'chain-exhausted' };

  const kind = classifyFallbackFailure(failure);
  if (kind === 'fatal') return { action: 'stop', reason: 'fatal' };

  if (kind === 'transient' && state.retries < FALLBACK_CHAIN_MAX_RETRIES_PER_ENTRY) {
    return { action: 'retry', entry, state: { index: state.index, retries: state.retries + 1 } };
  }

  const nextIndex = state.index + 1;
  const next = chain.entries[nextIndex];
  if (!next) return { action: 'stop', reason: 'chain-exhausted' };
  return {
    action: 'advance',
    entry: next,
    from: entry,
    state: { index: nextIndex, retries: 0 },
  };
}

/** Starting position for a fresh run. */
export function initialFallbackChainState(): FallbackChainState {
  return { index: 0, retries: 0 };
}

/**
 * Whether a chain actually changes behaviour. A disabled chain, or one with
 * only a main model, routes exactly as it would without this feature.
 */
export function isFallbackChainActive(chain: FallbackChain | null | undefined): boolean {
  return !!chain && chain.enabled && chain.entries.length > 1;
}

/**
 * Stable identity for one chain entry.
 *
 * Effort is part of the identity on purpose: the picker lists the same model at
 * several thinking levels, and "Opus·high then Opus·low" is a legitimate chain.
 * Leaving effort out would make the second pick look like a duplicate of the
 * first and get silently dropped.
 *
 * Provider id carries the account, so the same model under two logins stays two
 * distinct targets — which is the whole point of a fallback.
 */
export function fallbackEntryUid(
  entry: Pick<FallbackChainEntry, 'providerId' | 'modelId' | 'agent'> & { effort?: string | undefined },
): string {
  return [entry.providerId, entry.modelId, normalizeFallbackAgent(entry.agent), entry.effort ?? ''].join('::');
}

/**
 * Drop duplicates and over-long tails.
 *
 * The same (provider, model, engine) twice in a row adds latency without
 * adding a real alternative, so later duplicates are removed rather than
 * rejected — the user's intent is still honoured, just deduplicated.
 */
export function normalizeFallbackChain(chain: FallbackChain): FallbackChain {
  const seen = new Set<string>();
  const entries: FallbackChainEntry[] = [];
  for (const entry of chain.entries) {
    const normalizedEntry: FallbackChainEntry = {
      ...entry,
      agent: normalizeFallbackAgent(entry.agent),
      uid: fallbackEntryUid(entry),
    };
    const uid = normalizedEntry.uid;
    if (seen.has(uid)) continue;
    seen.add(uid);
    entries.push(normalizedEntry);
    if (entries.length >= FALLBACK_CHAIN_MAX_ENTRIES) break;
  }
  return { entries, enabled: chain.enabled };
}
