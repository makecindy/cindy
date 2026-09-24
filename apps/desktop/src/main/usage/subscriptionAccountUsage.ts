import { addProviderSecretsClearedListener } from '../secrets/providerSecretStore.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { subscriptionAccountKind } from '../maker-host/subscription-account-auth.js';
import { getGrokAccessToken, hasGrokOAuthLogin } from '../maker-host/grok-oauth-login.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { isProviderRouteMutationInProgress } from '../maker-host/provider-route.js';
import { createXaiSubscriptionUsageReader } from './xaiSubscriptionUsageRefresh.js';
import {
  fetchXaiSubscriptionUsageSnapshot,
  XaiSubscriptionUsageRateLimitedError,
  XaiSubscriptionUsageUnauthorizedError,
} from './xaiSubscriptionUsage.js';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';

type Snapshot = ClaudeSubscriptionUsageSnapshot | XaiSubscriptionUsageSnapshot;
let broadcast: (providerId: string, snapshot: Snapshot | null) => void = () => {};
let clearInstantUsage: (providerId: string) => void = () => {};
export function setSubscriptionAccountUsageBroadcaster(
  handler: typeof broadcast,
  clear?: typeof clearInstantUsage,
): void {
  broadcast = handler;
  clearInstantUsage = clear ?? (() => {});
}

// These are display caches. Credentials stay in the host credential store, and
// existing reader factories retain their throttle, retry and stale-response rules.
const readers = new Map<string, ReturnType<typeof createReader>>();
addProviderSecretsClearedListener(() => readers.clear());
function createReader(providerId: string) {
  const scope = activeOwnerScopeKey();
  const current = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope;
  let snapshot: Snapshot | null = null;
  const record = async (value: Snapshot | null) => {
    if (!current()) return;
    snapshot = value;
    broadcast(providerId, value);
  };
  const common = {
    now: Date.now,
    clearSnapshot: () => record(null),
    recordSnapshot: record,
    onRefreshError: () => {},
  };
  return createXaiSubscriptionUsageReader({
    ...common,
    readCredentials: async () => {
      if (!current() || !hasGrokOAuthLogin(providerId)) return null;
      const accessToken = await getGrokAccessToken(providerId);
      return current() ? { accessToken } : null;
    },
    fetchSnapshot: (credentials) =>
      isProviderRouteMutationInProgress(providerId)
        ? Promise.resolve(null)
        : fetchXaiSubscriptionUsageSnapshot({
            accessToken: credentials.accessToken,
            fetchFn: outboundFetch,
          }),
    readCachedSnapshot: async () =>
      current() ? (snapshot as XaiSubscriptionUsageSnapshot | null) : null,
    isUnauthorizedError: (error) => error instanceof XaiSubscriptionUsageUnauthorizedError,
    isRateLimitedError: (error) => error instanceof XaiSubscriptionUsageRateLimitedError,
  });
}
function reader(providerId: string) {
  // 独立 Claude 账号已停用:没有凭证可用,也就没有余量可查。
  if (subscriptionAccountKind(providerId) !== 'xai') return null;
  const key = `${activeOwnerScopeKey()}:${providerId}`;
  let value = readers.get(key);
  if (!value) {
    value = createReader(providerId);
    readers.set(key, value);
  }
  return value;
}
export function readSubscriptionAccountUsage(providerId: string) {
  if (isProviderRouteMutationInProgress(providerId))
    throw new Error('Provider credentials are being updated');
  return reader(providerId)?.read() ?? Promise.resolve(null);
}
export function triggerSubscriptionAccountUsage(providerId: string): void {
  if (!isProviderRouteMutationInProgress(providerId)) reader(providerId)?.triggerRefresh();
}
export async function syncSubscriptionAccountUsage(providerId: string): Promise<void> {
  if (subscriptionAccountKind(providerId) === 'xai') clearInstantUsage(providerId);
  await reader(providerId)?.syncForCredentialChange();
}
