import type { ProviderShareMemberBudget } from '../../shared/providerShareBudget.js';
import { memberBudgetStatus, type MemberTokenSnapshot } from './providerShareBudgetCalculation.js';
import { unifiedModelKeyId } from '@cindy/model-providers';

const matches = (models: string[], model: string) => models.some(id => unifiedModelKeyId(id) === unifiedModelKeyId(model));

/** Member identity and the ledger are supplied by the authenticated host. */
export function createMemberBudgetService(deps: {
  readPolicy(providerId: string, memberId: string): ProviderShareMemberBudget | null;
  readUsage(providerId: string, memberId: string): MemberTokenSnapshot;
  modelAvailable(providerId: string, memberId: string, model: string): boolean;
}) {
  function status(providerId: string, memberId: string, preview = false) {
    const policy = deps.readPolicy(providerId, memberId)
      ?? (preview ? { basis: 'member-input-output-7d' as const, enabled: false, recommendedModel: null, rules: [] } : null);
    if (!policy) return null;
    const result = memberBudgetStatus(deps.readUsage(providerId, memberId), policy);
    const recommended = result.recommendedModel;
    if (recommended && (!deps.modelAvailable(providerId, memberId, recommended)
      || result.rules.some(rule => matches(rule.models, recommended) && rule.wouldBlock))) result.recommendedModel = null;
    return result;
  }
  function allows(providerId: string, model: string, memberId?: string): boolean {
    // Owner and same-account calls never read a member policy or ledger.
    if (!memberId) return true;
    try {
      const policy = deps.readPolicy(providerId, memberId);
      if (!policy?.enabled || !policy.rules.some(rule => matches(rule.models, model))) return true;
      return status(providerId, memberId)?.rules.find(rule => matches(rule.models, model))?.blocked === false;
    } catch { return false; }
  }
  function denial(providerId: string, model: string, memberId?: string) {
    if (allows(providerId, model, memberId)) return null;
    return { code: 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED',
      message: '[REMOTE_AGENT_MEMBER_BUDGET_PAUSED] This model is paused by your shared-provider model limit. Choose another available model; check your usage in Remote & Sharing.' };
  }
  function assertAllowed(providerId: string, model: string, memberId?: string): void {
    const error = denial(providerId, model, memberId);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
  }
  return { status, allows, denial, assertAllowed };
}
