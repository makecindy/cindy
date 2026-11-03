import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  owner: 'owner',
  supplier: true,
  group: true,
  executor: true,
  binding: null as { providerId: string; groupDeviceId?: string } | null,
  providers: [] as ProviderView[],
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../../provider-group/bindings.js', () => ({
  readProviderGroupBinding: () => state.binding,
}));
vi.mock('../../provider-group/store.js', () => ({
  readProviderGroup: () => ({ allowFast: state.group }),
}));
vi.mock('../../provider-group/fastPolicyStore.js', () => ({
  groupFastPolicyStore: { allows: () => state.executor },
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: state.providers }),
}));
vi.mock('../provider-fast-policy-store.js', () => ({
  providerFastPolicy: { allows: () => state.supplier },
}));
import {
  createSubscriptionFastPolicy,
  notifySubscriptionFastPolicyChanged,
  projectSubscriptionFastPolicy,
} from '../subscription-fast-policy.js';

const subscription = {
  id: 'my-login',
  auth: { method: 'oauth', native: 'codex' },
  models: { codex: [{ id: 'gpt-6.1-sol', supportsFastMode: true, supportsUltrafastMode: true }] },
} as unknown as ProviderView;
const customApi = { ...subscription, id: 'openai', auth: { method: 'apiKey' } } as ProviderView;
afterEach(() => {
  state.owner = 'owner';
  state.supplier = state.group = state.executor = true;
  state.binding = null;
  state.providers = [];
});

describe('subscription-only policy composition and catalog projection', () => {
  it('projects effective capabilities without overwriting native capabilities or custom APIs', () => {
    state.supplier = false;
    const projected = projectSubscriptionFastPolicy(subscription);
    expect(projected.subscriptionFastPolicy).toEqual({ allowFast: false, groupAllowsFast: true });
    expect(projected.models.codex?.[0]).toMatchObject({
      supportsFastMode: false,
      supportsUltrafastMode: false,
    });
    expect(subscription.models.codex?.[0].supportsFastMode).toBe(true);
    expect(projectSubscriptionFastPolicy(customApi)).toBe(customApi);
    state.supplier = true;
    expect(projectSubscriptionFastPolicy(subscription).models).toBe(subscription.models);
  });

  it('combines supplier, local group and authenticated executor constraints, scoped to subscriptions', () => {
    state.providers = [subscription, customApi];
    let provider = subscription.id;
    const policy = createSubscriptionFastPolicy('task', () => provider);
    expect(policy.isAllowed()).toBe(true);
    state.group = false;
    expect(policy.isAllowed()).toBe(true); // direct use does not inherit an unrelated group
    state.binding = { providerId: subscription.id };
    expect(policy.isAllowed()).toBe(false);
    state.binding = { providerId: subscription.id, groupDeviceId: 'group-owner' };
    expect(policy.isAllowed()).toBe(true); // remote owner enforces on the selected executor
    state.executor = false;
    expect(policy.isAllowed()).toBe(false);
    provider = customApi.id;
    state.supplier = false;
    expect(policy.isAllowed()).toBe(true);
    state.owner = 'another-owner';
    expect(policy.isAllowed()).toBe(false);
  });

  it('notifies a running task, retries a failed native update, and never enables Fast on relaxation', async () => {
    state.providers = [subscription];
    const policy = createSubscriptionFastPolicy('task', () => subscription.id);
    const listener = vi
      .fn()
      .mockRejectedValueOnce(Error('native busy'))
      .mockResolvedValue(undefined);
    const off = policy.subscribe(listener);
    try {
      state.supplier = false;
      await expect(notifySubscriptionFastPolicyChanged()).rejects.toThrow('native busy');
      await notifySubscriptionFastPolicyChanged();
      await notifySubscriptionFastPolicyChanged();
      expect(listener).toHaveBeenCalledTimes(2);
      state.supplier = true;
      await notifySubscriptionFastPolicyChanged();
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      off();
    }
  });

  it('retains standard at the exit after relaxation until an explicit enable, scoped to task, source and owner', () => {
    state.providers = [subscription, customApi];
    const policy = createSubscriptionFastPolicy('suppressed-task', () => subscription.id);
    state.supplier = false;
    policy.onFastModeChanged!(false);
    state.supplier = true;
    expect(policy.isAllowed()).toBe(true);
    expect(policy.isRequestAllowed!()).toBe(false);
    expect(
      createSubscriptionFastPolicy('another-task', () => subscription.id).isRequestAllowed!(),
    ).toBe(true);
    expect(
      createSubscriptionFastPolicy('suppressed-task', () => customApi.id).isRequestAllowed!(),
    ).toBe(true);
    policy.onFastModeChanged!(true);
    expect(policy.isRequestAllowed!()).toBe(true);
    policy.onFastModeChanged!(false);
    state.providers = [{ ...subscription, auth: { method: 'apiKey' } } as ProviderView];
    expect(policy.isRequestAllowed!()).toBe(true);
    state.providers = [subscription, customApi];
    state.owner = 'new-owner';
    const otherOwner = createSubscriptionFastPolicy('suppressed-task', () => subscription.id);
    expect(otherOwner.isRequestAllowed!()).toBe(true);
    policy.onFastModeChanged!(false);
    expect(otherOwner.isRequestAllowed!()).toBe(true);
  });
});
