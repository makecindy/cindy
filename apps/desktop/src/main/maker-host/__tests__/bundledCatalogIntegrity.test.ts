import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type Catalog, type CatalogModel } from '@cindy/model-providers';
import {
  getActiveCatalog,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setDiscoveredCodexModels,
  setXdGatewayModels,
} from '../active-catalog.js';

import { filterLegacyGptContextProfiles } from '../legacy-context-profiles.js';
import { deriveAvailableModels } from '../catalog-to-descriptors.js';

// Exercise the actual post-merge catalog consumed by model settings. Optional
// source fields are not required blindly: unknown is distinct from false/zero.
afterEach(() => {
  setDiscoveredCodexModels([]);
  setAnthropicDiscoveredModels([]);
  setXdGatewayModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

/**
 * OpenAI 订阅成员只来自账号清单(Registry 不补型号)。模拟 app-server model/list 只报
 * 成员、不报窗口/档位的形态:discoveredMetadata 为空，资料全部由 Registry 决定。
 */
function seedCodexAccount(...ids: string[]): void {
  setDiscoveredCodexModels(ids.map((id): CatalogModel => ({
    id, name: id, group: 'gpt', contextWindow: 272_000, efforts: [], defaultEffort: null,
    discoveredMetadata: {},
  })));
}

describe('bundled model settings integrity', () => {
  it('keeps every projected model structurally usable with a supported default', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    // 订阅成员只来自账号清单；让账号返回 Registry 登记的全部订阅型号，覆盖每条 overlay。
    const routeIds = (providerId: string, agent: 'codex' | 'claude-code') => [
      ...new Set(
        (BUNDLED_CATALOG.modelRegistry?.models ?? []).flatMap((entry) =>
          entry.status === 'retired' || (entry.mode !== undefined && entry.mode !== 'chat')
            ? []
            : entry.routes
                .filter((route) => route.providerId === providerId && route.agents.includes(agent))
                .map((route) => route.modelId),
        ),
      ),
    ];
    const codexIds = routeIds('openai', 'codex');
    const anthropicIds = routeIds('anthropic', 'claude-code');
    expect(codexIds.length).toBeGreaterThan(0);
    expect(anthropicIds.length).toBeGreaterThan(0);
    seedCodexAccount(...codexIds);
    setAnthropicDiscoveredModels(anthropicIds.map((id): CatalogModel => ({
      id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, discoveredMetadata: {},
    })));
    const catalog = getActiveCatalog();
    let checked = 0;
    for (const provider of catalog.providers) {
      for (const [agent, models] of Object.entries(provider.models)) {
        const ids = new Set<string>();
        for (const model of models ?? []) {
          const label = `${provider.id}/${agent}/${model.id}`;
          expect(ids.has(model.id), `${label}: duplicate model`).toBe(false);
          ids.add(model.id);
          expect(model.name.trim(), `${label}: missing name`).not.toBe('');
          expect(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0, `${label}: window`).toBe(true);
          if (model.contextWindowMax !== undefined) {
            expect(model.contextWindowMax, `${label}: maximum below default`).toBeGreaterThanOrEqual(model.contextWindow);
          }
          if (model.maxOutput !== undefined) {
            expect(Number.isSafeInteger(model.maxOutput) && model.maxOutput > 0, `${label}: output`).toBe(true);
          }
          expect(new Set(model.efforts).size, `${label}: duplicate effort`).toBe(model.efforts.length);
          if (model.defaultEffort !== null) {
            expect(model.efforts, `${label}: unsupported default`).toContain(model.defaultEffort);
          }
          if (model.efforts.length === 0) {
            expect(model.defaultEffort, `${label}: non-reasoning default`).toBeNull();
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].flatMap(
    (model) => [`openai/${model}`, `openai-codex/${model}`, `codex/${model}`, model],
  ))(
    'shows known tiers for Gateway %s without opening them', (id) => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{
      id, name: id, mode: 'chat',
      agents: ['codex', 'claude-code', 'pi'], contextWindow: 1_050_000,
      maxOutputTokens: 128_000, efforts: ['medium', 'high', 'xhigh'],
      defaultEffort: 'medium', supportsFastMode: true,
    }], { authoritative: true });
    const gateway = getActiveCatalog().providers.find((provider) => provider.id === 'xd')!;
    for (const agent of ['codex', 'claude-code', 'pi'] as const) {
      expect(gateway.models[agent]).toHaveLength(1);
      expect(gateway.models[agent]![0]).toMatchObject({
        contextWindow: 272_000, contextWindowMax: 1_050_000,
        efforts: ['medium', 'high', 'xhigh'], defaultEffort: 'medium',
        displayEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
    }
  });
});


it('keeps Gateway restrictions, unknown tiers and discounted prices independent of reference metadata', () => {
  setActiveCatalog(BUNDLED_CATALOG);
  const gatewayModel = {
    id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', mode: 'chat',
    agents: ['codex', 'pi'] as const, contextWindow: 1_050_000,
    efforts: ['medium', 'high'] as const, defaultEffort: 'medium' as const,
    inputCostPerToken: 0.00002, outputCostPerToken: 0.00006, costDiscount: 0.25,
    cacheReadInputTokenCost: 0.000002, cacheCreationInputTokenCost: 0.000025,
  };
  setXdGatewayModels([{
    ...gatewayModel, agents: [...gatewayModel.agents], efforts: [...gatewayModel.efforts],
    perAgent: { codex: { efforts: [] } },
  }]);
  let provider = getActiveCatalog().providers.find((p) => p.id === 'xd')!;
  expect(provider.models.codex![0]).toMatchObject({
    efforts: [], defaultEffort: null, displayEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    cost: { input: 15, output: 45, cacheRead: 1.5, cacheWrite: 18.75 },
  });
  setXdGatewayModels([{ ...gatewayModel, agents: [...gatewayModel.agents], efforts: ['low', 'medium', 'high'] }]);
  provider = getActiveCatalog().providers.find((p) => p.id === 'xd')!;
  expect(provider.models.codex![0].efforts).toContain('low');
  setXdGatewayModels([{ id: 'unknown/model', name: 'Unknown', agents: ['codex'], contextWindow: 100_000 }]);
  expect(getActiveCatalog().providers.find((p) => p.id === 'xd')!.models.codex![0])
    .toMatchObject({ efforts: [], displayEfforts: [], defaultEffort: null });
});

it('removes GPT window presets from new choices while preserving runtime history and custom providers', () => {
  setActiveCatalog(BUNDLED_CATALOG);
  // [1m] 消费端变体只跟随账号返回的上游型号出现。
  seedCodexAccount('gpt-5.6-sol');
  const runtime = getActiveCatalog();
  const openai = runtime.providers.find((p) => p.id === 'openai')!;
  const legacy = openai.models['claude-code']!.find((m) => m.id.endsWith('[1m]'))!;
  expect(legacy).toBeDefined();
  const withCustom: Catalog = {
    ...runtime, providers: [...runtime.providers,
      { ...openai, id: 'openai-independent', source: 'user', auth: { method: 'oauth', native: 'codex' } },
      { ...openai, id: 'user:test', source: 'user', auth: { method: 'apiKey' } },
    ],
  };
  const selectable = filterLegacyGptContextProfiles(withCustom);
  expect(selectable.providers.find((p) => p.id === 'openai')!.models['claude-code']!.some((m) => m.id.endsWith('[1m]'))).toBe(false);
  expect(selectable.providers.find((p) => p.id === 'openai-independent')!.models['claude-code']!.some((m) => m.id.endsWith('[1m]'))).toBe(false);
  expect(selectable.providers.find((p) => p.id === 'user:test')!.models['claude-code']).toContain(legacy);
  expect(openai.models['claude-code']).toContain(legacy);
  expect(deriveAvailableModels(runtime, 'claude-code').some((m) => m.id === legacy.id)).toBe(false);
});


it('keeps ordinary GPT defaults at 272K while exposing the catalog capacity without a native cache', () => {
  setActiveCatalog(BUNDLED_CATALOG);
  // 账号清单只报成员(无 native models_cache 的窗口)，窗口资料由 Registry 补。
  seedCodexAccount('gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna');
  const provider = getActiveCatalog().providers.find((p) => p.id === 'openai')!;
  for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    for (const agent of ['codex', 'claude-code'] as const) {
      const model = provider.models[agent]!.find((m) => m.id === (agent === 'claude-code' ? `chatgpt/${id}` : id));
      expect(model, `${agent}/${id}`).toMatchObject({ contextWindow: 272_000, contextWindowMax: 1_050_000 });
    }
  }
});
