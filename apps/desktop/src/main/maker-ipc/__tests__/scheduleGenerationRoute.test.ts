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

  it('uses an explicit task provider with the bound session model', () => {
    const providersWithSessionModel = providers.map((provider) => provider.id === 'custom-claude'
      ? {
        ...provider,
        models: {
          'claude-code': [
            ...(provider.models['claude-code'] ?? []),
            { id: 'claude-sonnet', name: 'Sonnet', contextWindow: 200_000 },
          ],
        },
      }
      : provider) as unknown as ProviderView[];
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: 'xd',
      requestedProviderId: 'custom-claude',
      providers: providersWithSessionModel,
    })).toEqual({ providerId: 'custom-claude', agentKind: 'claude-code', model: 'claude-sonnet' });
  });

  it('keeps the bound session provider when only the task model is explicit', () => {
    const providersWithBothModels = providers.map((provider) => provider.id === 'xd'
      ? {
        ...provider,
        models: {
          'claude-code': [
            ...(provider.models['claude-code'] ?? []),
            { id: 'claude-connect-4-6', name: 'Claude Connect', contextWindow: 200_000 },
          ],
        },
      }
      : provider) as unknown as ProviderView[];
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: 'xd',
      requestedModel: 'claude-connect-4-6',
      providers: providersWithBothModels,
    })).toEqual({ providerId: 'xd', agentKind: 'claude-code', model: 'claude-connect-4-6' });
  });

  it('uses a new-route provider when only the task model is explicit and the session has no provider', () => {
    const providersWithRetiredDefault = providers.map((provider) => provider.id === 'xd'
      ? {
        ...provider,
        models: {
          'claude-code': [
            ...(provider.models['claude-code'] ?? []),
            { id: 'claude-connect-4-6', name: 'Claude Connect', contextWindow: 200_000, status: 'retired' as const },
          ],
        },
      }
      : provider.id === 'custom-claude'
        ? {
          ...provider,
          models: {
            'claude-code': [
              ...(provider.models['claude-code'] ?? []),
              { id: 'claude-connect-4-6', name: 'Claude Connect', contextWindow: 200_000 },
            ],
          },
        }
        : provider) as unknown as ProviderView[];
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      requestedModel: 'claude-connect-4-6',
      providers: providersWithRetiredDefault,
    })).toEqual({ providerId: 'custom-claude', agentKind: 'claude-code', model: 'claude-connect-4-6' });
  });

  it('materializes the effective provider when the session follows the default source', () => {
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      providers,
    })).toEqual({ providerId: 'xd', agentKind: 'claude-code', model: 'claude-sonnet' });
  });

  it('keeps the implicit source for a running session after its model is retired', () => {
    const retiredProviders = providers.map((provider) => provider.id === 'xd'
      ? {
        ...provider,
        models: {
          'claude-code': provider.models['claude-code']?.map((model) => ({
            ...model,
            status: 'retired' as const,
          })),
        },
      }
      : provider);
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      providers: retiredProviders,
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

  it('does not relax the chat capability boundary for an implicit resumed source', () => {
    const nonChatProviders = providers.map((provider) => provider.id === 'xd'
      ? {
        ...provider,
        models: {
          'claude-code': provider.models['claude-code']?.map((model) => ({
            ...model,
            mode: 'embedding',
          })),
        },
      }
      : provider);
    expect(resolveBoundSessionGenerationRoute({
      session: { agentKind: 'claude-code', model: 'claude-sonnet' },
      sessionProviderId: null,
      providers: nonChatProviders,
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
  it('resolves the session route when the renderer marks a bound target', () => {
    expect(shouldResolveBoundSessionGenerationRoute({
      targetSessionId: 'session-1',
      resolveBoundSessionRoute: true,
    })).toBe(true);
  });

  it('keeps an explicit task route for a persistent schedule with targetSessionId', () => {
    expect(shouldResolveBoundSessionGenerationRoute({
      targetSessionId: 'session-1',
      resolveBoundSessionRoute: false,
    })).toBe(false);
  });
});
