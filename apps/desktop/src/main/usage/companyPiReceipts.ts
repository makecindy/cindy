import { normalizeTurnUsageSegments } from './turnCostCalculator.js';
import type { CaptureCompanyUsage } from './companyTokenFacts.js';

/** Only Pi root requests inherit the execution route verified for this turn. */
export function recordCompanyPiRoots(record: CaptureCompanyUsage, receipts: unknown) {
  const seen = new Set<string>();
  for (const row of normalizeTurnUsageSegments(receipts)) {
    if (!row.id || !/^pi:\d+$/.test(row.id) || !row.model || seen.has(row.id)) continue;
    seen.add(row.id);
    record(row.model, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheCreateTokens,
    });
  }
}
