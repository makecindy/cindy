import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import { isAgentSelectableModel } from '../classification.js';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels, pickModelMetadata, validModelMetadata } from '../modelMetadataLayers.js';
import { resolveCatalogModelNativeApi, resolveModelNativeApi } from '../modelRegistry.js';
import { projectProviderMediaModels } from '../providerMediaModels.js';
import { buildUserProvider } from '../user-provider.js';
import type { ModelRegistry } from '../modelAccessBean.js';
import type { ProviderRuntimeModelConfig } from '../types.js';

const registry = BUNDLED_CATALOG.modelRegistry!;
function provider(models: ProviderRuntimeModelConfig[], id = 'speech-account') {
  return buildUserProvider({ id, name: id, runtimes: {
    codex: { baseUrl: 'https://speech.example.test/v1', wireProtocol: 'openai-chat', models },
  } }, { modelRegistry: registry });
}

describe('BYOK speech discovery and projection', () => {
  it.each([
    [null, undefined, null],
    ['openai-completions', undefined, 'openai-completions'],
    [undefined, undefined, 'openai-audio-speech'],
    [null, 'openai-audio-speech', 'openai-audio-speech'],
    ['openai-audio-speech', null, null],
  ] as const)('preserves media protocol precedence through projection: declaration %s, user %s',
    (declaration, override, expected) => {
      for (const providerId of ['speech-account', 'xd']) {
        const activeRegistry: ModelRegistry = {
          schemaVersion: 5, updatedAt: '2026-10-12T06:00:00.000Z',
          baseModels: [{ id: 'new-voice', aliases: [], defaults: { mode: 'audio_speech' } }],
          models: [{ id: 'new-voice', name: 'Voice', modelRef: 'new-voice', nativeApi: declaration,
            routes: [{ providerId, modelId: 'new-voice', agents: [] }] }],
        };
        const model: ProviderRuntimeModelConfig = { id: 'new-voice', name: 'Voice',
          discoveredMetadata: { mode: 'audio_speech', nativeApi: 'openai-audio-speech' },
          ...(override !== undefined ? { nativeApi: override } : {}),
        };
        const p = buildUserProvider({ id: 'speech-account', name: 'Speech', runtimes: {
          codex: { baseUrl: 'https://speech.example.test/v1', wireProtocol: 'openai-chat', models: [model] },
        } }, { modelRegistry: activeRegistry });
        expect(p.models.codex![0].nativeApi).toBe(expected);
        expect(projectProviderMediaModels(p, activeRegistry).audioModels?.[0].nativeApi).toBe(expected);
        expect(p.models.codex![0].userModelConfig).toEqual(model);
      }
    });

  it.each(['nativeApi', 'native_api'])('retains explicit speech metadata from %s through refresh and catalog parsing', key => {
    const discovered = parseModelsListResponse({ data: [{ id: 'custom-voice',
      name: 'Custom Voice', mode: 'audio_speech', [key]: 'openai-audio-speech',
    }] })!;
    expect(discovered[0].discoveredMetadata).toMatchObject({ mode: 'audio_speech', nativeApi: 'openai-audio-speech' });
    const models = mergeDiscoveredRuntimeModels([], discovered);
    const p = provider(mergeDiscoveredRuntimeModels(models, [{ id: 'custom-voice', name: 'Custom Voice' }]));
    expect(p.audioModels).toEqual([expect.objectContaining({ id: 'custom-voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech', sourceAgent: 'codex' })]);
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    expect(parseCatalog({ ...BUNDLED_CATALOG, providers: [p] }).providers[0].audioModels).toEqual(p.audioModels);
  });

  it('accepts model_id without inferring a capability or protocol from a vendor name', () => {
    const result = parseModelsListResponse({ models: [
      { model_id: 'voice-v1', name: 'Voice', model_info: { mode: 'audio_speech' } },
      { model_id: 'private-tts-v1', name: 'Unknown model' },
    ] })!;
    expect(result.map(m => m.id)).toEqual(['voice-v1', 'private-tts-v1']);
    const p = provider(mergeDiscoveredRuntimeModels([], result));
    expect(p.audioModels?.map(m => m.id)).toEqual(['voice-v1']);
    expect(p.audioModels?.[0].nativeApi).toBeUndefined();
    expect(isAgentSelectableModel(p.models.codex![1], { userProvider: true })).toBe(true);
  });

  it('uses exact public identity for ID-only discovery without inventing account members or a speech protocol', () => {
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [
      { id: 'gpt-4o-mini-tts' }, { id: 'gpt-6-astra' },
    ] })!);
    const p = provider(models);
    expect(p.audioModels?.map(m => m.id)).toEqual(['gpt-4o-mini-tts']);
    expect(p.audioModels?.[0].nativeApi).toBeUndefined();
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    expect(isAgentSelectableModel(p.models.codex![1], { userProvider: true })).toBe(true);
    expect(p.models.codex![1].nativeApi).toBe('openai-responses');
    expect(provider([]).audioModels).toBeUndefined();
  });

  it('projects public speech IDs and aliases through discovery without changing their wire identity', () => {
    const ids = registry.baseModels!.filter(model => model.defaults.mode === 'audio_speech')
      .flatMap(model => [model.id, ...model.aliases]);
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({
      data: ids.map(id => ({ id })),
    })!);
    const p = provider(models);
    expect(p.audioModels?.map(model => model.id)).toEqual(ids);
    for (const model of p.models.codex!) {
      expect(model.mode).toBe('audio_speech');
      expect(model.modalities).toEqual({ input: ['text'], output: ['audio'] });
      expect(model.nativeApi).toBeUndefined();
      expect(isAgentSelectableModel(model, { userProvider: true })).toBe(false);
    }
    expect(provider([]).audioModels).toBeUndefined();
  });

  it('preserves manual type, name and visibility overrides across conflicting discovery', () => {
    const original: ProviderRuntimeModelConfig[] = [{ id: 'gpt-private', name: 'My Voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech', defaultEnabled: false }];
    const merged = mergeDiscoveredRuntimeModels(original, parseModelsListResponse({ data: [
      { id: 'gpt-private', name: 'Upstream', mode: 'chat', nativeApi: 'openai-responses' },
    ] })!);
    expect(merged[0]).toMatchObject(original[0]);
    const p = provider(merged);
    expect(p.audioModels?.[0]).toMatchObject({ id: 'gpt-private', name: 'My Voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech' });
    expect(p.models.codex![0].defaultEnabled).toBe(false);
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    const inherited = provider([{ ...merged[0], mode: undefined, nativeApi: undefined }]);
    expect(inherited.audioModels).toBeUndefined();
    expect(inherited.models.codex![0].mode).toBe('chat');
  });

  it('keeps same-ID models scoped to each connection', () => {
    const speech = provider([{ id: 'same-id', name: 'Speech', mode: 'audio_speech' }], 'speech');
    const chat = provider([{ id: 'same-id', name: 'Chat', mode: 'chat' }], 'chat');
    expect(speech.id).not.toBe(chat.id);
    expect(speech.audioModels?.[0].name).toBe('Speech');
    expect(chat.audioModels).toBeUndefined();
    expect(chat.models.codex![0].mode).toBe('chat');
  });
});

