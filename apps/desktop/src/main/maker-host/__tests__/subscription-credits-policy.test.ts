import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  autoUseCredits: true,
  providers: [] as ProviderView[],
  payload: null as unknown,
}));

vi.mock('../provider-credits-policy-store.js', () => ({
  providerCreditsPolicy: { autoUses: () => state.autoUseCredits },
}));
vi.mock('../../usageBroadcaster.js', () => ({
  peekCodexAccountUsageSnapshot: () => state.payload,
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: state.providers }),
}));

import {
  creditsPolicyBlocksRequest,
  projectSubscriptionCreditsPolicy,
  subscriptionCreditsRequestBlocked,
} from '../subscription-credits-policy.js';

const NOW = 1_800_000_000_000;
const subscription = {
  id: 'openai',
  auth: { method: 'oauth', native: 'codex' },
} as ProviderView;
const customApi = {
  id: 'openai',
  auth: { method: 'apiKey' },
} as ProviderView;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    secondary: { usedPercent: 100, resetsAt: NOW / 1000 + 3600 },
    credits: { hasCredits: true, unlimited: false },
    ...overrides,
  };
}

afterEach(() => {
  state.autoUseCredits = true;
  state.providers = [];
  state.payload = null;
});

describe('subscription credits policy', () => {
  it('blocks only when the user opted out and the weekly window is exhausted with credits available', () => {
    expect(creditsPolicyBlocksRequest(subscription, false, snapshot(), NOW)).toBe(true);
    expect(creditsPolicyBlocksRequest(subscription, true, snapshot(), NOW)).toBe(false);
    expect(creditsPolicyBlocksRequest(customApi, false, snapshot(), NOW)).toBe(false);
  });

  it('ignores a five-hour window when the weekly window is still available', () => {
    expect(
      creditsPolicyBlocksRequest(
        subscription,
        false,
        {
          primary: { usedPercent: 100, windowMinutes: 300, resetsAt: NOW / 1000 + 3600 },
          secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: NOW / 1000 + 3600 },
          credits: { hasCredits: true, unlimited: false },
        },
        NOW,
      ),
    ).toBe(false);
  });
  it('does not block without a spendable balance or after the reset time has passed', () => {
    expect(
      creditsPolicyBlocksRequest(
        subscription,
        false,
        snapshot({ credits: { hasCredits: false, unlimited: false } }),
        NOW,
      ),
    ).toBe(false);
    expect(
      creditsPolicyBlocksRequest(
        subscription,
        false,
        snapshot({ secondary: { usedPercent: 100, resetsAt: NOW / 1000 - 1 } }),
        NOW,
      ),
    ).toBe(false);
  });

  it('checks app-server buckets and the web snapshot for the same account', () => {
    expect(
      creditsPolicyBlocksRequest(
        subscription,
        false,
        {
          secondary: { usedPercent: 10, resetsAt: NOW / 1000 + 3600 },
          credits: { hasCredits: true, unlimited: false },
          appServerBuckets: {
            spark: {
              secondary: { usedPercent: 100, resetsAt: NOW / 1000 + 3600 },
            },
          },
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('projects the stored value without mutating the provider definition', () => {
    state.autoUseCredits = false;
    expect(projectSubscriptionCreditsPolicy(subscription).subscriptionCreditsPolicy).toEqual({
      autoUseCredits: false,
    });
    expect(subscription.subscriptionCreditsPolicy).toBeUndefined();
    expect(projectSubscriptionCreditsPolicy(customApi)).toBe(customApi);
  });

  it('reads the live account snapshot for the request path', () => {
    state.providers = [subscription];
    state.autoUseCredits = false;
    state.payload = snapshot();
    expect(subscriptionCreditsRequestBlocked('openai', NOW)).toBe(true);
    state.autoUseCredits = true;
    expect(subscriptionCreditsRequestBlocked('openai', NOW)).toBe(false);
  });
});
