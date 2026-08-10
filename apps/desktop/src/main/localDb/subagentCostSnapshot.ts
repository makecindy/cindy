/**
 * Computes a cost snapshot for a subagent run at termination time.
 *
 * The result maps directly to the `cost_*` columns in the subagentRuns table.
 * This is a pure function with no side effects and no external imports beyond types.
 */

export interface SubagentCostSnapshotInput {
  provider: 'claude-code' | 'codex' | 'pi';
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** PI reports actual cost in USD */
  reportedCostUsd?: number;
}

export interface SubagentCostSnapshotColumns {
  costQuality: 'actual' | 'estimated' | 'unavailable';
  costTotalTokens: number | null;
  costInputTokens: number | null;
  costOutputTokens: number | null;
  costCacheReadTokens: number | null;
  costCacheCreateTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  costApproximate: boolean | null;
  costFrozenAt: number;
}

// Reference rates per million tokens (USD)
const RATE_INPUT_PER_MILLION = 3;
const RATE_OUTPUT_PER_MILLION = 15;
const RATE_CACHE_READ_PER_MILLION = 0.30;
const RATE_CACHE_CREATE_PER_MILLION = 3.75;

/** Round to 6 decimal places to avoid floating point noise. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function tokensToUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const cost =
    (inputTokens / 1_000_000) * RATE_INPUT_PER_MILLION +
    (outputTokens / 1_000_000) * RATE_OUTPUT_PER_MILLION +
    (cacheReadTokens / 1_000_000) * RATE_CACHE_READ_PER_MILLION +
    (cacheCreateTokens / 1_000_000) * RATE_CACHE_CREATE_PER_MILLION;
  return roundCost(cost);
}

function safeNonNegativeInt(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function computeSubagentCostSnapshot(
  input: SubagentCostSnapshotInput,
): SubagentCostSnapshotColumns {
  const costFrozenAt = Date.now();

  // Case 1: PI with reported actual cost
  if (
    input.provider === 'pi' &&
    typeof input.reportedCostUsd === 'number' &&
    Number.isFinite(input.reportedCostUsd)
  ) {
    const totalTokens = safeNonNegativeInt(input.totalTokens);
    const inputTokens = safeNonNegativeInt(input.inputTokens);
    const outputTokens = safeNonNegativeInt(input.outputTokens);
    const cacheReadTokens = safeNonNegativeInt(input.cacheReadTokens);
    const cacheCreateTokens = safeNonNegativeInt(input.cacheCreateTokens);
    return {
      costQuality: 'actual',
      costTotalTokens: totalTokens,
      costInputTokens: inputTokens,
      costOutputTokens: outputTokens,
      costCacheReadTokens: cacheReadTokens,
      costCacheCreateTokens: cacheCreateTokens,
      costAmount: roundCost(input.reportedCostUsd),
      costCurrency: 'USD',
      costApproximate: false,
      costFrozenAt,
    };
  }

  // Case 2: Claude Code with extended token breakdown
  if (
    typeof input.inputTokens === 'number' &&
    Number.isFinite(input.inputTokens) &&
    input.inputTokens >= 0 &&
    typeof input.outputTokens === 'number' &&
    Number.isFinite(input.outputTokens) &&
    input.outputTokens >= 0
  ) {
    const inputTokens = Math.floor(input.inputTokens);
    const outputTokens = Math.floor(input.outputTokens);
    const cacheReadTokens = safeNonNegativeInt(input.cacheReadTokens) ?? 0;
    const cacheCreateTokens = safeNonNegativeInt(input.cacheCreateTokens) ?? 0;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
    const costAmount = tokensToUsd(inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
    return {
      costQuality: 'estimated',
      costTotalTokens: totalTokens,
      costInputTokens: inputTokens,
      costOutputTokens: outputTokens,
      costCacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : null,
      costCacheCreateTokens: cacheCreateTokens > 0 ? cacheCreateTokens : null,
      costAmount,
      costCurrency: 'USD',
      costApproximate: true,
      costFrozenAt,
    };
  }

  // Case 3: Codex with only totalTokens
  if (
    typeof input.totalTokens === 'number' &&
    Number.isFinite(input.totalTokens) &&
    input.totalTokens > 0
  ) {
    const totalTokens = Math.floor(input.totalTokens);
    // Assume 70% input / 30% output split
    const estimatedInput = Math.floor(totalTokens * 0.7);
    const estimatedOutput = totalTokens - estimatedInput;
    const costAmount = tokensToUsd(estimatedInput, estimatedOutput, 0, 0);
    return {
      costQuality: 'estimated',
      costTotalTokens: totalTokens,
      costInputTokens: null,
      costOutputTokens: null,
      costCacheReadTokens: null,
      costCacheCreateTokens: null,
      costAmount,
      costCurrency: 'USD',
      costApproximate: true,
      costFrozenAt,
    };
  }

  // Case 4: Nothing useful available
  return {
    costQuality: 'unavailable',
    costTotalTokens: null,
    costInputTokens: null,
    costOutputTokens: null,
    costCacheReadTokens: null,
    costCacheCreateTokens: null,
    costAmount: null,
    costCurrency: null,
    costApproximate: null,
    costFrozenAt,
  };
}
