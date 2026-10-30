/** The remote Claude account uses the same snapshot contract as a local account. */
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';
import { createRemoteDeviceUsageMirror } from './remoteDeviceUsageMirror';

const mirror = createRemoteDeviceUsageMirror<ClaudeSubscriptionUsageSnapshot>({
  invokeChannel: 'maker:usage:claude-subscription',
  pushChannel: 'usage:claude-subscription-changed',
  defaultProviderId: 'anthropic',
  providerPushChannel: 'usage:subscription-provider-account-changed',
});
export const useRemoteClaudeSubscriptionUsage = mirror.useMirror;
export const requestRemoteClaudeSubscriptionRefresh = mirror.request;
export const resetRemoteClaudeSubscriptionUsageCacheForTest = mirror.resetForTest;

export function reduceRemoteClaudeSubscriptionPush(
  current: ClaudeSubscriptionUsageSnapshot | null,
  payload: unknown,
): ClaudeSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as ClaudeSubscriptionUsageSnapshot)
    : current;
}
