/** Opt-in read capability; old hosts ignore it and retain snapshot/null replies. */
export const CLAUDE_QUOTA_STATE_READ = 'cindy-quota-state-v1';
export interface ClaudeQuotaClear { quotaState: 'unlimited' | 'invalidated' }
export function isClaudeQuotaClear(value: unknown): value is ClaudeQuotaClear {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ['unlimited', 'invalidated'].includes((value as ClaudeQuotaClear).quotaState);
}
