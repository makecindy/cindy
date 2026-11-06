import { describe, expect, it } from 'vitest';

import type { ModelRegistry } from '../modelAccessBean.js';
import {
  inheritSelectionAliasPreferences, projectSelectionAliases, markedSelectionAliasGroups, selectionAliasGroups, selectionAliasMember, selectionAliasTargets,
  type SelectionAliasEvidence, type SelectionAliasPreferences,
} from '../selectionAliasGroups.js';
import type { AgentKind, CatalogModel, Provider } from '../types.js';

// Protocol evidence here is synthetic. It must not admit the real DeepSeek or Kimi channels.
const oldId = 'flash-legacy';
const newId = 'flash';
const proof: SelectionAliasEvidence = {
  baseModelId: 'example/flash', preferredModelId: newId, modelIds: [newId, oldId],
  endpoints: [{ baseUrl: 'https://models.example.test/v1', wireProtocol: 'openai-chat' }],
  officialSource: 'https://docs.example.test/aliases', verifiedAt: '2026-11-03',
};
const registry: ModelRegistry = {
  schemaVersion: 5, updatedAt: '2026-11-03T00:00:00Z', models: [],
  baseModels: [{ id: 'example/flash', aliases: [oldId, newId], defaults: {} }],
};

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 1_000_000, efforts: ['low', 'high'],
    defaultEffort: 'high', supportsFastMode: false, ...extra };
}

function provider(): Provider {
  return {
    id: 'example-account', name: 'Example', source: 'user', agents: ['claude-code', 'codex', 'pi'],
    auth: { method: 'apiKey' },
    routing: Object.fromEntries(['claude-code', 'codex', 'pi'].map((agent) => [agent, {
      upstream: 'https://models.example.test/v1', wireProtocol: 'openai-chat',
      authStrategy: 'api-key-header',
    }])),
    models: { 'claude-code': [model(newId)], codex: [model(oldId), model(newId)], pi: [model(newId)] },
  };
}

function groups(
  p = provider(),
  preferences: (agent: AgentKind, id: string) => SelectionAliasPreferences = () => ({}),
  evidence: readonly SelectionAliasEvidence[] = [proof],
  acceptedRegistry: ModelRegistry | undefined = registry,
) {
  return selectionAliasGroups({ provider: p, registry: acceptedRegistry, evidence, preferences });
}

