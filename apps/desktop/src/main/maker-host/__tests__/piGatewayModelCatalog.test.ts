import { describe, expect, it } from 'vitest';

import type { Catalog } from '@cindy/model-providers';

import {
  resolveBundledPiGatewayModelProfile,
  resolveCatalogPiGatewayModelApi,
} from '../pi-gateway-model-catalog.js';

const currentGatewayModelsByApi = {
  'anthropic-messages': [
    'claude-opus-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ],
  'openai-responses': [
    'codex/gpt-5.6-luna',
    'codex/gpt-5.6-sol',
    'codex/gpt-5.6-terra',
    'codex/gpt-5.5',
    'codex/gpt-5.4',
    'codex/gpt-5.4-mini',
    'codex/gpt-5.5:auto',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'meta/muse-spark-1.2',
    'x-ai-grok/grok-4.6',
    'x-ai/grok-4.5',
    'x-ai/grok-4.6',
  ],
  'openai-completions': [
    'qwen/qwen3.7-max',
    'moonshot/kimi-k3',
    'z-ai/glm-5.1',
    'z-ai/glm-5.2',
    'z-ai/glm-5.3',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'moonshotai/kimi-k2.6',
    'deepseek/deepseek-v4-flash-vision-exp',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.8-flash',
    'qwen/qwen3.8-max',
    'tencent/hy3',
    'z-ai/glm-5.3-flash',
  ],
  'google-generative-ai': [
    'google/gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
  ],
} as const;

function serverCatalog(args: {
  presets: Array<{
    id: string;
    protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
    modelId: string;
  }>;
  routes?: Array<{ providerId: string; modelId: string }>;
  gatewayModelId?: string;
}): Catalog {
  return {
    version: '3',
    providers: [],
    presets: args.presets.map(({ id, protocol, modelId }) => ({
      id,
      name: id,
      runtimes: {
        pi: {
          baseUrl: `https://${id}.example/v1`,
          wireProtocol: protocol,
          models: [{ id: modelId, name: modelId }],
        },
      },
    })),
    ...(args.routes
      ? {
          modelRegistry: {
            schemaVersion: 2,
            updatedAt: '2026-08-29T00:00:00.000Z',
            models: [
              {
                id: 'canonical/model',
                name: 'Model',
                routes: [
                  {
                    providerId: 'xd',
                    modelId: args.gatewayModelId ?? 'gateway/model',
                    agents: ['claude-code', 'codex'],
                  },
                  ...args.routes.map((route) => ({
                    ...route,
                    agents: ['claude-code', 'codex'] as const,
                  })),
                ],
              },
            ],
          },
        }
      : {}),
  } as Catalog;
}

describe('Cindy Server Pi Gateway catalog authority', () => {
  it('uses a registry-linked server preset before any exact namespaced alternative', () => {
    const catalog = serverCatalog({
      gatewayModelId: 'moonshot/kimi-k3',
      routes: [{ providerId: 'moonshot-kimi-global', modelId: 'kimi-k3' }],
      presets: [
        {
          id: 'moonshot-kimi-global',
          protocol: 'anthropic-messages',
          modelId: 'kimi-k3',
        },
        { id: 'openrouter', protocol: 'openai-chat', modelId: 'moonshot/kimi-k3' },
      ],
    });
    expect(resolveCatalogPiGatewayModelApi(catalog, 'moonshot/kimi-k3')).toBe(
      'anthropic-messages',
    );
  });

  it('does not borrow an exact namespaced id without a registry provider route', () => {
    const catalog = serverCatalog({
      presets: [{ id: 'openrouter', protocol: 'openai-chat', modelId: 'z-ai/glm-5.2' }],
    });
    expect(resolveCatalogPiGatewayModelApi(catalog, 'z-ai/glm-5.2')).toBeUndefined();
  });

  it('fails closed on conflicting server declarations for one registry identity', () => {
    const catalog = serverCatalog({
      routes: [
        { providerId: 'provider-a', modelId: 'model' },
        { providerId: 'provider-b', modelId: 'model' },
      ],
      presets: [
        { id: 'provider-a', protocol: 'anthropic-messages', modelId: 'model' },
        { id: 'provider-b', protocol: 'openai-chat', modelId: 'model' },
      ],
    });
    expect(resolveCatalogPiGatewayModelApi(catalog, 'gateway/model')).toBeNull();
  });

  it('never borrows a bare model id from an unrelated server preset', () => {
    const catalog = serverCatalog({
      presets: [{ id: 'provider-a', protocol: 'anthropic-messages', modelId: 'same-id' }],
    });
    expect(resolveCatalogPiGatewayModelApi(catalog, 'same-id')).toBeUndefined();
  });

  it('fails closed when Cindy Server retires an exact XD Registry identity', () => {
    const catalog = serverCatalog({
      gatewayModelId: 'moonshot/kimi-k3',
      routes: [{ providerId: 'moonshot-kimi-global', modelId: 'kimi-k3' }],
      presets: [
        { id: 'moonshot-kimi-global', protocol: 'anthropic-messages', modelId: 'kimi-k3' },
      ],
    });
    catalog.modelRegistry!.models[0]!.status = 'retired';
    expect(resolveCatalogPiGatewayModelApi(catalog, 'moonshot/kimi-k3')).toBeNull();
  });

  it('requires an exact XD route even when a Registry canonical id matches the Gateway id', () => {
    const catalog = serverCatalog({
      gatewayModelId: 'different-gateway-id',
      routes: [{ providerId: 'provider-a', modelId: 'model' }],
      presets: [{ id: 'provider-a', protocol: 'anthropic-messages', modelId: 'model' }],
    });
    expect(resolveCatalogPiGatewayModelApi(catalog, 'canonical/model')).toBeUndefined();
  });
});

describe('Pi Gateway version-matched local supplement catalog', () => {
  it('returns the exact Kimi native API and complete tool replay compatibility', () => {
    expect(resolveBundledPiGatewayModelProfile('moonshotai/kimi-k3')).toMatchObject({
      api: 'openai-completions',
      compat: {
        maxTokensField: 'max_tokens',
        thinkingFormat: 'openai',
        requiresReasoningContentOnAssistantMessages: true,
        deferredToolsMode: 'kimi',
      },
      thinkingLevelMap: {
        low: 'low',
        high: 'high',
        max: 'max',
      },
    });
  });

  it.each([
    ['anthropic/claude-opus-5', 'anthropic-messages'],
    ['codex/gpt-5.5:auto', 'openai-responses'],
    ['google/gemini-3.6-flash', 'google-generative-ai'],
    ['deepseek/deepseek-v4-pro', 'openai-completions'],
    ['qwen/qwen3.8-flash', 'openai-completions'],
    ['z-ai/glm-5.3-flash', 'openai-completions'],
  ] as const)('resolves %s from the local Pi model table', (modelId, api) => {
    expect(resolveBundledPiGatewayModelProfile(modelId)).toMatchObject({ api });
  });

  it('can supplement every current Gateway identity when Cindy Server has no exact declaration', () => {
    const resolved = Object.entries(currentGatewayModelsByApi).flatMap(([api, modelIds]) =>
      modelIds.map((modelId) => ({
        modelId,
        expectedApi: api,
        actualApi: resolveBundledPiGatewayModelProfile(modelId)?.api,
      })),
    );
    expect(resolved).toHaveLength(46);
    expect(resolved.filter((entry) => entry.actualApi !== entry.expectedApi)).toEqual([]);
  });

  it('uses canonical provider identity and never borrows compat across providers', () => {
    expect(resolveBundledPiGatewayModelProfile('z-ai/glm-5.2')).toMatchObject({
      api: 'openai-completions',
      compat: { thinkingFormat: 'zai', zaiToolStream: true },
      thinkingLevelMap: { low: 'high', medium: 'high', high: 'high', max: 'max' },
    });
    expect(resolveBundledPiGatewayModelProfile('z-ai/glm-5.1')).toEqual({
      api: 'openai-completions',
    });
  });

  it('fails closed for identities absent from the local allowlist, including known bare aliases', () => {
    expect(resolveBundledPiGatewayModelProfile('vendor/future-model')).toBeUndefined();
    expect(resolveBundledPiGatewayModelProfile('unknown/gpt-5.4')).toBeUndefined();
    expect(resolveBundledPiGatewayModelProfile('unknown/grok-4.6')).toBeUndefined();
  });
});
