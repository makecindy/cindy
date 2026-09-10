import { describe, expect, it } from 'vitest';
import {
  applyModelProductDefaults,
  resolveModelProductDefaults,
  validModelProductDefaults,
} from '../modelCatalogPolicy.js';
import { buildUserProvider } from '../user-provider.js';
import type {
  CatalogModel,
  CustomProviderConfig,
  ProviderPreset,
} from '../types.js';
import type { ModelRegistry } from '../modelAccessBean.js';

describe('published model defaults', () => {
  it('distinguishes product identity, channel and engine despite duplicate legacy upstream IDs', () => {
    const registry: ModelRegistry = {
      schemaVersion: 5,
      updatedAt: '2026-09-10T00:00:00Z',
      models: [
        {
          id: 'openai/gpt-test',
          name: 'Test',
          routes: [
            { providerId: 'openai', modelId: 'gpt-test', agents: ['codex'] },
          ],
          productDefaults: {
            contextWindow: 272000,
            fast: false,
            perAgent: { pi: { effort: 'low' } },
          },
        },
        {
          id: 'openai/gpt-test[1m]',
          name: 'Test',
          routes: [
            { providerId: 'openai', modelId: 'gpt-test', agents: ['codex'] },
          ],
          productDefaults: { contextWindow: 1000000 },
        },
        {
          id: 'xd/gpt-test',
          name: 'Test',
          routes: [
            { providerId: 'xd', modelId: 'gpt-test', agents: ['codex'] },
          ],
          productDefaults: { contextWindow: 200000 },
        },
      ],
    };
    expect(
      resolveModelProductDefaults(
        registry,
        'openai',
        'chatgpt/gpt-test',
        'codex',
      )?.contextWindow,
    ).toBe(272000);
    expect(
      resolveModelProductDefaults(registry, 'openai', 'gpt-test[1m]', 'codex')
        ?.contextWindow,
    ).toBe(1000000);
    expect(
      resolveModelProductDefaults(registry, 'openai', 'gpt-test', 'pi')?.effort,
    ).toBe('low');
    expect(
      resolveModelProductDefaults(registry, 'xd', 'gpt-test', 'codex')
        ?.contextWindow,
    ).toBe(200000);
    expect(
      resolveModelProductDefaults(registry, 'my-api', 'gpt-test', 'codex'),
    ).toBeUndefined();
  });
  it('preserves maximum capacity, explicit false/null and never invents Fast support', () => {
    const model: CatalogModel = {
      id: 'test',
      name: 'Test',
      contextWindow: 1000000,
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const result = applyModelProductDefaults(
      model,
      { contextWindow: 272000, visible: false, effort: null, fast: true },
      'catalog-7',
    );
    expect(result).toMatchObject({
      contextWindow: 272000,
      contextWindowMax: 1000000,
      defaultEnabled: false,
      defaultEffort: null,
      defaultFast: false,
      catalogDefaults: { revision: 'catalog-7' },
    });
    expect(model.contextWindow).toBe(1000000);
    expect(validModelProductDefaults({ fast: false, effort: null })).toBe(true);
    expect(validModelProductDefaults({ fast: 'false' })).toBe(false);
    expect(
      validModelProductDefaults({
        perAgent: { codex: { preferredAgent: 'pi' } },
      }),
    ).toBe(false);
  });
  it('updates a matching API template without replacing form edits or following a changed endpoint', () => {
    const config: CustomProviderConfig = {
      id: 'personal',
      name: 'Personal',
      runtimes: {
        pi: {
          catalogPresetId: 'official-api',
          baseUrl: 'https://api.example/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'm', name: 'M' }],
        },
      },
    };
    const presets: ProviderPreset[] = [
      {
        id: 'official-api',
        name: 'API',
        runtimes: {
          pi: {
            baseUrl: 'https://api.example/v1',
            wireProtocol: 'openai-chat',
            models: [
              {
                id: 'm',
                name: 'M',
                contextWindow: 1000000,
                reasoning: true,
                reasoningEfforts: ['low', 'high'],
                productDefaults: {
                  contextWindow: 272000,
                  effort: 'low',
                  visible: false,
                },
              },
            ],
          },
        },
      },
    ];
    const current = () =>
      buildUserProvider(config, {
        presets,
        catalogRevision: 'catalog-9',
        modelRegistry: {
          schemaVersion: 5,
          updatedAt: '2026-09-10T00:00:00Z',
          models: [],
        },
      }).models.pi![0];
    expect(current()).toMatchObject({
      contextWindow: 272000,
      contextWindowMax: 1000000,
      defaultEffort: 'low',
      defaultEnabled: false,
      catalogDefaults: { revision: 'catalog-9' },
    });
    config.runtimes.pi!.models[0].contextWindow = 500000;
    config.runtimes.pi!.models[0].defaultEnabled = true;
    expect(current()).toMatchObject({
      contextWindow: 500000,
      defaultEnabled: true,
    });
    config.runtimes.pi!.baseUrl = 'https://different.example/v1';
    expect(current().catalogDefaults).toBeUndefined();
  });
});