describe('ElevenLabs speech capability discovery', () => {
  const modelId = 'eleven_multilingual_v2';
  const response = (fields: Record<string, unknown> = {}) => [{ model_id: modelId, name: 'Eleven Multilingual v2', ...fields }];

  it('projects the explicit TTS capability into audioModels, including through compatible relays', () => {
    const discovered = parseModelsListResponse(response({ can_do_text_to_speech: true }),
      'https://speech-relay.example.test/v1/models')!;
    expect(discovered[0]).toMatchObject({ id: modelId,
      discoveredMetadata: { name: 'Eleven Multilingual v2', mode: 'audio_speech' } });
    const p = provider(mergeDiscoveredRuntimeModels([], discovered));
    expect(p.audioModels).toEqual([expect.objectContaining({ id: modelId, mode: 'audio_speech' })]);
    expect(p.audioModels?.[0].nativeApi).toBeUndefined();
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
  });

  it.each([
    { value: false, mode: 'other' },
    { value: undefined, mode: undefined },
    { value: 'true', mode: undefined },
  ])('keeps explicit capability $value separate from public Registry defaults', ({ value, mode }) => {
    const discovered = parseModelsListResponse(response({ can_do_text_to_speech: value }))!;
    expect(discovered[0].discoveredMetadata?.mode).toBe(mode);
    const p = provider(mergeDiscoveredRuntimeModels([], discovered));
    if (value === false) {
      expect(p.audioModels).toBeUndefined();
      expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    } else {
      // Missing/invalid capability is not a denial: this exact official ID now has
      // a public TTS declaration, while the raw discovery still has no mode.
      expect(p.audioModels?.[0]).toMatchObject({ id: modelId, mode: 'audio_speech' });
    }
  });

  it.each([
    { fields: { mode: 'chat' }, mode: 'chat' },
    { fields: { model_info: { mode: 'audio_transcription' } }, mode: 'audio_transcription' },
  ])('keeps explicit $mode ahead of the vendor capability', ({ fields, mode }) => {
    const discovered = parseModelsListResponse(response({ can_do_text_to_speech: true, ...fields }))!;
    expect(discovered[0].discoveredMetadata?.mode).toBe(mode);
  });

  it('does not apply the vendor capability without a matching model_id', () => {
    const discovered = parseModelsListResponse([
      { id: 'chat-one', can_do_text_to_speech: true },
      { id: 'chat-two', model_id: modelId, can_do_text_to_speech: false },
    ])!;
    const p = provider(mergeDiscoveredRuntimeModels([], discovered));
    expect(p.audioModels).toBeUndefined();
    for (const model of p.models.codex!) {
      expect(model.mode).toBeUndefined();
      expect(isAgentSelectableModel(model, { userProvider: true })).toBe(true);
    }
  });

  it('refreshes true to false, keeps sparse snapshots, and preserves user overrides', () => {
    const tts = parseModelsListResponse(response({ can_do_text_to_speech: true }))!;
    const noTts = parseModelsListResponse(response({ can_do_text_to_speech: false }))!;
    const sparse = parseModelsListResponse(response())!;
    const models = mergeDiscoveredRuntimeModels([], tts);
    expect(provider(mergeDiscoveredRuntimeModels(models, sparse)).audioModels?.[0].mode).toBe('audio_speech');
    const refreshed = mergeDiscoveredRuntimeModels(models, noTts);
    const p = provider(refreshed);
    expect(p.audioModels).toBeUndefined();
    expect(p.models.codex![0].mode).toBe('other');
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    expect(provider(mergeDiscoveredRuntimeModels(refreshed, sparse)).models.codex![0].mode).toBe('other');
    expect(provider(mergeDiscoveredRuntimeModels(refreshed, tts)).audioModels?.[0].mode).toBe('audio_speech');

    const manual = mergeDiscoveredRuntimeModels([{ ...models[0], name: 'My voice',
      mode: 'audio_speech', defaultEnabled: false }], noTts);
    expect(manual[0]).toMatchObject({ name: 'My voice', mode: 'audio_speech', defaultEnabled: false,
      discoveredMetadata: { mode: 'other' } });
    expect(provider(manual).audioModels?.[0].mode).toBe('audio_speech');
    expect(provider([{ ...manual[0], mode: undefined }]).audioModels).toBeUndefined();
  });
});

