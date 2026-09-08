/** Model colors are scoped to Usage History; money/agent/task palettes stay neutral. */
const MODEL_COLORS = [
  'var(--usage-model-1)',
  'var(--usage-model-2)',
  'var(--usage-model-3)',
  'var(--usage-model-4)',
  'var(--usage-model-5)',
] as const;

/** An unlisted model is always neutral, even when fewer than five models exist. */
export function usageHistoryModelColor(rank: number, colorCount: number): string {
  return rank >= 0 && rank < colorCount && rank < MODEL_COLORS.length
    ? MODEL_COLORS[rank]
    : 'var(--text-tertiary)';
}
