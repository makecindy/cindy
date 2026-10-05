import { describe, expect, it } from 'vitest';
import { isLocalOnlyProviderForAgent, isOpenAiSubscriptionProvider, providerCatalogId, isCustomRoutedProvider, isOrganizationManagedProvider } from '../provider-identity.js';
import type { Provider } from '../types.js';

describe('connection identity vs public catalog identity', () => {
  it.each([
    ['openai', 'codex', [false, true, true]],
    ['openai-account', 'codex', [true, true, true]],
    // Claude 订阅只在本机 Claude Code 的登录里,远端(SSH)任务一律不可用。
    ['anthropic', 'claude', [true, true, true]],
    ['claude-account', 'claude', [true, true, true]],
    ['xai', 'xai', [true, true, false]],
    ['grok-account', 'xai', [true, true, false]],
  ] as const)('matches SSH adapters for %s', (id, native, expected) => {
    const provider = { id, auth: { method: 'oauth', native }, routing: {} } as Provider;
    expect(['codex', 'claude-code', 'pi'].map((agent) =>
      isLocalOnlyProviderForAgent(provider, agent as 'codex' | 'claude-code' | 'pi'),
    )).toEqual(expected);
    const api = { ...provider, auth: { method: 'apiKey' as const } };
    expect(isLocalOnlyProviderForAgent(api, 'pi')).toBe(false);
  });
  it('aliases only native OpenAI subscription metadata', () => {
    for (const provider of [
      { id: 'openai', auth: { method: 'oauth' as const } },
      { id: 'independent-account', auth: { method: 'oauth' as const, native: 'codex' as const } },
    ]) {
      expect(isOpenAiSubscriptionProvider(provider)).toBe(true);
      expect(providerCatalogId(provider)).toBe('openai');
    }
  });
  it('keeps API connections and unrelated OAuth connections independent', () => {
    for (const provider of [
      { id: 'openai-api-copy', auth: { method: 'apiKey' as const } },
      { id: 'anthropic-account', auth: { method: 'oauth' as const } },
    ]) {
      expect(isOpenAiSubscriptionProvider(provider)).toBe(false);
      expect(providerCatalogId(provider)).toBe(provider.id);
    }
  });
});

describe('organization vs user provider source', () => {
  it('treats enterprise connections as custom-routed, not user-owned', () => {
    const org = { source: 'organization' as const };
    const user = { source: 'user' as const };
    const builtin = { source: 'builtin' as const };
    expect(isCustomRoutedProvider(org)).toBe(true);
    expect(isCustomRoutedProvider(user)).toBe(true);
    expect(isCustomRoutedProvider(builtin)).toBe(false);
    expect(isOrganizationManagedProvider(org)).toBe(true);
    expect(isOrganizationManagedProvider(user)).toBe(false);
    expect(isOrganizationManagedProvider(builtin)).toBe(false);
  });
});
