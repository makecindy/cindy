import { describe, expect, it, vi } from 'vitest';

import type { Catalog } from '@cindy/model-providers';

vi.mock('electron', () => ({ app: { getPath: () => 'C:/test-user-data' } }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => null }),
  readCustomProviderKey: vi.fn(),
}));
vi.mock('../auth-adapters.js', () => ({ desktopClaudeAuthAdapter: {} }));
vi.mock('../active-catalog.js', () => ({ getActiveCatalog: vi.fn() }));
vi.mock('../runtime-configs.js', () => ({ buildDesktopClaudeRuntimeConfig: vi.fn() }));
vi.mock('../dsh-remote-transport.js', () => ({ createSshDshTransport: vi.fn() }));

import { resolveDshVendorOptions } from '../dsh-host.js';

const catalog: Catalog = {
  version: 'dsh-host-test',
  providers: [
    {
      id: 'dsh-gateway',
      name: 'DSH Gateway',
      source: 'user',
      agents: ['dsh'],
      auth: { method: 'apiKey' },
      routing: {
        dsh: {
          upstream: 'https://gateway.example.test/deepseek',
          authStrategy: 'api-key-header',
        },
      },
      models: {
        dsh: [
          {
            id: 'gateway-pro',
            name: 'Gateway Pro',
            contextWindow: 640_000,
            efforts: [],
            defaultEffort: null,
            dshReasoningEffort: 'low',
          },
        ],
      },
    },
  ],
};

const legacySessionCatalog: Catalog = {
  version: 'dsh-host-collision-test',
  providers: [
    {
      id: 'deepseek-2',
      name: 'DeepSeek',
      source: 'user',
      agents: ['codex', 'dsh'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          upstream: 'https://api.deepseek.com',
          authStrategy: 'api-key-header',
        },
        dsh: {
          upstream: 'https://api.deepseek.com',
          authStrategy: 'api-key-header',
        },
      },
      models: {
        codex: [],
        dsh: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            contextWindow: 1_048_576,
            efforts: [],
            defaultEffort: null,
            dshReasoningEffort: 'high',
          },
        ],
      },
    },
  ],
};

describe('resolveDshVendorOptions', () => {
  it('uses the selected custom DSH endpoint, key, context model list, and reasoning default', () => {
    const readCustomKey = vi.fn(() => 'custom-dsh-key');

    expect(
      resolveDshVendorOptions({
        catalog,
        providerId: 'dsh-gateway',
        modelId: 'gateway-pro',
        readCustomKey,
      }),
    ).toEqual({
      dshApiKey: 'custom-dsh-key',
      dshBaseUrl: 'https://gateway.example.test/deepseek',
      dshModels: [
        {
          id: 'gateway-pro',
          name: 'Gateway Pro',
          contextWindow: 640_000,
          maxTokens: 32_768,
        },
      ],
      dshReasoningEffort: 'low',
    });
    expect(readCustomKey).toHaveBeenCalledWith('dsh-gateway', 'dsh');
  });

  it('normalizes the session Base URL and clamps an explicit output cap to context', () => {
    const provider = catalog.providers[0]!;
    const model = provider.models.dsh![0]!;
    const modified: Catalog = {
      ...catalog,
      providers: [{
        ...provider,
        routing: {
          dsh: {
            ...provider.routing.dsh!,
            upstream: 'https://gateway.example.test/deepseek///',
          },
        },
        models: {
          dsh: [{ ...model, maxOutput: 999_999 }],
        },
      }],
    };

    expect(resolveDshVendorOptions({
      catalog: modified,
      providerId: 'dsh-gateway',
      modelId: 'gateway-pro',
      readCustomKey: () => 'key',
    })).toMatchObject({
      dshBaseUrl: 'https://gateway.example.test/deepseek',
      dshModels: [expect.objectContaining({ maxTokens: 640_000 })],
    });
  });

  it('keeps fixed thinking policies separate from unsupported effort tiers', () => {
    const provider = catalog.providers[0]!;
    const model = provider.models.dsh![0]!;
    const withPolicy = (
      dshThinkingPolicy: 'always-on' | 'always-off',
      dshReasoningEffort: 'off' | 'high',
    ): Catalog => ({
      ...catalog,
      providers: [{
        ...provider,
        models: {
          dsh: [{ ...model, dshThinkingPolicy, dshReasoningEffort }],
        },
      }],
    });

    const alwaysOn = resolveDshVendorOptions({
      catalog: withPolicy('always-on', 'off'),
      providerId: 'dsh-gateway',
      modelId: 'gateway-pro',
      readCustomKey: () => 'key',
    });
    expect(alwaysOn.dshThinkingPolicy).toBe('always-on');
    expect(alwaysOn.dshReasoningEffort).toBeUndefined();

    const alwaysOff = resolveDshVendorOptions({
      catalog: withPolicy('always-off', 'high'),
      providerId: 'dsh-gateway',
      modelId: 'gateway-pro',
      readCustomKey: () => 'key',
    });
    expect(alwaysOff.dshThinkingPolicy).toBe('always-off');
    expect(alwaysOff.dshReasoningEffort).toBeUndefined();
  });

  it('does not fall back to another provider key when the selected DSH key is missing', () => {
    expect(() =>
      resolveDshVendorOptions({
        catalog,
        providerId: 'dsh-gateway',
        modelId: 'gateway-pro',
        readCustomKey: () => null,
      }),
    ).toThrow('DSH API key is not configured for the selected provider');
  });

  it('recovers a session written with the removed parallel deepseek id', () => {
    const readCustomKey = vi.fn((providerId: string, agent: string) =>
      providerId === 'deepseek-2' && agent === 'codex' ? 'existing-deepseek-key' : null,
    );

    expect(
      resolveDshVendorOptions({
        catalog: legacySessionCatalog,
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        readCustomKey,
      }),
    ).toMatchObject({
      dshApiKey: 'existing-deepseek-key',
      dshBaseUrl: 'https://api.deepseek.com',
      dshReasoningEffort: 'high',
    });
    expect(readCustomKey).toHaveBeenCalledWith('deepseek-2', 'codex');
  });

  it('fails closed when a legacy id could refer to multiple configured providers', () => {
    const second = {
      ...legacySessionCatalog.providers[0],
      id: 'deepseek-backup',
      name: 'DeepSeek Backup',
    };
    expect(() =>
      resolveDshVendorOptions({
        catalog: { ...legacySessionCatalog, providers: [...legacySessionCatalog.providers, second] },
        providerId: 'custom:deepseek',
        modelId: 'deepseek-v4-flash',
        readCustomKey: () => 'key',
      }),
    ).toThrow('DSH provider selection is ambiguous');
  });
});
