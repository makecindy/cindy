/** Only display tiers explicitly reported by the upstream. Unknown plans remain visible. */
export function formatClaudeSubscriptionPlanLabel(
  subscriptionType: unknown,
  planTier?: unknown,
  planDisplayName?: unknown,
): string | null {
  const displayName = typeof planDisplayName === 'string' ? planDisplayName.trim() : '';
  // Older CLI text can say just "Max" even when JSON reports the exact multiplier.
  const genericMax = displayName.toLowerCase() === 'max'
    && typeof subscriptionType === 'string' && subscriptionType.trim().toLowerCase() === 'max';
  if (displayName && !genericMax) return displayName;
  if (typeof subscriptionType !== 'string' || !subscriptionType.trim()) return null;
  const plan = subscriptionType.trim();
  if (plan.toLowerCase() === 'max') {
    if (planTier === 'max_5x') return 'Max 5×';
    if (planTier === 'max_20x') return 'Max 20×';
  }
  if (displayName) return displayName;
  const known: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
  return known[plan.toLowerCase()] ?? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
}

export function formatCodexPlanLabel(planType: unknown): string | null {
  if (typeof planType !== 'string' || !planType.trim()) return null;
  const plan = planType.trim();
  const known: Record<string, string> = {
    free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team',
    self_serve_business_usage_based: 'Self Serve Business Usage Based', business: 'Business',
    enterprise_cbp_usage_based: 'Enterprise CBP Usage Based', enterprise: 'Enterprise', edu: 'Edu', unknown: 'Unknown',
  };
  return known[plan.toLowerCase()] ?? plan.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}
