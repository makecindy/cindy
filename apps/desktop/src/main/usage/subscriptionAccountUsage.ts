import { createHash } from 'node:crypto';
import { addProviderSecretsClearedListener } from '../secrets/providerSecretStore.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  readClaudeAccountOAuth,
  prepareClaudeAccountUsage,
  subscriptionAccountKind,
} from '../maker-host/subscription-account-auth.js';
import { getGrokAccessToken, hasGrokOAuthLogin } from '../maker-host/grok-oauth-login.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { isProviderRouteMutationInProgress } from '../maker-host/provider-route.js';
import { createClaudeSubscriptionUsageReader } from './claudeSubscriptionUsageRefresh.js';
import { createXaiSubscriptionUsageReader } from './xaiSubscriptionUsageRefresh.js';
import {
  fetchClaudeSubscriptionUsageSnapshot,
  ClaudeSubscriptionUsageRateLimitedError,
  ClaudeSubscriptionUsageUnauthorizedError,
} from './claudeSubscriptionUsage.js';
import {
  fetchXaiSubscriptionUsageSnapshot,
  XaiSubscriptionUsageRateLimitedError,
  XaiSubscriptionUsageUnauthorizedError,
} from './xaiSubscriptionUsage.js';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';

type Snapshot = ClaudeSubscriptionUsageSnapshot | XaiSubscriptionUsageSnapshot;
let broadcast: (providerId: string, snapshot: Snapshot | null) => void = () => {};
export function setSubscriptionAccountUsageBroadcaster(handler: typeof broadcast): void {
  broadcast = handler;
}

// These are display caches. Credentials stay in the host credential store, and
// existing reader factories retain their throttle, retry and stale-response rules.
const readers = new Map<string, ReturnType<typeof createReader>>();
addProviderSecretsClearedListener(() => readers.clear());
function createReader(providerId: string, kind: 'claude' | 'xai') {
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
  if (kind === 'claude')
    return createClaudeSubscriptionUsageReader({
      ...common,
      readCredentials: () => (current() ? readClaudeAccountOAuth(providerId) : null),
      fetchSnapshot: async (original) => {
        if (isProviderRouteMutationInProgress(providerId)) return null;
        const credentials = await prepareClaudeAccountUsage(providerId);
        if (!credentials || !current()) return null;
        if (credentials.accessToken !== original.accessToken) {
          queueMicrotask(() => {
            if (current()) void reader(providerId)?.syncForCredentialChange();
          });
          return null;
        }
        return fetchClaudeSubscriptionUsageSnapshot({
          accessToken: credentials.accessToken,
          subscriptionType: credentials.subscriptionType ?? null,
          fetchFn: outboundFetch,
        });
      },
      readCachedSnapshot: async () =>
        current() ? (snapshot as ClaudeSubscriptionUsageSnapshot | null) : null,
      fingerprintToken: (token) => createHash('sha256').update(token).digest('hex'),
      isUnauthorizedError: (error) => error instanceof ClaudeSubscriptionUsageUnauthorizedError,
      isRateLimitedError: (error) => error instanceof ClaudeSubscriptionUsageRateLimitedError,
    });
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
  const kind = subscriptionAccountKind(providerId);
  if (!kind) return null;
  const key = `${activeOwnerScopeKey()}:${providerId}`;
  let value = readers.get(key);
  if (!value) {
    value = createReader(providerId, kind);
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
  await reader(providerId)?.syncForCredentialChange();
}
