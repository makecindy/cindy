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
