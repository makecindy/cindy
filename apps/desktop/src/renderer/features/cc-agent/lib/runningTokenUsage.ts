import { formatOutputTokenRateValue } from '@/lib/turnUsageTooltip';

export function formatRunningTokenCount(tokenUsage: number): string {
  return tokenUsage >= 1000
    ? `${(tokenUsage / 1000).toFixed(1)}k`
    : `${tokenUsage}`;
}

export function formatLiveOutputTokenRate(
  outputTokens: number,
  durationMs: number,
  generationReliable: boolean,
): string | null {
  if (!generationReliable) return null;
  return formatOutputTokenRateValue(outputTokens, durationMs);
}

export type RunningUsageMeta =
  | { kind: 'rate'; rate: string }
  | { kind: 'tokens' }
  | { kind: 'none' };

/**
 * Live status prefers generation-only TPS when the harness can prove it.
 * Otherwise fall back to cumulative tokens as soon as they exist. Hiding
 * tokens for the whole `generationActive` window leaves a long empty timer
 * because live output often arrives only at message end.
 */
export function resolveRunningUsageMeta(input: {
  outputTokens: number;
  generationDurationMs: number;
  generationReliable: boolean;
  tokenUsage: number;
}): RunningUsageMeta {
  const rate = formatLiveOutputTokenRate(
    input.outputTokens,
    input.generationDurationMs,
    input.generationReliable,
  );
  if (rate) return { kind: 'rate', rate };
  if (input.tokenUsage > 0) return { kind: 'tokens' };
  return { kind: 'none' };
}