describe('selection alias admission and original route preservation', () => {
  it('does not admit any real channel by default or from Registry aliases alone', () => {
    expect(selectionAliasGroups({ provider: provider(), registry, preferences: () => ({}) })).toEqual([]);
    expect(groups(provider(), undefined, [])).toEqual([]);
  });

  it('keeps every original member without changing provider data', () => {
    const p = provider();
    const before = structuredClone(p);
    const [group] = groups(p);
    expect(group.keyModelId).toBe(newId);
    expect(group.providerId).toBe(p.id);
    expect(group.members.codex?.map((m) => m.id)).toEqual([newId, oldId]);
    expect(p).toEqual(before);
    expect(selectionAliasMember(group, 'codex')?.id).toBe(newId);
    expect(selectionAliasMember(group, 'codex', oldId)?.id).toBe(oldId);
    expect(selectionAliasMember(group, 'pi', oldId)).toBeUndefined();
  });

  it('uses the only real route for a new pick, but never rewrites a saved target', () => {
    const p = provider();
    p.models.codex = [model(oldId)];
    const [group] = groups(p);
    expect(selectionAliasMember(group, 'codex')?.id).toBe(oldId);
    expect(selectionAliasMember(group, 'codex', newId)).toBeUndefined();
    expect(selectionAliasMember(group, 'codex', 'missing')).toBeUndefined();
  });

  it('never adds an unconfigured engine', () => {
    const p = provider();
    delete p.models.pi;
    const [group] = groups(p);
    expect(selectionAliasMember(group, 'pi')).toBeUndefined();
    expect(selectionAliasTargets(group, 'pi')).toEqual([]);
  });

  it.each([
    ['endpoint', { baseUrl: 'https://proxy.example.test/v1', wireProtocol: 'openai-chat' }],
    ['protocol', { baseUrl: 'https://models.example.test/v1', wireProtocol: 'openai-responses' }],
    ['path', { baseUrl: 'https://models.example.test/v1', wireProtocol: 'openai-chat', requestPath: '/custom' }],
  ] as const)('does not borrow evidence after a model-level %s change', (_, route) => {
    const p = provider();
    p.models.codex![0].route = route;
    expect(groups(p)).toEqual([]);
  });

  it('does not infer a missing runtime protocol or ignore a serializer override', () => {
    const p = provider();
    delete p.routing.codex!.wireProtocol;
    expect(groups(p)).toEqual([]);
    p.routing.codex!.wireProtocol = 'openai-chat';
    p.models.codex![0].api = 'anthropic-messages';
    expect(groups(p)).toEqual([]);
  });

  it('rejects serializers that cannot be projected to the verified wire protocol', () => {
    const p = provider();
    p.models.pi![0].piApi = 'bedrock-converse-stream';
    expect(groups(p)).toEqual([]);
  });

  it('checks both API declarations rather than letting one hide a conflicting Pi serializer', () => {
    const p = provider();
    p.models.pi![0].api = 'openai-completions';
    p.models.pi![0].piApi = 'anthropic-messages';
    expect(groups(p)).toEqual([]);
  });

  it.each(['https://user:password@models.example.test/v1',
    'https://models.example.test/v1?token=invalid', 'http://models.example.test/v1'])
  ('does not normalize a different endpoint into an admitted URL: %s', (upstream) => {
    const p = provider();
    p.routing.codex!.upstream = upstream;
    expect(groups(p)).toEqual([]);
  });

  it('requires unique current public identity and nonoverlapping channel evidence', () => {
    expect(groups(provider(), undefined, [proof], { ...registry, baseModels: [] })).toEqual([]);
    expect(groups(provider(), undefined, [proof], { ...registry, baseModels: [
      ...registry.baseModels!, { id: 'other/flash', aliases: [oldId], defaults: {} },
    ] })).toEqual([]);
    expect(groups(provider(), undefined, [proof, { ...proof }])).toEqual([]);
  });

  it('does not merge same-name models, price products or window variants absent evidence', () => {
    const p = provider();
    p.models.codex = ['gpt-x', 'codex/gpt-x', 'gpt-x[1m]', 'kimi-k3', 'k3-256k']
      .map((id) => model(id, { name: 'Same name' }));
    p.models['claude-code'] = [];
    p.models.pi = [];
    expect(groups(p)).toEqual([]);
  });

  it.each([
    { contextWindow: 256_000 }, { supportsFastMode: true }, { supportsImageInput: true },
    { efforts: ['high'] }, { defaultEnabled: false }, { cost: { input: 0.1 } },
    { userModelConfig: { id: oldId, name: oldId, contextWindow: 256_000 } },
  ] satisfies Partial<CatalogModel>[])('preserves routes with different facts or explicit settings: %j', (change) => {
    const p = provider();
    Object.assign(p.models.codex![0], change);
    expect(groups(p)).toEqual([]);
  });

  it('allows cross-engine differences while keeping each engine capability untouched', () => {
    const p = provider();
    p.models.pi![0].contextWindow = 128_000;
    const [group] = groups(p);
    expect(selectionAliasMember(group, 'pi')?.contextWindow).toBe(128_000);
    expect(selectionAliasMember(group, 'codex')?.contextWindow).toBe(1_000_000);
  });

  it.each(['engine', 'effort', 'fast'] as const)('keeps conflicting %s preferences as separate entries', (field) => {
    const values = field === 'fast' ? [true, false] : ['high', 'low'];
    expect(groups(provider(), (_, id) => ({ [field]: id === oldId ? values[0] : values[1] })))
      .toEqual([]);
  });

  it('does not treat a single-sided explicit false as a conflict or write it anywhere', () => {
    const calls: string[] = [];
    const result = groups(provider(), (_, id) => {
      calls.push(id);
      return id === oldId ? { fast: false, effort: 'high' } : {};
    });
    expect(result).toHaveLength(1);
    expect(calls).toContain(oldId);
  });

  it('inherits individual old-ID fields and retains read sources for restore without mutation', () => {
    const values = [{ modelId: oldId, preferences: { engine: 'codex', fast: false } },
      { modelId: newId, preferences: { effort: 'high' } }];
    const before = structuredClone(values);
    expect(inheritSelectionAliasPreferences(values)).toEqual({
      preferences: { engine: 'codex', fast: false, effort: 'high' },
      sourceModelIds: [newId, oldId],
    });
    expect(values).toEqual(before);
    expect(inheritSelectionAliasPreferences([])).toEqual({ preferences: {}, sourceModelIds: [] });
    expect(inheritSelectionAliasPreferences([
      { modelId: oldId, preferences: { fast: false } },
      { modelId: newId, preferences: { fast: true } },
    ])).toBeUndefined();
  });

  it.each([{ effort: 'unsupported' }, { engine: 'missing' }, { fast: true }])
  ('does not hide an unusable old preference behind capability clamping: %j', (pref) => {
    expect(groups(provider(), (_, id) => id === oldId ? pref : {})).toEqual([]);
  });

  it('includes all existing members in management targets even when both aliases are hidden', () => {
    const p = provider();
    for (const models of Object.values(p.models)) for (const m of models ?? []) m.defaultEnabled = false;
    const [group] = groups(p);
    expect(selectionAliasTargets(group, 'codex')).toEqual([
      { agent: 'codex', modelId: newId }, { agent: 'codex', modelId: oldId },
    ]);
    expect(selectionAliasTargets(group)).toHaveLength(4);
    expect(selectionAliasMember(group, 'codex')).toBeUndefined();
    expect(selectionAliasMember(group, 'codex', oldId)?.id).toBe(oldId);
  });

  it.each([{ disabled: true }, { status: 'retired' }, { availability: 'requires_payment' }] as const)
  ('keeps historical and management identity without allowing a new pick: %j', (state) => {
    const p = provider();
    for (const models of Object.values(p.models)) for (const m of models ?? []) Object.assign(m, state);
    const [group] = groups(p);
    expect(selectionAliasTargets(group, 'codex')).toHaveLength(2);
    expect(selectionAliasMember(group, 'codex')).toBeUndefined();
    expect(selectionAliasMember(group, 'codex', oldId)?.id).toBe(oldId);
  });

  it('is deterministic across member ordering and never joins connections', () => {
    const p = provider();
    const expected = groups(p);
    p.models.codex!.reverse();
    expect(groups(p)).toEqual(expected);
    p.id = 'another-account';
    expect(groups(p)[0].providerId).toBe('another-account');
    expect(expected[0].providerId).toBe('example-account');
  });
});


