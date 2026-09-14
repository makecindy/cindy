import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../catalog.js';
import { parseModelRegistry } from '../modelAccessValidator.js';
import { resolveModelMetadata } from '../modelMetadataLayers.js';
import {
  projectProviderMediaModels,
  providerMediaField,
} from '../providerMediaModels.js';
import { deriveModelList } from '../modelList.js';
import { buildRegistry, chatEligibleSourcesForModel } from '../registry.js';
import { buildUserProvider } from '../user-provider.js';
import {
  isChatEligible,
  isAgentSelectableModel,
  isModelSelectableForNewRoute,
} from '../classification.js';
import type { ModelRegistry } from '../modelAccessBean.js';
import type { Provider } from '../types.js';

const modes = [
  'image_generation',
  'video_generation',
  'audio_speech',
  'audio_transcription',
  'audio_generation',
  'realtime',
  'embedding',
] as const;
const shell: Provider = {
  id: 'supplier',
  name: 'Supplier',
  source: 'builtin',
  auth: { method: 'apiKey' },
  agents: [],
  routing: {},
  models: {},
};
function registry(mode: string): ModelRegistry {
  return {
    schemaVersion: 4,
    updatedAt: '2026-09-09T00:00:00.000Z',
    baseModels: [
      {
        id: 'vendor/model',
        aliases: ['model'],
        defaults: {
          name: 'Public',
          mode,
          modalities: { input: ['text'], output: ['image'] },
        },
      },
    ],
    models: [
      {
        id: 'vendor/model',
        name: 'Entry',
        modelRef: 'vendor/model',
        routes: [{ providerId: 'supplier', modelId: 'model', agents: [] }],
      },
    ],
  };
}

