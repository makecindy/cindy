import { describe, expect, it } from 'vitest';
import { buildByokProvider, byokNativeConfigs, mergeByokNativeConfigs } from '../byokProvider.js';

const credential = {
  providerId: 'byok-a',
  connectionRevision: 1,
  status: 'ready' as const,
  endpoint: 'https://gateway.example.invalid/v1',
  apiKey: 'invalid-test-key',
};

const chatModel = {
  id: 'byok-a/chat',
  name: 'Chat',
  agents: ['pi'] as Array<'pi'>,
  mode: 'chat' as const,
  currency: 'CNY' as const,
  icon: 'sparkles',
  contextWindow: 128000,
  nativeApi: 'openai-completions' as const,
  perAgent: { pi: { wireProtocol: 'openai-completions' as const } },
};

const imageModel = {
  id: 'byok-a/gpt-image-2',
  name: 'GPT Image 2',
  agents: [] as Array<'pi'>,
  mode: 'image_generation' as const,
  currency: 'CNY' as const,
  perAgent: {},
  nativeApi: 'openai-images' as const,
  modalities: { input: ['text', 'image'], output: ['image'] },
};

describe('buildByokProvider model types', () => {
  it('projects image-generation models into imageModels instead of chat engines', () => {
    const result = buildByokProvider({
      provider: {
        id: 'byok-a',
        name: 'Enterprise',
        connectionRevision: 1,
        models: [chatModel, imageModel],
      },
      credential,
    });
    expect(result.source).toBe('organization');
    expect(result.models.pi?.map((model) => model.id)).toEqual(['byok-a/chat']);
    expect(result.models.pi?.[0]?.nativeApi).toBe('openai-completions');
    expect(result.models.pi?.[0]?.icon).toBe('sparkles');
    expect(result.imageModels).toEqual([
      expect.objectContaining({
        id: 'byok-a/gpt-image-2',
        name: 'GPT Image 2',
        mode: 'image_generation',
        nativeApi: 'openai-images',
      }),
    ]);
    expect(result.imageDefaults).toEqual({ standard: 'byok-a/gpt-image-2' });
    expect(result.agents).toEqual(['pi']);
    expect(byokNativeConfigs([result])[0]?.runtimes.pi?.models.map((model) => model.id)).toEqual([
      'byok-a/chat',
    ]);
  });

  it('can project an image-only enterprise Provider without chat engines', () => {
    const result = buildByokProvider({
      provider: { id: 'byok-a', name: 'Enterprise', connectionRevision: 1, models: [imageModel] },
      credential,
    });
    expect(result.agents).toEqual([]);
    expect(result.models).toEqual({});
    expect(result.imageModels?.map((model) => model.id)).toEqual(['byok-a/gpt-image-2']);
    expect(byokNativeConfigs([result])).toEqual([]);
  });

  it('gives a managed Pi config precedence over a legacy personal id collision', () => {
    const managed = buildByokProvider({
      provider: {
        id: 'byok-a',
        name: 'Enterprise',
        connectionRevision: 1,
        models: [chatModel],
      },
      credential,
    });
    const configs = mergeByokNativeConfigs(
      [
        {
          id: 'byok-a',
          name: 'Legacy personal',
          runtimes: { pi: { baseUrl: 'https://personal.example.invalid/v1', models: [] } },
        },
        {
          id: 'personal-other',
          name: 'Personal other',
          runtimes: { pi: { baseUrl: 'https://other.example.invalid/v1', models: [] } },
        },
      ],
      [managed],
    );
    expect(configs.map((provider) => provider.id)).toEqual(['personal-other', 'byok-a']);
    expect(configs[1]?.runtimes.pi?.baseUrl).toBe('https://gateway.example.invalid');
    expect(configs[1]?.runtimes.pi?.models[0]?.route?.baseUrl).toBe(
      'https://gateway.example.invalid/v1',
    );
  });

  it('does not fall back to a personal Pi config while the managed credential is pending', () => {
    const configs = mergeByokNativeConfigs(
      [
        {
          id: 'byok-a',
          name: 'Legacy personal',
          auth: { method: 'none' },
          runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1', models: [] } },
        },
      ],
      [
        {
          id: 'byok-a',
          name: 'Enterprise pending',
          source: 'organization',
          auth: { method: 'managed' },
          access: { kind: 'managed' },
          agents: [],
          models: {},
          routing: {},
        },
      ],
    );

    expect(configs).toEqual([]);
  });
});


it.each([
  ['openai-responses', ['codex', 'pi']],
  ['anthropic-messages', ['claude-code', 'pi']],
  ['openai-completions', ['pi']],
] as const)('keeps managed model enablement separate from %s compatibility', (nativeApi, enabled) => {
  const model = { ...chatModel, nativeApi, defaultEnabled: true,
    maxOutputTokens: 32000, supportsFastMode: false,
    agents: ['claude-code', 'codex', 'pi'] as Array<'claude-code' | 'codex' | 'pi'>,
    perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' as const, defaultEnabled: true },
      codex: { wireProtocol: 'openai-responses' as const, defaultEnabled: true }, pi: { wireProtocol: nativeApi, defaultEnabled: true } },
  };
  const provider = buildByokProvider({ provider: { id: 'byok-a', name: 'Enterprise',
    connectionRevision: 1, models: [model] }, credential });
  for (const agent of model.agents)
    expect(provider.models[agent]?.[0]?.defaultEnabled).toBe((enabled as readonly string[]).includes(agent));
  expect(byokNativeConfigs([provider])[0]?.runtimes.pi?.models[0]).toMatchObject({
    nativeApi, maxOutputTokens: 32000, supportsFastMode: false,
  });
});


it('keeps live text-only and Pi effort restrictions above inherited capabilities', () => {
  const provider = buildByokProvider({ provider: { id: 'byok-a', name: 'Enterprise', connectionRevision: 1,
    models: [{ ...chatModel, id: 'gpt-7-sol', nativeApi: 'openai-responses',
      modalities: { input: ['text'], output: ['text'] }, efforts: ['high', 'ultra'], defaultEffort: 'ultra',
      perAgent: { pi: { wireProtocol: 'openai-responses' } } }],
  }, credential });
  expect(provider.models.pi?.[0]).toMatchObject({ supportsImageInput: false, efforts: ['high'], defaultEffort: null });
});

it.each([undefined, 64000])('only verifies a future BYOK model window when explicitly declared: %s', (contextWindow) => {
  const provider = buildByokProvider({ provider: { id: 'byok-a', name: 'Enterprise', connectionRevision: 1,
    models: [{ ...chatModel, id: 'gpt-7-sol', contextWindow, nativeApi: 'openai-responses',
      perAgent: { pi: { wireProtocol: 'openai-responses' } } }],
  }, credential });
  expect(provider.models.pi?.[0]?.contextWindow).toBeGreaterThan(0);
  expect(provider.models.pi?.[0]?.contextWindowVerified).toBe(contextWindow !== undefined);
});
