import { companyModelTokens, type CaptureCompanyUsage } from './companyTokenFacts.js';
import type { CompanyTokenCounts } from './companyTokenQueue.js';
import { normalizeModelIdForPricing, normalizeTurnUsageSegments, sumTurnUsageSegments } from './turnCostCalculator.js';

/** Only split a Codex turn across models when the segments reconcile to its four final counters. */
export function codexTurnSegments(raw: unknown, counts: CompanyTokenCounts) {
  const segments = normalizeTurnUsageSegments(raw);
  const sum = sumTurnUsageSegments(segments);
  const reliable = segments.length > 0 && sum.inputTokens === counts.input && sum.outputTokens === counts.output &&
    sum.cacheReadTokens === counts.cacheRead && sum.cacheCreateTokens === counts.cacheWrite;
  return { segments, reliable };
}

export function recordCompanyCodexTokens(
  record: CaptureCompanyUsage, parts: ReturnType<typeof codexTurnSegments>,
  counts: CompanyTokenCounts, fallbackModel: string | undefined,
) {
  if (parts.reliable) {
    record(parts.segments.flatMap(segment => segment.model
      ? [companyModelTokens(normalizeModelIdForPricing(segment.model), segment)] : []));
  } else if (typeof fallbackModel === 'string' && fallbackModel.length) {
    record([{ model: normalizeModelIdForPricing(fallbackModel), ...counts }]);
  }
}