describe('media native API metadata', () => {
  it('preserves known media protocols and explicit unknown, and rejects arbitrary protocols', () => {
    expect(validModelMetadata({ nativeApi: 'openai-audio-speech' })).toBe(true);
    expect(pickModelMetadata({ nativeApi: null })).toEqual({ nativeApi: null });
    expect(pickModelMetadata({ nativeApi: 'unimplemented-vendor-protocol' })).toEqual({});
  });

  it.each(['gpt-4o-mini-tts', 'openai/gpt-4o-mini-tts'])(
    'does not assign a chat family protocol to the public speech model %s', id => {
      expect(resolveCatalogModelNativeApi(registry, id)).toBeUndefined();
      expect(resolveModelNativeApi(registry, 'xd', id)).toBeUndefined();
    },
  );

  it('uses explicit media mode ahead of chat prefix rules, keeping exact declarations authoritative', () => {
    const r: ModelRegistry = { schemaVersion: 4, updatedAt: '2026-10-12T00:00:00.000Z', models: [],
      nativeApiRules: [{ providerId: 'xd', modelIdPrefix: 'gpt-', nativeApi: 'openai-responses' }] };
    expect(resolveCatalogModelNativeApi(r, 'gpt-private', 'audio_speech')).toBeUndefined();
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private', 'audio_speech')).toBeUndefined();
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private', 'chat')).toBe('openai-responses');
    r.models.push({ id: 'gpt-private', name: 'Speech', mode: 'audio_speech', nativeApi: 'openai-audio-speech',
      routes: [{ providerId: 'xd', modelId: 'gpt-private', agents: [] }] });
    expect(resolveCatalogModelNativeApi(r, 'gpt-private')).toBe('openai-audio-speech');
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private')).toBe('openai-audio-speech');
    r.models[0].nativeApi = null;
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private')).toBeNull();
  });

  it('honors a catalog entry type even when it has no Gateway route or public base model', () => {
    const r: ModelRegistry = { schemaVersion: 4, updatedAt: '2026-10-12T00:00:00.000Z',
      models: [{ id: 'gpt-private-voice', name: 'Speech', mode: 'audio_speech', routes: [] }],
      nativeApiRules: [{ providerId: 'xd', modelIdPrefix: 'openai/gpt-', nativeApi: 'openai-responses' }],
    };
    expect(resolveCatalogModelNativeApi(r, 'gpt-private-voice')).toBeUndefined();
    expect(resolveCatalogModelNativeApi(r, 'gpt-private-chat')).toBe('openai-responses');
  });
});
