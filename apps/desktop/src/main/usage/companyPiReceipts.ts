import { normalizeTurnUsageSegments } from './turnCostCalculator.js';
import { companyModelTokens, type CaptureCompanyUsage, type CompanyModelTokens } from './companyTokenFacts.js';

/** Only Pi root requests inherit the execution route verified for this turn. */
export function recordCompanyPiRoots(record: CaptureCompanyUsage, receipts: unknown) {
  const samples: CompanyModelTokens[] = [];
  const seen = new Set<string>();
  for (const row of normalizeTurnUsageSegments(receipts)) {
    if (!row.id || !/^pi:\d+$/.test(row.id) || !row.model || seen.has(row.id)) continue;
    seen.add(row.id);
    samples.push(companyModelTokens(row.model, row));
  }
  if (samples.length) record(samples);
}
