import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scope: 0,
  tokens: new Map<string, string>(),
  prepare: vi.fn(),
  fetchClaude: vi.fn(),
  fetchXai: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(state.scope),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/subscription-account-auth.js', () => ({
  subscriptionAccountKind: (id: string) => (id.startsWith('claude') ? 'claude' : 'xai'),
  readClaudeAccountOAuth: (id: string) =>
    state.tokens.has(id) ? { accessToken: state.tokens.get(id) } : null,
  prepareClaudeAccountUsage: (id: string) => state.prepare(id),
}));
vi.mock('../../maker-host/grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: (id: string) => state.tokens.has(id),
  getGrokAccessToken: async (id: string) => state.tokens.get(id),
}));
vi.mock('../../maker-host/provider-route.js', () => ({
  isProviderRouteMutationInProgress: () => false,
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  addProviderSecretsClearedListener: vi.fn(),
}));
vi.mock('../claudeSubscriptionUsage.js', () => ({
  fetchClaudeSubscriptionUsageSnapshot: (...args: unknown[]) => state.fetchClaude(...args),
  ClaudeSubscriptionUsageRateLimitedError: class extends Error {},
  ClaudeSubscriptionUsageUnauthorizedError: class extends Error {},
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
} from '../subscriptionAccountUsage.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('subscription provider quota isolation', () => {
  beforeEach(() => {
    state.scope++;
    state.tokens.clear();
    state.prepare
      .mockReset()
      .mockImplementation(async (id) => ({
        accessToken: state.tokens.get(id),
        subscriptionType: 'max',
      }));
    state.fetchClaude.mockReset();
    state.fetchXai.mockReset();
    setSubscriptionAccountUsageBroadcaster(() => {});
  });
  it.each(['claude', 'xai'])(
    '%s keeps A and B snapshots separate and clears only the logged out account',
    async (kind) => {
      const a = `${kind}-a`,
        b = `${kind}-b`;
      state.tokens.set(a, 'test-token-a');
      state.tokens.set(b, 'test-token-b');
      const fetch = kind === 'claude' ? state.fetchClaude : state.fetchXai;
      fetch.mockImplementation(async ({ accessToken }) => ({
        updatedAt: accessToken === 'test-token-a' ? 1 : 2,
      }));
      await Promise.all([readSubscriptionAccountUsage(a), readSubscriptionAccountUsage(b)]);
      await settle();
      expect(await readSubscriptionAccountUsage(a)).toMatchObject({ updatedAt: 1 });
      expect(await readSubscriptionAccountUsage(b)).toMatchObject({ updatedAt: 2 });
      state.tokens.delete(a);
      await syncSubscriptionAccountUsage(a);
      expect(await readSubscriptionAccountUsage(a)).toBeNull();
      expect(await readSubscriptionAccountUsage(b)).toMatchObject({ updatedAt: 2 });
    },
  );
  it('refreshes Claude quota immediately after its token rotates', async () => {
    state.tokens.set('claude-a', 'test-old');
    state.prepare.mockImplementation(async () => {
      state.tokens.set('claude-a', 'test-new');
      return { accessToken: 'test-new', subscriptionType: 'max' };
    });
    state.fetchClaude.mockResolvedValue({ updatedAt: 3 });
    await readSubscriptionAccountUsage('claude-a');
    await settle();
    expect(state.fetchClaude).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'test-new' }),
    );
    expect(await readSubscriptionAccountUsage('claude-a')).toMatchObject({ updatedAt: 3 });
  });
  it.each(['claude', 'xai'])('%s rejects a previous owner response', async (kind) => {
    const id = `${kind}-a`;
    state.tokens.set(id, 'test-token');
    let resolve!: (value: unknown) => void;
    const fetch = kind === 'claude' ? state.fetchClaude : state.fetchXai;
    fetch.mockReturnValue(
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
