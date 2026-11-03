import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scope: 0,
  tokens: new Map<string, string>(),
  fetchXai: vi.fn(),
  outboundFetch: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(state.scope),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/subscription-account-auth.js', () => ({
  subscriptionAccountKind: (id: string) => (id.startsWith('claude') ? 'claude' : 'xai'),
}));
vi.mock('../../maker-host/grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: (id: string) => state.tokens.has(id),
  getGrokAccessToken: async (id: string) => state.tokens.get(id),
}));
vi.mock('../../maker-host/provider-route.js', () => ({
  isProviderRouteMutationInProgress: () => false,
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({
  outboundFetch: (...args: unknown[]) => state.outboundFetch(...args),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  addProviderSecretsClearedListener: vi.fn(),
}));
vi.mock('../xaiSubscriptionUsage.js', () => ({
  fetchXaiSubscriptionUsageSnapshot: (...args: unknown[]) => state.fetchXai(...args),
  XaiSubscriptionUsageRateLimitedError: class extends Error {},
  XaiSubscriptionUsageUnauthorizedError: class extends Error {},
}));
import {
  readSubscriptionAccountUsage,
  setSubscriptionAccountUsageBroadcaster,
  syncSubscriptionAccountUsage,
  triggerSubscriptionAccountUsage,
} from '../subscriptionAccountUsage.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('subscription provider quota isolation', () => {
  beforeEach(() => {
    state.scope++;
    state.tokens.clear();
    state.fetchXai.mockReset();
    state.outboundFetch.mockReset();
    setSubscriptionAccountUsageBroadcaster(() => {});
  });
  it('xai keeps A and B snapshots separate and clears only the logged out account', async () => {
    const a = 'xai-a',
      b = 'xai-b';
    const clearInstant = vi.fn();
    setSubscriptionAccountUsageBroadcaster(() => {}, clearInstant);
    state.tokens.set(a, 'test-token-a');
    state.tokens.set(b, 'test-token-b');
    state.fetchXai.mockImplementation(async ({ accessToken }) => ({
      updatedAt: accessToken === 'test-token-a' ? 1 : 2,
    }));
    await Promise.all([readSubscriptionAccountUsage(a), readSubscriptionAccountUsage(b)]);
    await settle();
    expect(await readSubscriptionAccountUsage(a)).toMatchObject({ updatedAt: 1 });
    expect(await readSubscriptionAccountUsage(b)).toMatchObject({ updatedAt: 2 });
    state.tokens.delete(a);
    await syncSubscriptionAccountUsage(a);
    expect(clearInstant).toHaveBeenCalledExactlyOnceWith(a);
    expect(await readSubscriptionAccountUsage(a)).toBeNull();
    expect(await readSubscriptionAccountUsage(b)).toMatchObject({ updatedAt: 2 });
  });
  it('retired claude accounts have no quota reader and never touch the network', async () => {
    const clearInstant = vi.fn();
    const broadcast = vi.fn();
    setSubscriptionAccountUsageBroadcaster(broadcast, clearInstant);
    state.tokens.set('claude-a', 'test-token');
    expect(await readSubscriptionAccountUsage('claude-a')).toBeNull();
    triggerSubscriptionAccountUsage('claude-a');
    await syncSubscriptionAccountUsage('claude-a');
    await settle();
    expect(await readSubscriptionAccountUsage('claude-a')).toBeNull();
    expect(clearInstant).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(state.fetchXai).not.toHaveBeenCalled();
    expect(state.outboundFetch).not.toHaveBeenCalled();
  });
  it('xai rejects a previous owner response', async () => {
    const id = 'xai-a';
    state.tokens.set(id, 'test-token');
    let resolve!: (value: unknown) => void;
    state.fetchXai.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const broadcast = vi.fn();
    setSubscriptionAccountUsageBroadcaster(broadcast);
    await readSubscriptionAccountUsage(id);
    await settle();
    state.scope++;
    resolve({ updatedAt: 4 });
    await settle();
    expect(broadcast).not.toHaveBeenCalledWith(id, expect.objectContaining({ updatedAt: 4 }));
  });
});
