/**
 * BYOM host 解析 —— 自定义 provider(pi runtime)→ pi 原生 provider spec + env。
 * 覆盖:wire protocol → pi api 映射、apiKey/none/oauth 三态、缺 key 跳过、env key 名。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-native-provider-test',
  },
}));

import { buildPiNativeProvidersFromConfigs, piNativeKeyEnvVar } from '../pi-host.js';

type Cfg = Parameters<typeof buildPiNativeProvidersFromConfigs>[0][number];

const piRuntime = (over: Partial<NonNullable<Cfg['runtimes']['pi']>> = {}) => ({
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  ...over,
});

describe('buildPiNativeProvidersFromConfigs', () => {
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
});
