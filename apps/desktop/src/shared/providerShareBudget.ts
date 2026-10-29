import { unifiedModelKeyId } from '@cindy/model-providers';

/** Shares of one member's recorded input + output tokens, excluding cache. */
export interface ProviderShareBudgetRule {
  id: string;
  /** One model from this provider's catalog. */
  models: string[];
  maxPercent: number;
}
export interface ProviderShareMemberBudget {
  /** Explicit discriminator: never reinterpret an old account-quota estimate as a token ratio. */
  basis: 'member-input-output-7d';
  enabled: boolean;
  recommendedModel: string | null;
  rules: ProviderShareBudgetRule[];
}
export type ProviderShareBudgetState = 'recorded' | 'empty' | 'unavailable';
export interface ProviderShareBudgetStatus {
  state: ProviderShareBudgetState;
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  /** Next local midnight changes the window; it does not guarantee recovery. */
  nextWindowAt: number;
  totalTokens: number | null;
  /** Owner editor only: lets an unsaved rule use the same recorded window. */
  modelUsage?: Array<{ model: string; tokens: number }>;
  rules: Array<{ id: string; models: string[]; tokens: number | null; usedPercent: number | null; limitPercent: number; wouldBlock: boolean; blocked: boolean }>;
  recommendedModel: string | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const percent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
export function isProviderShareMemberBudget(value: unknown): value is ProviderShareMemberBudget {
  if (!record(value) || value.basis !== 'member-input-output-7d' || typeof value.enabled !== 'boolean'
    || !(value.recommendedModel === null || identifier(value.recommendedModel))
    || !Array.isArray(value.rules) || value.rules.length > 32) return false;
  const ids = new Set<string>();
  const models = new Set<string>();
  for (const rule of value.rules) {
    if (!record(rule) || !identifier(rule.id) || ids.has(rule.id) || !percent(rule.maxPercent)
      || !Array.isArray(rule.models) || rule.models.length !== 1) return false;
    ids.add(rule.id);
    const model = rule.models[0];
    if (!identifier(model) || models.has(unifiedModelKeyId(model))) return false;
    models.add(unifiedModelKeyId(model));
  }
  return true;
}
export function isMemberBudgetPaused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]');
}