describe('V4 media model metadata', () => {
  it('resolves account media against public routes while preserving membership and override ids', () => {
    const r = registry('image_generation');
    r.models[0].routes = [{ providerId: 'openai', modelId: 'openai/model', agents: [],
      forceOverrides: { name: 'Corrected' }, overrideReason: 'verified fixture' }];
    const account: Provider = { ...shell, id: 'openai-a', source: 'user',
      auth: { method: 'oauth', native: 'codex' },
      imageModels: [{ id: 'openai-a/model', name: 'Old' }] };
    const seen: string[] = [];
    expect(projectProviderMediaModels(account, r, {
      addDeclared: true,
      userMetadata: (id) => { seen.push(id); return undefined; },
    }).imageModels).toEqual([expect.objectContaining({ id: 'openai-a/model', name: 'Corrected' })]);
    expect(seen).toEqual(['openai-a/model']);
    expect(projectProviderMediaModels({ ...account, imageModels: [] }, r, { addDeclared: true }).imageModels).toEqual([]);
    expect(projectProviderMediaModels(account, r, { userMetadata: () => ({ name: 'Mine' }) }).imageModels?.[0].name).toBe('Mine');
    r.models[0].status = 'retired';
    expect(projectProviderMediaModels(account, r).imageModels).toEqual([]);
  });

  it.each(modes)(
    '%s parses, projects and stays out of chat selection',
    (mode) => {
      const r = registry(mode);
      expect(parseModelRegistry(r)).toMatchObject({ ok: true });
      const catalog = parseCatalog({
        version: '4',
        providers: [shell],
        modelRegistry: r,
      });
      const entry = catalog.providers[0][providerMediaField(mode)!]![0];
      expect(entry).toMatchObject({ id: 'model', name: 'Entry', mode });
      expect(isChatEligible(entry)).toBe(false);
      expect(resolveModelMetadata(r, 'private-proxy', 'model').mode).toBe(mode);
    },
  );

  it.each(modes)(
    'custom %s retains provider ID and user overrides across catalog updates',
    (mode) => {
      const r = registry(mode);
      const config = {
        id: 'private',
        name: 'Private',
        runtimes: {
          codex: {
            baseUrl: 'https://private.example/v1',
            models: [
              {
                id: 'model',
                name: 'Mine',
                nameExplicit: true,
                mode,
                modalities: { input: [], output: [] },
                discoveredMetadata: {},
              },
            ],
          },
        },
      };
      r.baseModels![0].defaults.name = 'Updated public';
      const provider = buildUserProvider(config, { modelRegistry: r });
      expect(provider.id).toBe('private');
      expect(provider.routing.codex?.upstream).toBe(
        'https://private.example/v1',
      );
      expect(provider.models.codex![0]).toMatchObject({
        id: 'model',
        name: 'Mine',
        mode,
        modalities: { input: [], output: [] },
      });
      expect(provider[providerMediaField(mode)!]).toHaveLength(1);
      expect(isChatEligible(provider.models.codex![0])).toBe(false);
      expect(
        isAgentSelectableModel(provider.models.codex![0], {
          userProvider: true,
        }),
      ).toBe(false);
      expect(
        isModelSelectableForNewRoute(provider.models.codex![0], {
          userProvider: true,
        }),
      ).toBe(false);
      const views = buildRegistry(
        { version: '4', providers: [provider], modelRegistry: r },
        { [provider.id]: true },
      );
      expect(deriveModelList({ providers: views, agent: 'codex' })).toEqual([]);
      expect(chatEligibleSourcesForModel(views, 'model', 'codex')).toEqual([]);
    },
  );

  it('keeps discovery, force and explicit user metadata in their original precedence', () => {
    const r = registry('image_generation');
    r.models[0].routes[0].forceOverrides = {
      name: 'Corrected',
      modalities: { input: ['text'], output: [] },
    };
    r.models[0].routes[0].overrideReason = 'Verified correction';
    const provider = {
      ...shell,
      imageModels: [
        { id: 'model', name: 'Old', discoveredMetadata: { name: 'Live' } },
      ],
    };
    expect(
      projectProviderMediaModels(provider, r).imageModels![0],
    ).toMatchObject({ name: 'Corrected', modalities: { output: [] } });
    expect(
      projectProviderMediaModels(provider, r, {
        userMetadata: () => ({ name: 'Mine' }),
      }).imageModels![0].name,
    ).toBe('Mine');
    delete r.models[0].routes[0].forceOverrides;
    expect(projectProviderMediaModels(provider, r).imageModels![0].name).toBe(
      'Live',
    );
    expect(
      projectProviderMediaModels(
        { ...shell, imageModels: [{ id: 'model', name: 'Old' }] },
        r,
      ).imageModels![0].name,
    ).toBe('Entry');
  });

  it('refresh adds new built-in routes but never recreates explicit empty/account-owned members', () => {
    const r = registry('video_generation');
    expect(
      projectProviderMediaModels(shell, r, { addDeclared: true }).videoModels,
    ).toHaveLength(1);
    expect(
      projectProviderMediaModels({ ...shell, videoModels: [] }, r, {
        addDeclared: true,
      }).videoModels,
    ).toEqual([]);
    expect(
      projectProviderMediaModels({ ...shell, source: 'user' }, r, {
        addDeclared: true,
      }).videoModels,
    ).toBeUndefined();
    r.models[0].routes[0].providerId = 'xd';
    expect(
      projectProviderMediaModels({ ...shell, id: 'xd' }, r, {
        addDeclared: true,
      }).videoModels,
    ).toBeUndefined();
  });

  it('does not resurrect registry members excluded by an explicit provider list', () => {
    const r = registry('video_generation');
    const explicit = {
      ...shell,
      videoModels: [{ id: 'replacement', name: 'Replacement' }],
    };
    expect(
      projectProviderMediaModels(explicit, r, { addDeclared: true })
        .videoModels,
    ).toEqual(explicit.videoModels);
  });

  it('retirement removes the route and its stale default without mutating the old snapshot', () => {
    const r = registry('image_generation');
    const provider = {
      ...shell,
      imageModels: [{ id: 'model', name: 'Old' }],
      imageDefaults: { standard: 'model' },
    };
    r.models[0].status = 'retired';
    expect(projectProviderMediaModels(provider, r)).toMatchObject({
      imageModels: [],
    });
    expect(
      projectProviderMediaModels(provider, r).imageDefaults,
    ).toBeUndefined();
    expect(provider.imageModels).toHaveLength(1);
  });

  it.each(['supplier', 'xd', 'private'])(
    'retired exact routes override discovered members for %s',
    (id) => {
      const r = registry('image_generation');
      r.models[0].routes[0].providerId = id;
      r.models[0].status = 'retired';
      const provider: Provider = {
        ...shell,
        id,
        source: id === 'private' ? 'user' : 'builtin',
        imageModels: [
          {
            id: 'model',
            name: 'Still discovered',
            discoveredMetadata: { name: 'Still discovered' },
          },
        ],
        imageDefaults: { standard: 'model' },
      };
      const result = projectProviderMediaModels(provider, r);
      expect(result.imageModels).toEqual([]);
      expect(result.imageDefaults).toBeUndefined();
      // A different provider's tombstone must never retire a user's same-named private model.
      r.models[0].routes[0].providerId = 'unrelated';
      expect(projectProviderMediaModels(provider, r).imageModels).toHaveLength(
        1,
      );
      expect(provider.imageModels).toHaveLength(1);
    },
  );

  it('allows explicit empty capabilities throughout V4 catalog parsing', () => {
    const r = registry('image_generation');
    r.baseModels![0].defaults.modalities = { input: [], output: [] };
    expect(
      parseCatalog({ version: '4', providers: [shell], modelRegistry: r })
        .providers[0].imageModels![0].modalities,
    ).toEqual({ input: [], output: [] });
  });

  it('uses the effective route type and removes obsolete media projections', () => {
    const r = registry('image_generation');
    r.models[0].routes[0].defaults = { mode: 'video_generation' };
    expect(parseModelRegistry(r).ok).toBe(true);
    const provider = projectProviderMediaModels(
      { ...shell, imageModels: [{ id: 'model', name: 'Old' }] },
      r,
      { addDeclared: true },
    );
    expect(provider.imageModels).toEqual([]);
    expect(provider.videoModels![0].mode).toBe('video_generation');
    delete r.baseModels![0].defaults.mode;
    expect(parseModelRegistry(r).ok).toBe(true);
  });

  it('keeps legacy schemas and chat Agent requirements intact', () => {
    for (const mode of ['chat', 'responses', 'unknown'])
      expect(parseModelRegistry(registry(mode)).ok).toBe(false);
    const r = registry('image_generation');
    expect(parseModelRegistry({ ...r, schemaVersion: 3 }).ok).toBe(false);
    expect(
      parseModelRegistry({
        ...r,
        baseModels: [
          {
            ...r.baseModels![0],
            defaults: {
              mode: 'image_generation',
              modalities: { input: ['text'], output: ['image'], secret: 'no' },
            },
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

it.each(modes)('moves existing media membership into the effective %s bucket', (mode) => {
  const original: Provider = {
    ...shell, imageModels: [{ id: 'model', name: 'Image', disabled: true }],
    imageDefaults: { standard: 'model' }, videoModels: [], audioModels: [], embeddingModels: [],
  };
  const r = registry('image_generation');
  const result = projectProviderMediaModels(original, r, { userMetadata: () => ({ mode }) });
  const field = providerMediaField(mode)!;
  expect(result[field]).toEqual([expect.objectContaining({ id: 'model', mode, disabled: true })]);
  if (field !== 'imageModels') {
    expect(result.imageModels).toEqual([]);
    expect(result.imageDefaults).toBeUndefined();
  }
  const back = projectProviderMediaModels(result, r, { userMetadata: () => ({ mode: 'image_generation' }) });
  expect(back.imageModels).toHaveLength(1);
  expect(original.imageModels).toEqual([{ id: 'model', name: 'Image', disabled: true }]);
});
