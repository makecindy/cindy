/**
 * BYOM host 解析 —— 自定义 provider(pi runtime)→ pi 原生 provider spec + env。
 * 覆盖:wire protocol → pi api 映射、apiKey/none/oauth 三态、缺 key 跳过、env key 名。
 */
import { describe, expect, it, vi } from 'vitest';

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
  PI_XAI_COMPAT_FORWARD_PORT,
  piNativeKeyEnvVar,
  piNativeModelId,
} from '../pi-host.js';

type Cfg = Parameters<typeof buildPiNativeProvidersFromConfigs>[0][number];

const piRuntime = (over: Partial<NonNullable<Cfg['runtimes']['pi']>> = {}) => ({
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  ...over,
});

describe('buildPiNativeProvidersFromConfigs', () => {
  it('keeps a legacy custom xai endpoint separate from the official SuperGrok provider', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'xai',
        name: 'Private xAI-compatible endpoint',
        auth: { method: 'apiKey' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'https://private-xai.example/v1',
            models: [{ id: 'private-grok', name: 'Private Grok' }],
          }),
        },
      }],
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
      [{
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
      }],
      () => 'secret',
    );
    expect(providers[0]).toMatchObject({ id: 'deepseek-local', baseUrl: 'https://api.deepseek.com' });
    expect(providers[0]?.models[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      api: 'openai-completions',
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
      [{
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
      }],
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
      [{
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
      }],
      () => 'secret',
    );
    expect(providers[0]?.models[0]).toMatchObject({
      id: 'k3',
      headers: { 'User-Agent': 'KimiCLI/1.5' },
    });
  });

  it('preserves explicit overrides for an exact official model after the catalog marker is cleared', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'deepseek-customized',
        name: 'DeepSeek Customized',
        auth: { method: 'apiKey' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'https://api.deepseek.com',
            wireProtocol: 'openai-chat',
            models: [{
              id: 'deepseek-v4-flash',
              name: 'My DeepSeek Flash',
              contextWindow: 64_000,
              supportsImageInput: true,
              reasoning: true,
              reasoningEfforts: ['low'],
            }],
          }),
        },
      }],
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
        [{ id: 'p', name: 'P', auth: { method: 'none' }, runtimes: { pi: piRuntime({ wireProtocol: wp as never }) } }],
        () => null,
      );
      expect(providers[0]?.api).toBe(api);
    }
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
      [{
        id: 'header-only',
        name: 'Header Only',
        auth: { method: 'apiKey' },
        runtimes: {
          pi: piRuntime({ headers: { Authorization: 'Bearer header-secret' } }),
        },
      }],
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
      [{
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
      }],
      () => null,
    );
    expect(providers[0].models).toEqual([
      { id: 'vision', name: 'Vision', contextWindow: undefined, input: ['text', 'image'] },
      { id: 'legacy', name: 'Legacy', contextWindow: undefined },
    ]);
  });

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
      [{
        id: 'cn-provider', name: 'CN Provider', auth: { method: 'none' },
        runtimes: { pi: piRuntime({ models: [{
          id, name, ...(visual ? { supportsImageInput: true } : {}),
          reasoning: true, reasoningEfforts: ['low', 'high', 'max'],
        }] }) },
      }],
      () => null,
    );
    expect(providers[0].models[0]).toEqual({
      id, name, contextWindow: undefined,
      ...(visual ? { input: ['text', 'image'] } : {}),
      reasoning: true,
      thinkingLevelMap: {
        minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
      },
    });
  });
});
