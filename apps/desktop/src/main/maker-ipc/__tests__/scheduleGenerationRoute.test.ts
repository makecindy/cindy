import { describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import {
  resolveBoundSessionGenerationRoute,
  shouldResolveBoundSessionGenerationRoute,
} from '../scheduleGenerationRoute.js';

const providers = [
  {
    id: 'xd',
    name: 'XD',
    source: 'builtin',
    connected: true,
    agents: ['claude-code'],
    auth: { method: 'managed' },
    routing: { 'claude-code': { upstream: 'https://xd.example', authStrategy: 'gateway-key' } },
    models: { 'claude-code': [{ id: 'claude-sonnet', name: 'Sonnet', contextWindow: 200_000 }] },
  },
  {
    id: 'custom-claude',
    name: 'Custom Claude',
    source: 'user',
    connected: true,
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { upstream: 'https://custom.example', authStrategy: 'api-key-header' } },
    models: { 'claude-code': [{ id: 'claude-connect-4-6', name: 'Claude Connect', contextWindow: 200_000 }] },
  },
] as unknown as ProviderView[];

describe('resolveBoundSessionGenerationRoute', () => {
  it('uses the explicit provider stored for the bound session', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-connect-4-6' },
      sessionProviderId: 'custom-claude',
      providers,
    })).toEqual({ providerId: 'custom-claude', agentKind: 'claude-code', model: 'claude-connect-4-6' });
  });

  it('materializes the effective provider when the session follows the default source', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      providers,
    })).toEqual({ providerId: 'xd', agentKind: 'claude-code', model: 'claude-sonnet' });
  });

  it('fails closed when the bound session has no routable model', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: '' },
      sessionProviderId: 'custom-claude',
      providers,
    })).toBeNull();
  });

  it('fails closed when the persisted source no longer serves the session model', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: 'custom-claude',
      providers,
    })).toBeNull();
  });

  it('does not select a disconnected default provider for a bound session', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      providers: providers.map((provider) => provider.id === 'xd'
        ? { ...provider, connected: false }
        : provider),
    })).toBeNull();
  });

  it('fails closed when the explicit source only offers a non-chat copy of the persisted model id (issue #882 第 3 点, 2026-07 review 第 17 轮)', () => {
    const providersWithNonChatCopy = providers.map((provider) => provider.id === 'custom-claude'
      ? {
        ...provider,
        models: {
          'claude-code': [
            { id: 'claude-connect-4-6', name: 'Claude Connect', contextWindow: 200_000, mode: 'embedding' },
          ],
        },
      }
      : provider) as unknown as ProviderView[];
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-connect-4-6' },
      sessionProviderId: 'custom-claude',
      providers: providersWithNonChatCopy,
    })).toBeNull();
  });
});

describe('shouldResolveBoundSessionGenerationRoute', () => {
  it('resolves the session route when the bound request omits provider and model', () => {
    expect(shouldResolveBoundSessionGenerationRoute({
      targetSessionId: 'session-1',
      providerId: undefined,
      model: undefined,
    })).toBe(true);
  });

  it('keeps an explicit task route for a persistent schedule with targetSessionId', () => {
    expect(shouldResolveBoundSessionGenerationRoute({
      targetSessionId: 'session-1',
      providerId: 'tapsvc',
      model: 'gpt-5.5',
    })).toBe(false);
  });
});