describe('host marker consumption', () => {
  const marked = () => {
    const p = provider();
    Object.values(p.models).flat().forEach((m) => { if (m) m.selectionAliasKey = newId; });
    return p;
  };
  it('inherits a single legacy preference without rewriting any member', () => {
    const p = marked();
    const before = structuredClone(p);
    expect(markedSelectionAliasGroups(p, (_, id) => id === oldId ? { effort: 'high', fast: false } : {})).toHaveLength(1);
    expect(p).toEqual(before);
  });
  it.each([
    (id: string) => ({ effort: id === oldId ? 'low' : 'high' }),
    (id: string) => ({ fast: id === oldId }),
    (id: string) => ({ visible: id === oldId }),
    () => ({ engine: 'missing' }),
    () => ({ effort: 'removed' }),
    () => ({ fast: true }),
  ])('keeps separate rows on incompatible preferences', (read) => {
    expect(markedSelectionAliasGroups(marked(), (_, id) => read(id))).toEqual([]);
  });
  it('re-splits on a per-member protocol/window/price change', () => {
    const p = marked();
    p.models.codex![0].contextWindow = 1234;
    expect(markedSelectionAliasGroups(p, () => ({}))).toEqual([]);
  });
});


describe('verified official DeepSeek alias projection', () => {
  const current = 'deepseek-flash';
  const legacy = 'deepseek-v4-flash';
  const accepted: ModelRegistry = { schemaVersion: 5, updatedAt: '2026-11-04T00:00:00Z', models: [],
    baseModels: [{ id: 'deepseek/deepseek-v4.1-flash', aliases: [current, legacy], defaults: {} }] };
  function official(): Provider {
    const p = provider();
    p.routing = {
      'claude-code': { upstream: 'https://api.deepseek.com/anthropic', wireProtocol: 'anthropic-messages', authStrategy: 'api-key-header' },
      codex: { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-chat', authStrategy: 'api-key-header' },
      pi: { upstream: 'https://api.deepseek.com/anthropic', wireProtocol: 'anthropic-messages', authStrategy: 'api-key-header' },
    };
    const newest = () => model(current, { contextWindow: 1_048_576, maxOutput: 393_216,
      supportsImageInput: true, userModelConfig: { id: current, name: 'New', discoveredMetadata: { contextWindow: 1_048_576 } } });
    p.models = { 'claude-code': [newest()], pi: [newest()], codex: [newest(), model(legacy, {
      contextWindow: 1_000_000, maxOutput: 384_000, modalities: { input: ['text'], output: ['text'] },
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      userModelConfig: { id: legacy, name: 'Legacy', discoveredMetadata: {} },
    })] };
    return p;
  }
  it('corrects proven stale defaults, preserves original windows/configs, and enables one group', () => {
    const p = official();
    const before = structuredClone(p);
    const projected = projectSelectionAliases(p, accepted);
    const rows = projected.models.codex!;
    expect(rows.map((m) => m.selectionAliasKey)).toEqual([current, current]);
    expect(rows.map((m) => m.contextWindow)).toEqual([1_048_576, 1_000_000]);
    expect(rows.every((m) => m.supportsImageInput && m.maxOutput === 393_216)).toBe(true);
    expect(rows[1].modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(rows[1].cost).toBeUndefined();
    expect(projected.models['claude-code']).toHaveLength(1);
    expect(projected.models.pi).toHaveLength(1);
    expect(markedSelectionAliasGroups(projected, () => ({}))).toHaveLength(1);
    expect(p).toEqual(before);
    expect(rows[1].userModelConfig).toEqual(p.models.codex![1].userModelConfig);
  });
  it('preserves an explicit output limit instead of normalizing it', () => {
    const p = official();
    p.models.codex![1].userModelConfig!.maxOutputTokens = 384_000;
    const projected = projectSelectionAliases(p, accepted);
    expect(projected.models.codex![1]).toEqual(p.models.codex![1]);
    expect(markedSelectionAliasGroups(projected, () => ({}))).toEqual([]);
  });
  it.each(['contextWindow', 'supportsImageInput', 'modalities', 'route'] as const)('preserves explicit %s and does not merge', (field) => {
    const p = official();
    Object.assign(p.models.codex![1].userModelConfig!, {
      [field]: field === 'contextWindow' ? 1_000_000 : field === 'supportsImageInput' ? false :
        field === 'route' ? { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' } : { input: ['text'], output: ['text'] },
    });
    const projected = projectSelectionAliases(p, accepted);
    expect(projected.models.codex![1]).toEqual(p.models.codex![1]);
    expect(markedSelectionAliasGroups(projected, () => ({}))).toEqual([]);
  });
  it('preserves local public or per-agent metadata overrides', () => {
    const p = official();
    expect(projectSelectionAliases(p, accepted, { hasUserMetadata: (_, m) => m.id === legacy })).toEqual(p);
  });
  it('does not apply official corrections to a proxy, built-in gateway, unknown path or missing identity', () => {
    const p = official(); p.routing.codex!.upstream = 'https://proxy.example.test';
    expect(projectSelectionAliases(p, accepted)).toEqual(p);
    const builtin = { ...official(), source: 'builtin' as const };
    expect(projectSelectionAliases(builtin, accepted)).toEqual(builtin);
    expect(projectSelectionAliases(official(), undefined)).toEqual(official());
    const path = official(); path.routing.codex!.requestPath = '/custom';
    expect(projectSelectionAliases(path, accepted)).toEqual(path);
  });
  it('keeps a genuinely different window or price independent instead of relaxing all conflicts', () => {
    for (const change of [{ contextWindow: 200_000 }, { cost: { input: 9, output: 12 } }]) {
      const p = official(); Object.assign(p.models.codex![1], change);
      const projected = projectSelectionAliases(p, accepted);
      expect(markedSelectionAliasGroups(projected, () => ({}))).toEqual([]);
    }
  });
  it('preserves custom prices and keeps old preferences, visibility and engine conflicts separate', () => {
    const projected = projectSelectionAliases(official(), accepted);
    for (const read of [
      (_agent: AgentKind, id: string) => ({ customPrice: id === legacy }),
      (_agent: AgentKind, id: string) => ({ effort: id === legacy ? 'low' : 'high' }),
      (_agent: AgentKind, id: string) => ({ visible: id !== legacy }),
    ]) expect(markedSelectionAliasGroups(projected, read)).toEqual([]);
  });
});


it('uses the existing engine default only when the route omits a protocol', () => {
  const p = provider();
  p.routing['claude-code']!.wireProtocol = undefined;
  const explicit = structuredClone(p);
  explicit.routing['claude-code']!.wireProtocol = 'openai-responses';
  const e = { ...proof, endpoints: [...proof.endpoints, { baseUrl: 'https://models.example.test/v1', wireProtocol: 'anthropic-messages' as const }] };
  expect(groups(p, undefined, [e])).toHaveLength(1);
  expect(groups(explicit, undefined, [e])).toHaveLength(0);
});
it('keeps member-specific thinking and unsupported Ultrafast settings separate', () => {
  expect(groups(provider(), () => ({ customThinking: true }))).toHaveLength(0);
  expect(groups(provider(), () => ({ fast: 'ultrafast' }))).toHaveLength(0);
});


it('compares only verified existing Flash reference bands without writing a replacement cost', () => {
  const p = provider();
  p.models.codex = ['deepseek-flash','deepseek-v4-flash'].map(id => ({ ...model(id), id, selectionAliasKey:'deepseek-flash', cost: id === 'deepseek-flash' ? {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0} : undefined }));
  p.models['claude-code'] = []; p.models.pi = [];
  const before = structuredClone(p);
  expect(markedSelectionAliasGroups(p, () => ({}))).toHaveLength(1);
  expect(p).toEqual(before);
  p.models.codex[0].cost = {input:0.9,output:2,cacheRead:0.01};
  expect(markedSelectionAliasGroups(p, () => ({}))).toHaveLength(0);
  p.models.codex[0].cost = {input:0.3,output:1.2,cacheRead:0.006};
  p.models.codex[1].cost = {input:0.2,output:0.8};
  expect(markedSelectionAliasGroups(p, () => ({}))).toHaveLength(0);
});
