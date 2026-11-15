import type { ProviderShareMemberBudget, ProviderShareBudgetStatus } from '../../shared/providerShareBudget.js';
import { unifiedModelKeyId } from '@cindy/model-providers';

export interface MemberTokenSnapshot {
  available: boolean;
  windowStart: string;
  windowEnd: string;
  nextWindowAt: number;
  models: Array<{ model: string; tokens: number }>;
}
/** Exact arithmetic over the available ledger, not a claim of complete upstream accounting. */
export function memberBudgetStatus(snapshot: MemberTokenSnapshot, policy: ProviderShareMemberBudget): ProviderShareBudgetStatus {
  const models = new Map<string, number>();
  let valid = snapshot.available;
  for (const row of snapshot.models) {
    if (!row.model || !Number.isSafeInteger(row.tokens) || row.tokens < 0) { valid = false; continue; }
    const model = unifiedModelKeyId(row.model);
    models.set(model, (models.get(model) ?? 0) + row.tokens);
  }
  const sum = [...models.values()].reduce((a, b) => a + b, 0);
  valid &&= Number.isSafeInteger(sum);
  const total = valid ? sum : null;
  const rules = policy.rules.map(rule => {
    const tokens = valid ? models.get(unifiedModelKeyId(rule.models[0]!)) ?? 0 : null;
    const usedPercent = total && tokens !== null ? tokens / total * 100 : null;
    // No observations: allow a first request. 100% is unrestricted, including exactly 100%.
    // Existing requests finish; a later request sees the newly recorded ratio.
    const wouldBlock = rule.maxPercent < 100 && (total === null || (total > 0 && tokens! * 100 >= total * rule.maxPercent));
    return { id: rule.id, models: [...rule.models], tokens, usedPercent, limitPercent: rule.maxPercent,
      wouldBlock, blocked: policy.enabled && wouldBlock };
  });
  return { state: total === null ? 'unavailable' : total === 0 ? 'empty' : 'recorded', enabled: policy.enabled,
    windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd, nextWindowAt: snapshot.nextWindowAt,
    totalTokens: total, modelUsage: valid ? [...models].map(([model, tokens]) => ({ model, tokens })) : [],
    rules, recommendedModel: policy.recommendedModel };
}
