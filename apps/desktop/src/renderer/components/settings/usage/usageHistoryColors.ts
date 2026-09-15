import type { UsageAgentKind } from './usageHistoryStats';

/** Usage History category colors only; homepage money and task palettes stay neutral. */
const MODEL_COLORS = [
  'var(--usage-model-1)',
  'var(--usage-model-2)',
  'var(--usage-model-3)',
  'var(--usage-model-4)',
  'var(--usage-model-5)',
] as const;

/**
 * Keep the approved first five hues. Later groups rotate those themed hues by the
 * golden angle, retaining their lightness/chroma instead of fading toward gray.
 * CSS resolves from the active theme, including live Light/Dark switches.
 * Rank comes from the complete history, never the currently filtered table.
 */
export function usageHistoryModelColor(rank: number, colorCount: number): string {
  if (!Number.isInteger(rank) || rank < 0 || rank >= colorCount) return 'var(--text-tertiary)';
  const base = MODEL_COLORS[rank % MODEL_COLORS.length];
  const group = Math.floor(rank / MODEL_COLORS.length);
  if (group === 0) return base;
  const hueRotation = (group * 137.50776405) % 360;
  return `oklch(from ${base} l c calc(h + ${hueRotation.toFixed(3)}))`;
}

/** Claude/Codex use engine colors; pi uses the owner-chosen teal. Never follow rank. */
export function usageHistoryAgentColor(agentKind: UsageAgentKind): string {
  const colors: Record<UsageAgentKind, string> = {
    'claude-code': 'var(--engine-badge-cc)',
    codex: 'var(--engine-badge-codex)',
    pi: MODEL_COLORS[0],
    'grok-build': 'var(--engine-badge-grok-build)',
  };
  return colors[agentKind];
}
