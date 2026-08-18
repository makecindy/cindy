/**
 * BYOM host 解析 —— 自定义 provider(pi runtime)→ pi 原生 provider spec + env。
 * 覆盖:wire protocol → pi api 映射、apiKey/none/oauth 三态、缺 key 跳过、env key 名。
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';

import { derivePiRuntimeFromClaudeRuntime } from '../../../shared/piRuntimeInitialization.js';

vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: () => true,
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => 'http://127.0.0.1:18765',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-native-provider-test',
  },
}));

import {
  buildXaiPiNativeProvider,
  buildPiNativeProvidersFromConfigs,
  buildPiSubscriptionNativeProviders,
  mergePiNativeProviderResults,
  parsePiListModels,
  PI_XAI_COMPAT_FORWARD_PORT,
  piNativeKeyEnvVar,
  piNativeModelId,
  readPiBundledModels,
  resolvePiBundledApiByModelId,
  resolvePiBundledModelById,
  type PiBundledModelInfo,
} from '../pi-host.js';

type Cfg = Parameters<typeof buildPiNativeProvidersFromConfigs>[0][number];

const piRuntime = (over: Partial<NonNullable<Cfg['runtimes']['pi']>> = {}) => ({
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  ...over,
});

const piBundledModel = (
  id: string,
  api: PiBundledModelInfo['api'],
  over: Partial<PiBundledModelInfo> = {},
): PiBundledModelInfo => ({
  id,
  api,
  name: id,
  reasoning: true,
  input: ['text'],
  contextWindow: 272_000,
  maxTokens: 128_000,
  ...over,
});

describe('buildPiNativeProvidersFromConfigs', () => {
  it('keeps a legacy custom xai endpoint separate from the official SuperGrok provider', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'xai',
          name: 'Private xAI-compatible endpoint',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://private-xai.example/v1',
              models: [{ id: 'private-grok', name: 'Private Grok' }],
            }),
          },
        },
      ],
      (providerId) => (providerId === 'xai' ? 'legacy-custom-key' : null),
    );
    expect(providers).toEqual([
      expect.objectContaining({
        id: 'custom:xai',
        baseUrl: 'https://private-xai.example/v1',
        models: [expect.objectContaining({ id: 'private-grok' })],
      }),
    ]);
    expect(Object.values(env)).toContain('legacy-custom-key');
  });

  it('reuses exact Pi official metadata and preserves unmatched configured models', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'deepseek-local',
          name: 'DeepSeek Local',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://api.deepseek.com',
              piCatalogProviderId: 'deepseek',
              models: [
                { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
                { id: 'models-url-only', name: 'Models URL Only', contextWindow: 64_000 },
              ],
            }),
          },
        },
      ],
      () => 'secret',
    );
    expect(providers[0]).toMatchObject({
      id: 'deepseek-local',
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
    });
    expect(providers[0]?.models[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      thinkingLevelMap: { low: null, high: 'high', max: 'max' },
    });
    expect(providers[0]?.models[1]).toEqual({
      id: 'models-url-only',
      name: 'Models URL Only',
      contextWindow: 64_000,
    });
  });

  it('does not apply official per-model routing after the user changes endpoint or protocol', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'deepseek-proxy',
          name: 'DeepSeek Proxy',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://proxy.example/anthropic',
              wireProtocol: 'anthropic-messages',
              piCatalogProviderId: 'deepseek',
              models: [{ id: 'deepseek-v4-pro', name: 'Proxy DeepSeek', contextWindow: 64_000 }],
            }),
          },
        },
      ],
      () => null,
    );
    expect(providers[0]).toMatchObject({
      baseUrl: 'https://proxy.example/anthropic',
      api: 'anthropic-messages',
      models: [{ id: 'deepseek-v4-pro', name: 'Proxy DeepSeek', contextWindow: 64_000 }],
    });
    expect(providers[0]?.models[0]).not.toHaveProperty('thinkingLevelMap');
  });

  it('preserves per-model headers from the official Pi catalog', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'kimi-coding-local',
          name: 'Kimi Coding Local',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://api.kimi.com/coding',
              wireProtocol: 'anthropic-messages',
              piCatalogProviderId: 'kimi-coding',
              models: [{ id: 'k3', name: 'Kimi K3' }],
            }),
          },
        },
      ],
      () => 'secret',
    );
    expect(providers[0]?.models[0]).toMatchObject({
      id: 'k3',
      headers: { 'User-Agent': 'KimiCLI/1.5' },
    });
  });

  it('preserves explicit overrides for an exact official model after the catalog marker is cleared', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'deepseek-customized',
          name: 'DeepSeek Customized',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://api.deepseek.com',
              wireProtocol: 'openai-chat',
              models: [
                {
                  id: 'deepseek-v4-flash',
                  name: 'My DeepSeek Flash',
                  contextWindow: 64_000,
                  supportsImageInput: true,
                  reasoning: true,
                  reasoningEfforts: ['low'],
                },
              ],
            }),
          },
        },
      ],
      () => 'secret',
    );
    expect(providers[0]?.models[0]).toEqual({
      id: 'deepseek-v4-flash',
      name: 'My DeepSeek Flash',
      contextWindow: 64_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
  });

  it('maps historical xAI namespaced ids to Pi official bare ids', () => {
    expect(piNativeModelId('xai', 'xai/grok-4.6')).toBe('grok-4.6');
    expect(piNativeModelId('xai', 'grok-4.6')).toBe('grok-4.6');
    expect(piNativeModelId('deepseek', 'xai/grok-4.6')).toBe('xai/grok-4.6');
  });

  it('builds Grok 4.6 from the Pi official xAI catalog without losing protocol metadata', async () => {
    const { providers, env } = await buildXaiPiNativeProvider('xai/grok-4.6');
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'xai',
      baseUrl: 'http://127.0.0.1:18765',
      api: 'anthropic-messages',
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      headers: {
        'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
        'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
        'x-cindy-pi-provider-id': 'xai',
      },
      modelIdAliases: { 'grok-4.6': 'xai/grok-4.6' },
    });
    expect(providers[0]?.models.find((model) => model.id === 'xai/grok-4.6')).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 500_000,
      maxTokens: 500_000,
      input: ['text', 'image'],
      reasoning: true,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    });
    expect(env).toEqual({
      CINDY_PI_XAI_PROXY_API_KEY: 'cindy-pi-provider-auth-placeholder',
    });
  });

  it('projects remote xAI through an exact SSH reverse-forward to the Desktop compat proxy', async () => {
    const { providers } = await buildXaiPiNativeProvider('grok-4.6', false, true);
    expect(providers[0]).toMatchObject({
      id: 'xai',
      baseUrl: `http://127.0.0.1:${PI_XAI_COMPAT_FORWARD_PORT}`,
      api: 'anthropic-messages',
      headers: {
        'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
        'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
        'x-cindy-pi-provider-id': 'xai',
      },
      hostProxyForward: {
        localUrl: 'http://127.0.0.1:18765',
        remotePort: PI_XAI_COMPAT_FORWARD_PORT,
      },
    });
  });

  it('adds a private conservative xAI descriptor only when resuming a historical namespaced id', async () => {
    await expect(buildXaiPiNativeProvider('xai/grok-retired')).rejects.toThrow(/does not contain/);
    const { providers } = await buildXaiPiNativeProvider('xai/grok-retired', true);
    expect(providers[0]?.models.find((model) => model.id === 'xai/grok-retired')).toEqual({
      id: 'xai/grok-retired',
      name: 'xai/grok-retired',
      api: 'anthropic-messages',
    });
    expect(providers[0]?.modelIdAliases?.['grok-retired']).toBe('xai/grok-retired');
  });

  it('reads exact provider/model IDs from PI list output', () => {
    const parsed = parsePiListModels(
      [
        'provider      model                context  max-out  thinking  images',
        'openai-codex  gpt-5.6-sol          272K     128K     yes       yes',
        'openai-codex  gpt-5.6-terra        272K     128K     yes       yes',
        '',
      ].join('\n'),
    );
    expect([...(parsed.get('openai-codex') ?? [])]).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  const bundledPiPath = path.join(process.cwd(), 'apps/pi-bin/darwin-arm64/pi');
  it('caches a null fallback when the PI probe temp directory cannot be created', async () => {
    const binaryPath = path.join(process.cwd(), 'pi-temp-dir-probe-failure');
    const mkdtempSpy = vi
      .spyOn(fsp, 'mkdtemp')
      .mockRejectedValueOnce(new Error('temporary directory unavailable'));

    try {
      await expect(readPiBundledModels(binaryPath)).resolves.toBeNull();
      await expect(readPiBundledModels(binaryPath)).resolves.toBeNull();
      expect(mkdtempSpy).toHaveBeenCalledTimes(1);
    } finally {
      mkdtempSpy.mockRestore();
    }
  });

  it.skipIf(
    process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(bundledPiPath),
  )('reads full APIs from the exact bundled PI binary without network access', async () => {
    const catalog = await readPiBundledModels(bundledPiPath);
    expect(catalog?.get('openai-codex')?.get('gpt-5.6-sol')?.api).toBe('openai-codex-responses');
    expect(catalog?.get('xai')?.get('grok-4.5')?.api).toBe('openai-responses');
    expect(catalog?.get('xai')?.get('grok-build-0.1')?.api).toBe('openai-completions');
    const anthropicModels = [...(catalog?.get('anthropic')?.values() ?? [])];
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every((model) => model.api === 'anthropic-messages')).toBe(true);
    expect(resolvePiBundledApiByModelId(catalog ?? undefined, 'glm-5.2')).toBe(
      'openai-completions',
    );
    expect(catalog?.get('zai')?.get('glm-5.2')).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    });
  });

  it('overlays host subscriptions onto PI native providers and keeps piApi sparse', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')!;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    anthropic.models.pi = [
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
        piApi: 'anthropic-messages',
      },
    ];
    openai.models.pi = [
      {
        id: 'chatgpt/gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 272_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        piApi: 'openai-responses',
      },
      {
        id: 'chatgpt/gpt-5.7',
        name: 'GPT-5.7',
        contextWindow: 272_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        piApi: 'openai-responses',
      },
    ];
    xai.models.pi = [
      {
        id: 'xai/grok-4.5',
        name: 'Grok 4.5',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
        piApi: 'openai-responses',
      },
      {
        id: 'xai/grok-4.20',
        name: 'Grok 4.20',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
        piApi: 'openai-responses',
      },
    ];

    const { providers, env } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        [
          'anthropic',
          new Map([['claude-opus-5', piBundledModel('claude-opus-5', 'anthropic-messages')]]),
        ],
        [
          'openai-codex',
          new Map([['gpt-5.6-sol', piBundledModel('gpt-5.6-sol', 'openai-codex-responses')]]),
        ],
        ['xai', new Map([['grok-4.5', piBundledModel('grok-4.5', 'openai-responses')]])],
      ]),
    );

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai-codex', 'xai']);
    expect(providers[0]).toMatchObject({
      sourceProviderId: 'anthropic',
      baseUrl: 'http://127.0.0.1:4567/',
      inheritModels: true,
      models: [{ id: 'claude-opus-5', wireId: 'claude-opus-5' }],
    });
    expect(providers[1]).toMatchObject({
      sourceProviderId: 'openai',
      baseUrl: 'http://127.0.0.1:4567/',
      inheritModels: true,
      models: [
        {
          id: 'chatgpt/gpt-5.6-sol',
          wireId: 'gpt-5.6-sol',
          api: 'openai-codex-responses',
        },
        {
          id: 'chatgpt/gpt-5.7',
          wireId: 'gpt-5.7',
          catalogAddition: true,
        },
      ],
    });
    expect(providers[1]?.models[0]?.catalogAddition).toBeUndefined();
    expect(providers[1]?.models[0]).toMatchObject({
      api: 'openai-codex-responses',
      contextWindow: 272_000,
    });
    expect(providers[2]).toMatchObject({
      sourceProviderId: 'xai',
      baseUrl: 'http://127.0.0.1:4567/v1',
      inheritModels: true,
      models: [
        { id: 'xai/grok-4.5', wireId: 'grok-4.5' },
        { id: 'xai/grok-4.20', wireId: 'grok-4.20', api: 'openai-responses' },
      ],
    });
    expect(providers[2]?.models[0]?.api).toBeUndefined();
    const proxyJwt = env[providers[1]!.apiKeyEnvVar!];
    expect(proxyJwt).toMatch(/^[^.]+\.[^.]+\.$/);
    expect(proxyJwt).not.toContain('Bearer');
    for (const provider of providers) {
      expect(provider.headers).toMatchObject({
        'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
        'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
        'x-cindy-pi-provider-id': provider.sourceProviderId,
      });
    }
  });

  it('publishes a distinct Pi 1M profile while inheriting the bundled ChatGPT adapter', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    openai.models.pi = [
      {
        id: 'chatgpt/gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        contextWindow: 272_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
      {
        id: 'chatgpt/gpt-5.6-sol[1m]',
        name: 'GPT-5.6-Sol (1M · 高消耗)',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
    ];
    const bundled = piBundledModel('gpt-5.6-sol', 'openai-codex-responses', {
      // readPiBundledModels probes with this deliberately unreachable endpoint.
      // It must never override the provider-level runtime compat proxy.
      baseUrl: 'http://127.0.0.1:1',
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 10,
          output: 45,
          cacheRead: 1,
          cacheWrite: 12.5,
        }],
      },
      compat: { supportsStrictTools: true },
    });

    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([['openai-codex', new Map([[bundled.id, bundled]])]]),
    ).providers.find((candidate) => candidate.id === 'openai-codex');

    expect(provider?.models).toEqual([
      expect.objectContaining({
        id: 'chatgpt/gpt-5.6-sol',
        wireId: 'gpt-5.6-sol',
        api: 'openai-codex-responses',
        contextWindow: 272_000,
        maxTokens: 128_000,
        compat: bundled.compat,
      }),
      expect.objectContaining({
        id: 'chatgpt/gpt-5.6-sol[1m]',
        wireId: 'gpt-5.6-sol[1m]',
        catalogAddition: true,
        name: 'GPT-5.6-Sol (1M · 高消耗)',
        contextWindow: 1_000_000,
        cost: bundled.cost,
        compat: bundled.compat,
      }),
    ]);
    expect(provider?.models[0]?.catalogAddition).toBeUndefined();
    expect(provider?.models[0]).not.toHaveProperty('baseUrl');
    expect(provider?.baseUrl).toBe('http://127.0.0.1:4567/');

    const withoutProbe = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
    ).providers.find((candidate) => candidate.id === 'openai-codex');
    expect(withoutProbe?.models[1]).toMatchObject({
      id: 'chatgpt/gpt-5.6-sol[1m]',
      wireId: 'gpt-5.6-sol[1m]',
      catalogAddition: true,
      contextWindow: 1_000_000,
    });
  });

  it('keeps a retired OpenAI profile private to its native subscription resume', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    openai.models.pi = openai.models.pi?.filter(
      (model) => model.id !== 'chatgpt/gpt-5.6-sol[1m]',
    );
    const bundled = piBundledModel('gpt-5.6-sol', 'openai-codex-responses', {
      contextWindow: 272_000,
      maxTokens: 128_000,
      compat: { supportsStrictTools: true },
    });

    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([['openai-codex', new Map([[bundled.id, bundled]])]]),
      undefined,
      {
        id: 'chatgpt/gpt-5.6-sol[1m]',
        displayName: 'GPT-5.6-Sol (1M · Higher usage)',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
    ).providers.find((candidate) => candidate.id === 'openai-codex');

    expect(provider?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'chatgpt/gpt-5.6-sol[1m]',
        wireId: 'gpt-5.6-sol[1m]',
        catalogAddition: true,
        contextWindow: 1_000_000,
        compat: bundled.compat,
      }),
    ]));
    expect(openai.models.pi?.some((model) => model.id.endsWith('[1m]'))).toBe(false);
  });

  it('publishes SuperGrok catalog models missing from this PI binary as catalog additions', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = catalog.providers.find((provider) => provider.id === 'xai');
    expect(xai?.models.pi?.some((model) => model.id === 'grok-4.6')).toBe(true);
    expect(xai?.models.pi?.find((model) => model.id === 'grok-4.6')?.piApi).toBeUndefined();

    const { providers } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        ['xai', new Map([['grok-4.5', piBundledModel('grok-4.5', 'openai-completions')]])],
      ]),
      new Map([['xai', new Set(['grok-4.5'])]]),
    );

    const xaiProvider = providers.find((provider) => provider.id === 'xai');
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.6')).toMatchObject({
      id: 'grok-4.6',
      wireId: 'grok-4.6',
      catalogAddition: true,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.6')?.api).toBeUndefined();
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.5')?.catalogAddition).toBeUndefined();
  });

  it('does not mark SuperGrok models as catalog additions when the PI probe is unavailable', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    expect(catalog.providers.find((provider) => provider.id === 'xai')?.models.pi?.find((model) => model.id === 'grok-4.6')?.piApi).toBeUndefined();

    const { providers } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
    );

    const xaiProvider = providers.find((provider) => provider.id === 'xai');
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.6')?.catalogAddition).toBeUndefined();
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.5')?.catalogAddition).toBeUndefined();
  });

  it('does not mark SuperGrok models as catalog additions when the probe has no xAI baseline', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;

    const { providers } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        ['anthropic', new Map([['claude-opus-5', piBundledModel('claude-opus-5', 'anthropic-messages')]])],
      ]),
    );

    const xaiProvider = providers.find((provider) => provider.id === 'xai');
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.6')?.catalogAddition).toBeUndefined();
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.5')?.catalogAddition).toBeUndefined();
  });

  it('does not mark SuperGrok models as catalog additions when list-models still has the id', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;

    const { providers } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        ['xai', new Map([['grok-4.5', piBundledModel('grok-4.5', 'openai-completions')]])],
      ]),
      new Map([['xai', new Set(['grok-4.5', 'grok-4.6'])]]),
    );

    const xaiProvider = providers.find((provider) => provider.id === 'xai');
    expect(xaiProvider?.models.find((model) => model.id === 'grok-4.6')?.catalogAddition).toBeUndefined();
  });

  it('namespaces only colliding BYOM runtime ids and preserves their persisted source ids', () => {
    const collisions: Array<[string, string]> = [];
    const merged = mergePiNativeProviderResults(
      {
        providers: [
          {
            id: 'openai-codex',
            sourceProviderId: 'openai',
            name: 'OpenAI (ChatGPT)',
            baseUrl: 'http://127.0.0.1:4567',
            inheritModels: true,
            models: [{ id: 'chatgpt/gpt-5.6-sol', wireId: 'gpt-5.6-sol' }],
          },
        ],
        env: { CINDY_PI_OPENAI_PROXY_KEY: 'subscription-key' },
      },
      {
        providers: [
          {
            id: 'openai-codex',
            name: 'User OpenAI-compatible endpoint',
            baseUrl: 'https://user.example/v1',
            api: 'openai-completions',
            models: [{ id: 'local-model' }],
          },
          {
            id: 'cindy-byom-openai-codex',
            name: 'Existing custom provider',
            baseUrl: 'https://other.example/v1',
            api: 'openai-completions',
            models: [{ id: 'other-model' }],
          },
        ],
        env: { CINDY_PI_KEY_OPENAI_CODEX: 'custom-key' },
      },
      (sourceProviderId, runtimeProviderId) =>
        collisions.push([sourceProviderId, runtimeProviderId]),
    );

    expect(merged.providers.map((provider) => provider.id)).toEqual([
      'openai-codex',
      'cindy-byom-openai-codex-2',
      'cindy-byom-openai-codex',
    ]);
    expect(merged.providers[1]).toMatchObject({
      id: 'cindy-byom-openai-codex-2',
      sourceProviderId: 'openai-codex',
      baseUrl: 'https://user.example/v1',
      models: [{ id: 'local-model' }],
    });
    expect(merged.providers[2]?.sourceProviderId).toBeUndefined();
    expect(merged.env).toEqual({
      CINDY_PI_OPENAI_PROXY_KEY: 'subscription-key',
      CINDY_PI_KEY_OPENAI_CODEX: 'custom-key',
    });
    expect(collisions).toEqual([['openai-codex', 'cindy-byom-openai-codex-2']]);
  });

  it('namespaces bundled PI provider ids without active subscriptions and preserves BYOM routing', () => {
    const collisions: Array<[string, string]> = [];
    const customProviders = [
      {
        id: 'openai-codex',
        name: 'User OpenAI endpoint',
        baseUrl: 'https://openai-user.example/v1',
        api: 'openai-completions' as const,
        apiKeyEnvVar: 'CINDY_PI_KEY_OPENAI_CODEX',
        models: [{ id: 'openai-local' }],
      },
      {
        id: 'anthropic',
        name: 'User Anthropic endpoint',
        baseUrl: 'https://anthropic-user.example/v1',
        api: 'anthropic-messages' as const,
        apiKeyEnvVar: 'CINDY_PI_KEY_ANTHROPIC',
        models: [{ id: 'anthropic-local' }],
      },
      {
        id: 'xai',
        name: 'User xAI endpoint',
        baseUrl: 'https://xai-user.example/v1',
        api: 'openai-responses' as const,
        apiKeyEnvVar: 'CINDY_PI_KEY_XAI',
        models: [{ id: 'xai-local' }],
      },
      {
        id: 'cindy-byom-openai-codex',
        name: 'Existing custom provider',
        baseUrl: 'https://existing.example/v1',
        api: 'openai-completions' as const,
        models: [{ id: 'existing-local' }],
      },
      {
        id: 'safe-custom',
        name: 'Non-colliding provider',
        baseUrl: 'https://safe.example/v1',
        api: 'openai-completions' as const,
        models: [{ id: 'safe-local' }],
      },
    ];
    const env = {
      CINDY_PI_KEY_OPENAI_CODEX: 'openai-key',
      CINDY_PI_KEY_ANTHROPIC: 'anthropic-key',
      CINDY_PI_KEY_XAI: 'xai-key',
    };

    const merged = mergePiNativeProviderResults(
      { providers: [], env: {} },
      { providers: customProviders, env },
      (sourceProviderId, runtimeProviderId) =>
        collisions.push([sourceProviderId, runtimeProviderId]),
    );

    expect(merged.providers.map((provider) => provider.id)).toEqual([
      'cindy-byom-openai-codex-2',
      'cindy-byom-anthropic',
      'cindy-byom-xai',
      'cindy-byom-openai-codex',
      'safe-custom',
    ]);
    expect(merged.providers.slice(0, 3)).toMatchObject([
      {
        sourceProviderId: 'openai-codex',
        baseUrl: 'https://openai-user.example/v1',
        api: 'openai-completions',
        apiKeyEnvVar: 'CINDY_PI_KEY_OPENAI_CODEX',
        models: [{ id: 'openai-local' }],
      },
      {
        sourceProviderId: 'anthropic',
        baseUrl: 'https://anthropic-user.example/v1',
        api: 'anthropic-messages',
        apiKeyEnvVar: 'CINDY_PI_KEY_ANTHROPIC',
        models: [{ id: 'anthropic-local' }],
      },
      {
        sourceProviderId: 'xai',
        baseUrl: 'https://xai-user.example/v1',
        api: 'openai-responses',
        apiKeyEnvVar: 'CINDY_PI_KEY_XAI',
        models: [{ id: 'xai-local' }],
      },
    ]);
    expect(merged.providers[3]?.sourceProviderId).toBeUndefined();
    expect(merged.providers[4]?.sourceProviderId).toBeUndefined();
    expect(merged.env).toEqual(env);
    expect(collisions).toEqual([
      ['openai-codex', 'cindy-byom-openai-codex-2'],
      ['anthropic', 'cindy-byom-anthropic'],
      ['xai', 'cindy-byom-xai'],
    ]);
  });

  it('preserves daily additions and protocol annotations when PI probing fails or is empty', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')!;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    anthropic.models.pi = [
      {
        id: 'claude-daily',
        name: 'Claude Daily',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        piApi: 'anthropic-messages',
      },
    ];
    openai.models.pi = [
      {
        id: 'chatgpt/gpt-daily',
        name: 'GPT Daily',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        piApi: 'openai-responses',
      },
    ];
    xai.models.pi = [
      {
        id: 'xai/grok-daily',
        name: 'Grok Daily',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        piApi: 'openai-responses',
      },
    ];

    for (const bundled of [undefined, new Map()] as const) {
      const providers = buildPiSubscriptionNativeProviders(
        catalog,
        'http://127.0.0.1:4567/',
        bundled,
      ).providers;
      expect(providers.find((provider) => provider.id === 'anthropic')?.models[0]).toMatchObject({
        wireId: 'claude-daily',
        api: 'anthropic-messages',
      });
      expect(providers.find((provider) => provider.id === 'openai-codex')?.models[0]).toMatchObject(
        { wireId: 'gpt-daily', catalogAddition: true },
      );
      expect(providers.find((provider) => provider.id === 'xai')?.models[0]).toMatchObject({
        wireId: 'grok-daily',
        api: 'openai-responses',
      });
    }
  });

  it('keeps missing daily rows while respecting models returned by a partial PI probe', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    xai.models.pi = [
      {
        id: 'xai/grok-known',
        name: 'Grok Known',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        piApi: 'openai-responses',
      },
      {
        id: 'xai/grok-added',
        name: 'Grok Added',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        piApi: 'openai-responses',
      },
    ];
    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        ['xai', new Map([['grok-known', piBundledModel('grok-known', 'openai-responses')]])],
      ]),
    ).providers.find((candidate) => candidate.id === 'xai');

    expect(provider?.models).toEqual([
      expect.objectContaining({ wireId: 'grok-known' }),
      expect.objectContaining({ wireId: 'grok-added', api: 'openai-responses' }),
    ]);
    expect(provider?.models[0]?.api).toBeUndefined();
  });

  it('preserves PI bundled metadata when a daily annotation corrects an existing protocol', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    xai.models.pi = [
      {
        id: 'xai/grok-corrected',
        name: 'Daily Name',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
        piApi: 'openai-responses',
      },
    ];
    const bundled = piBundledModel('grok-corrected', 'openai-completions', {
      name: 'PI Bundled Name',
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
      compat: { supportsStrictTools: true },
    });

    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([['xai', new Map([[bundled.id, bundled]])]]),
    ).providers.find((candidate) => candidate.id === 'xai');

    expect(provider?.models[0]).toMatchObject({
      wireId: 'grok-corrected',
      api: 'openai-responses',
      name: 'PI Bundled Name',
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: bundled.cost,
      compat: bundled.compat,
    });
  });

  it('turns a Claude-derived wizard runtime and copied Pi key into a callable native provider', () => {
    const derived = derivePiRuntimeFromClaudeRuntime({
      baseUrl: 'https://api.example/anthropic',
      headers: { 'x-tenant': 'acme' },
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 100_000 }],
    });
    expect(derived).not.toBeNull();

    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'wizard-provider',
          name: 'Wizard Provider',
          auth: { method: 'apiKey' },
          runtimes: { pi: derived! },
        },
      ],
      (providerId, agent) =>
        providerId === 'wizard-provider' && agent === 'pi' ? 'wizard-secret' : null,
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'wizard-provider',
      name: 'Wizard Provider',
      baseUrl: 'https://api.example/anthropic',
      api: 'anthropic-messages',
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 100_000 }],
    });
    expect(env[providers[0].apiKeyEnvVar!]).toBe('wizard-secret');
    expect(providers[0].headers?.['x-tenant']).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(env)).toContain('acme');
  });

  it('maps wire protocols to pi api forms (openai-chat→openai-completions, undefined→openai-completions)', () => {
    const cases: Array<[string | undefined, string]> = [
      ['anthropic-messages', 'anthropic-messages'],
      ['openai-responses', 'openai-responses'],
      ['openai-chat', 'openai-completions'],
      [undefined, 'openai-completions'],
    ];
    for (const [wp, api] of cases) {
      const { providers } = buildPiNativeProvidersFromConfigs(
        [
          {
            id: 'p',
            name: 'P',
            auth: { method: 'none' },
            runtimes: { pi: piRuntime({ wireProtocol: wp as never }) },
          },
        ],
        () => null,
      );
      expect(providers[0]?.api).toBe(api);
    }
  });

  it('fails closed for an unknown custom-provider wire protocol', () => {
    expect(() =>
      buildPiNativeProvidersFromConfigs(
        [
          {
            id: 'future',
            name: 'Future',
            auth: { method: 'none' },
            runtimes: { pi: piRuntime({ wireProtocol: 'future-protocol' as never }) },
          },
        ],
        () => null,
      ),
    ).toThrow('Unsupported PI wire protocol: future-protocol');
  });

  it('uses PI bundled protocol knowledge before the legacy unknown-BYOM default', () => {
    const bundled = new Map([
      [
        'zai',
        new Map([
          [
            'glm-5.2',
            piBundledModel('glm-5.2', 'openai-completions', {
              baseUrl: 'https://api.z.ai/api/coding/paas/v4',
            }),
          ],
        ]),
      ],
      [
        'zai-coding-cn',
        new Map([
          [
            'glm-5.2',
            piBundledModel('glm-5.2', 'openai-completions', {
              baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            }),
          ],
        ]),
      ],
    ]);
    expect(resolvePiBundledApiByModelId(bundled, 'glm-5.2')).toBe('openai-completions');
    expect(
      resolvePiBundledModelById(bundled, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic')
        ?.baseUrl,
    ).toBe('https://open.bigmodel.cn/api/coding/paas/v4');

    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'zhipu-glm-cn',
          name: 'Zhipu GLM',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://open.bigmodel.cn/api/anthropic',
              models: [
                { id: 'glm-5.2', name: 'GLM-5.2' },
                { id: 'glm-5.3', name: 'GLM-5.3', piApi: 'anthropic-messages' },
              ],
            }),
          },
        },
      ],
      () => null,
      undefined,
      bundled,
    );

    expect(providers[0]).toMatchObject({
      api: 'openai-completions',
      models: [
        {
          id: 'glm-5.2',
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        },
        { id: 'glm-5.3', api: 'anthropic-messages' },
      ],
    });
    expect(providers[0]?.models[0]?.api).toBeUndefined();
  });

  it('does not infer ambiguous duplicate model ids from PI bundled providers', () => {
    const bundled = new Map([
      ['provider-a', new Map([['same-id', piBundledModel('same-id', 'anthropic-messages')]])],
      ['provider-b', new Map([['same-id', piBundledModel('same-id', 'openai-responses')]])],
    ]);
    expect(resolvePiBundledApiByModelId(bundled, 'same-id')).toBeUndefined();
  });

  it('does not copy a unique same-named PI model across BYOM origins', () => {
    const bundledModel = piBundledModel('shared-model', 'anthropic-messages', {
      baseUrl: 'https://official.example/v1/messages',
      name: 'Official Name',
      compat: { supportsStrictTools: true },
    });
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'local-provider',
          name: 'Local Provider',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'http://127.0.0.1:9000/v1',
              models: [{ id: 'shared-model', name: 'Local Name' }],
            }),
          },
        },
      ],
      () => null,
      undefined,
      new Map([['official-provider', new Map([['shared-model', bundledModel]])]]),
    );

    expect(providers[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:9000/v1',
      api: 'openai-completions',
      models: [{ id: 'shared-model', name: 'Local Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
    expect(providers[0]?.models[0]?.compat).toBeUndefined();
  });

  it('uses matched bundled reasoning true/false and falls back only when metadata is absent', () => {
    const baseUrl = 'https://same-origin.example/v1';
    const bundled = new Map([
      [
        'same-origin',
        new Map([
          [
            'bundled-reasoning-on',
            piBundledModel('bundled-reasoning-on', 'openai-completions', {
              baseUrl,
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: null },
            }),
          ],
          [
            'bundled-reasoning-off',
            piBundledModel('bundled-reasoning-off', 'openai-completions', {
              baseUrl,
              reasoning: false,
              // A stale/defensive map must not survive an authoritative false.
              thinkingLevelMap: { high: 'high' },
            }),
          ],
        ]),
      ],
    ]);
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'same-origin-provider',
          name: 'Same Origin Provider',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl,
              models: [
                { id: 'bundled-reasoning-on', reasoning: false },
                {
                  id: 'bundled-reasoning-off',
                  reasoning: true,
                  reasoningEfforts: ['high'],
                },
                {
                  id: 'configured-only',
                  reasoning: true,
                  reasoningEfforts: ['high'],
                },
              ],
            }),
          },
        },
      ],
      () => null,
      undefined,
      bundled,
    );

    expect(providers[0]?.models[0]).toMatchObject({
      id: 'bundled-reasoning-on',
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: null },
    });
    expect(providers[0]?.models[1]).toMatchObject({
      id: 'bundled-reasoning-off',
      reasoning: false,
    });
    expect(providers[0]?.models[1]).not.toHaveProperty('thinkingLevelMap');
    expect(providers[0]?.models[2]).toMatchObject({
      id: 'configured-only',
      reasoning: true,
      thinkingLevelMap: { high: 'high' },
    });
  });

  it('keeps an explicit BYOM protocol and endpoint isolated from bundled model metadata', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'explicit-provider',
          name: 'Explicit Provider',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://custom.example/v1',
              wireProtocol: 'openai-responses',
              models: [{ id: 'same-id', name: 'Custom Name' }],
            }),
          },
        },
      ],
      () => null,
      undefined,
      new Map([
        [
          'bundled',
          new Map([
            [
              'same-id',
              piBundledModel('same-id', 'anthropic-messages', {
                baseUrl: 'https://other.example/v1',
                name: 'Bundled Name',
              }),
            ],
          ]),
        ],
      ]),
    );

    expect(providers[0]).toMatchObject({
      baseUrl: 'https://custom.example/v1',
      api: 'openai-responses',
      models: [{ id: 'same-id', name: 'Custom Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
  });

  it('falls back to completions when no unique same-origin PI candidate exists', () => {
    const bundled = new Map([
      [
        'provider-a',
        new Map([
          [
            'same-id',
            piBundledModel('same-id', 'anthropic-messages', {
              baseUrl: 'https://same.example/anthropic',
            }),
          ],
        ]),
      ],
      [
        'provider-b',
        new Map([
          [
            'same-id',
            piBundledModel('same-id', 'openai-responses', {
              baseUrl: 'https://same.example/openai',
            }),
          ],
        ]),
      ],
    ]);
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'ambiguous-provider',
          name: 'Ambiguous Provider',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              baseUrl: 'https://same.example/proxy',
              models: [{ id: 'same-id', name: 'Configured Name' }],
            }),
          },
        },
      ],
      () => null,
      undefined,
      bundled,
    );

    expect(
      resolvePiBundledModelById(bundled, 'same-id', 'https://same.example/proxy'),
    ).toBeUndefined();
    expect(providers[0]).toMatchObject({
      api: 'openai-completions',
      models: [{ id: 'same-id', name: 'Configured Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
  });

  it('keyless (none) → no env, no apiKeyEnvVar (models.json writes dummy)', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{ id: 'ollama', name: 'Ollama', auth: { method: 'none' }, runtimes: { pi: piRuntime() } }],
      () => null,
    );
    expect(providers).toHaveLength(1);
    expect(providers[0].apiKeyEnvVar).toBeUndefined();
    expect(env).toEqual({});
  });

  it('apiKey → env injected under CINDY_PI_KEY_<ID>, referenced by apiKeyEnvVar', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{ id: 'my-vllm', name: 'vLLM', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } }],
      (id, agent) => (id === 'my-vllm' && agent === 'pi' ? 'secret-123' : null),
    );
    const envVar = piNativeKeyEnvVar('my-vllm');
    expect(envVar).toBe('CINDY_PI_KEY_MY_VLLM');
    expect(providers[0].apiKeyEnvVar).toBe(envVar);
    expect(env[envVar]).toBe('secret-123');
  });

  it('disambiguates env var names when ids collapse to the same key (no cross-provider key leak)', () => {
    // `my-vllm` 与 `my_vllm` 都归一成 CINDY_PI_KEY_MY_VLLM;必须各拿独立 env 名,否则后写覆盖 → 串号。
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        { id: 'my-vllm', name: 'A', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } },
        { id: 'my_vllm', name: 'B', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } },
      ],
      (id) => (id === 'my-vllm' ? 'KEY-A' : id === 'my_vllm' ? 'KEY-B' : null),
    );
    expect(providers).toHaveLength(2);
    const [a, b] = providers;
    // 两个 provider 的 env 名互不相同
    expect(a.apiKeyEnvVar).not.toBe(b.apiKeyEnvVar);
    // 各自 env 变量存的是各自的 key,没有互相覆盖
    expect(env[a.apiKeyEnvVar!]).toBe('KEY-A');
    expect(env[b.apiKeyEnvVar!]).toBe('KEY-B');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('apiKey provider with no stored key is skipped (avoid half-usable)', () => {
    const skips: string[] = [];
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{ id: 'nokey', name: 'NoKey', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } }],
      () => null,
      (id) => skips.push(id),
    );
    expect(providers).toHaveLength(0);
    expect(skips).toContain('nokey');
  });

  it('allows apiKey providers authenticated entirely by custom headers', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'header-only',
          name: 'Header Only',
          auth: { method: 'apiKey' },
          runtimes: {
            pi: piRuntime({ headers: { Authorization: 'Bearer header-secret' } }),
          },
        },
      ],
      () => null,
    );

    expect(providers).toHaveLength(1);
    expect(providers[0].apiKeyEnvVar).toBeUndefined();
    expect(providers[0].headers?.Authorization).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(env)).toContain('Bearer header-secret');
  });

  it('oauth custom provider is skipped for pi native', () => {
    const skips: string[] = [];
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{ id: 'oauthp', name: 'OAuthP', auth: { method: 'oauth' }, runtimes: { pi: piRuntime() } }],
      () => 'k',
      (id) => skips.push(id),
    );
    expect(providers).toHaveLength(0);
    expect(skips).toContain('oauthp');
  });

  it('ignores configs without a pi runtime; keeps custom header values out of models.json specs', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        { id: 'codexonly', name: 'C', runtimes: {} },
        {
          id: 'withhdr',
          name: 'H',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              headers: { 'x-org': 'acme', authorization: 'Bearer header-secret' },
              models: [{ id: 'm1', name: 'M1', contextWindow: 8000 }],
            }),
          },
        },
      ],
      () => null,
    );
    expect(providers.map((p) => p.id)).toEqual(['withhdr']);
    expect(providers[0].headers?.['x-org']).toMatch(/^\$CINDY_PI_KEY_/);
    expect(providers[0].headers?.authorization).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(providers[0].headers ?? {})).not.toContain('Bearer header-secret');
    expect(Object.values(env)).toEqual(expect.arrayContaining(['acme', 'Bearer header-secret']));
    expect(providers[0].models[0]).toMatchObject({ id: 'm1', name: 'M1', contextWindow: 8000 });
  });

  it('maps an explicit custom-model image capability into the Pi native model spec', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'visual',
          name: 'Visual',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              models: [
                { id: 'vision', name: 'Vision', supportsImageInput: true },
                { id: 'legacy', name: 'Legacy' },
              ],
            }),
          },
        },
      ],
      () => null,
    );
    expect(providers[0].models).toEqual([
      { id: 'vision', name: 'Vision', contextWindow: undefined, input: ['text', 'image'] },
      { id: 'legacy', name: 'Legacy', contextWindow: undefined },
    ]);
  });

  it('keeps an unedited preset per-model piApi correction in the native model spec', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              wireProtocol: 'openai-responses',
              models: [
                {
                  id: 'deepseek-v4-pro',
                  name: 'DeepSeek V4 Pro',
                  piApi: 'openai-responses',
                },
              ],
            }),
          },
        },
      ],
      () => null,
    );

    expect(providers[0]?.models[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      api: 'openai-responses',
    });
  });

  it.each([
    ['openai-chat', 'openai-completions'],
    ['anthropic-messages', 'anthropic-messages'],
  ] as const)(
    'uses a saved explicit %s PI protocol after the dialog clears preset piApi',
    (wireProtocol, expectedApi) => {
      const { providers } = buildPiNativeProvidersFromConfigs(
        [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            auth: { method: 'none' },
            runtimes: {
              pi: piRuntime({
                wireProtocol,
                models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
              }),
            },
          },
        ],
        () => null,
      );

      expect(providers[0]?.api).toBe(expectedApi);
      expect(providers[0]?.models[0]?.api).toBeUndefined();
    },
  );

  it('maps an explicit Responses reasoning capability and supported efforts into Pi', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'reasoning',
          name: 'Reasoning',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              wireProtocol: 'openai-responses',
              models: [
                {
                  id: 'reasoner',
                  name: 'Reasoner',
                  reasoning: true,
                  reasoningEfforts: ['low', 'high', 'xhigh'],
                },
                { id: 'legacy', name: 'Legacy' },
              ],
            }),
          },
        },
      ],
      () => null,
    );

    expect(providers[0].models).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        contextWindow: undefined,
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: 'xhigh',
          max: null,
        },
      },
      { id: 'legacy', name: 'Legacy', contextWindow: undefined },
    ]);
  });

  it.each([
    ['deepseek-v4-pro', 'DeepSeek V4 Pro', false],
    ['kimi-k3', 'Kimi K3', true],
  ] as const)('maps %s exact reasoning levels and image capability into Pi', (id, name, visual) => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'cn-provider',
          name: 'CN Provider',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              models: [
                {
                  id,
                  name,
                  ...(visual ? { supportsImageInput: true } : {}),
                  reasoning: true,
                  reasoningEfforts: ['low', 'high', 'max'],
                },
              ],
            }),
          },
        },
      ],
      () => null,
    );
    expect(providers[0].models[0]).toEqual({
      id,
      name,
      contextWindow: undefined,
      ...(visual ? { input: ['text', 'image'] } : {}),
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    });
  });
});
