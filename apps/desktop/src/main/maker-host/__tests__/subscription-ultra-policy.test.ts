import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  allowUltra: false,
  providers: [] as ProviderView[],
}));

vi.mock('../provider-ultra-policy-store.js', () => ({
  providerUltraPolicy: { allows: () => state.allowUltra },
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: state.providers }),
}));

import {
  applySubscriptionUltraPolicy,
  projectSubscriptionUltraPolicy,
  subscriptionUltraAllowed,
  ultraPolicyEffort,
} from '../subscription-ultra-policy.js';

const subscription = {
  id: 'openai',
  auth: { method: 'oauth', native: 'codex' },
  models: {
    codex: [
      {
        id: 'gpt-6.1-sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        displayEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'ultra',
      },
    ],
  },
} as unknown as ProviderView;
const customApi = {
  id: 'openai',
  auth: { method: 'apiKey' },
  models: { codex: [] },
} as unknown as ProviderView;

afterEach(() => {
  state.allowUltra = false;
  state.providers = [];
});

describe('subscription Ultra policy', () => {
  it('falls back from Ultra only when the provider opt-in is off', () => {
    expect(ultraPolicyEffort(false, 'ultra', ['high', 'max', 'ultra'])).toBe('max');
    expect(ultraPolicyEffort(false, 'ultra', ['high', 'xhigh', 'ultra'])).toBe('xhigh');
    expect(ultraPolicyEffort(false, 'ultra', ['high', 'ultra'])).toBeNull();
    expect(ultraPolicyEffort(true, 'ultra', ['high', 'ultra'])).toBe('ultra');
    expect(ultraPolicyEffort(false, 'high', ['high', 'ultra'])).toBe('high');
  });

  it('hides Ultra from projected capabilities and repairs the default effort', () => {
    const projected = projectSubscriptionUltraPolicy(subscription);
    expect(projected.subscriptionUltraPolicy).toEqual({ allowUltra: false });
    expect(projected.models.codex?.[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(projected.models.codex?.[0].displayEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(projected.models.codex?.[0].defaultEffort).toBe('max');
    expect(subscription.models.codex?.[0].efforts).toContain('ultra');
    expect(projectSubscriptionUltraPolicy(customApi)).toBe(customApi);
  });

  it('keeps Ultra when the provider opt-in is on', () => {
    state.allowUltra = true;
    expect(projectSubscriptionUltraPolicy(subscription).models).toEqual(subscription.models);
  });

  it('rewrites saved Ultra requests at the request boundary', () => {
    state.providers = [subscription];
    expect(
      applySubscriptionUltraPolicy(
        { model: 'gpt-6.1-sol', reasoning: { effort: 'ultra' } },
        'openai',
      ),
    ).toEqual({ model: 'gpt-6.1-sol', reasoning: { effort: 'max' } });
    state.allowUltra = true;
    expect(
      applySubscriptionUltraPolicy(
        { model: 'gpt-6.1-sol', reasoning: { effort: 'ultra' } },
        'openai',
      ),
    ).toBeNull();
  });

  it('reads the provider policy for the request path', () => {
    state.providers = [subscription];
    expect(subscriptionUltraAllowed('openai')).toBe(false);
    state.allowUltra = true;
    expect(subscriptionUltraAllowed('openai')).toBe(true);
    expect(subscriptionUltraAllowed('custom')).toBe(true);
  });
});
