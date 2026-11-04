import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  providers: null as Record<string, boolean> | null,
}));

const policyFile = vi.hoisted(() => ({
  invalidateIfChanged: vi.fn(),
  read: vi.fn(() => ({ providers: state.providers })),
  updateAtomic: vi.fn(),
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'fixture-owner',
  ownerScopedUserDataPath: () => 'C:/fixture/provider-ultra-policy.json',
}));
vi.mock('../override-settings-file.js', () => ({
  createOverrideSettingsFile: () => policyFile,
}));

import { createProviderUltraPolicyStore } from '../provider-ultra-policy-store.js';
const policy = createProviderUltraPolicyStore({
  filePath: () => 'C:/fixture/provider-ultra-policy.json',
  scopeKey: () => 'fixture-owner',
});

afterEach(() => {
  state.providers = null;
  policyFile.invalidateIfChanged.mockClear();
  policyFile.read.mockClear();
});

describe('provider Ultra policy defaults', () => {
  it('allows Ultra when the account has never changed the setting', () => {
    expect(policy.allows('openai')).toBe(true);
  });

  it('allows Ultra when the policy file cannot be read', () => {
    state.providers = null;
    expect(policy.allows('openai')).toBe(true);
  });

  it('only turns Ultra off after an explicit opt-out', () => {
    expect(policy.allows('openai')).toBe(true);
    state.providers = { openai: false };
    expect(policy.allows('openai')).toBe(false);
    state.providers = { openai: true };
    expect(policy.allows('openai')).toBe(true);
    state.providers = { anthropic: false };
    expect(policy.allows('openai')).toBe(true);
  });
});
