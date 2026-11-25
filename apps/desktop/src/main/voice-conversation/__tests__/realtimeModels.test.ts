import { expect, it, vi } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  mergeDiscoveredRuntimeModels,
  parseModelsListResponse,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';
import { realtimeCustomVoiceConnection, realtimeModels, resolveRealtimeConnection } from '../realtimeModels.js';
import type { SpeechCatalogDeps } from '../models.js';
import {
  type RealtimeVoiceSelection,
} from '../../../shared/realtimeVoice.js';
import { appendSpeechModels } from '../../../shared/speechProviderSetup.js';
import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import { companionVoicePreference, updateRealtimeVoicePreference } from '../preferences.js';

const selected: RealtimeVoiceSelection = {
  mode: 'realtime',
  providerId: 'byok',
  agent: 'codex',
  modelId: 'qwen-audio-3.0-realtime-plus',
  voice: 'longanqian',
  protocol: 'qwen-audio-realtime',
};
function fixture(
  baseUrl = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: Partial<ProviderRuntimeModelConfig> = {},
) {
  const config = {
    id: 'byok',
    name: 'BYOK',
    runtimes: {
      codex: {
        baseUrl,
        wireProtocol: 'openai-chat' as const,
        models: [{ id: selected.modelId, name: 'Realtime', mode: 'realtime', ...model }],
      },
    },
  };
  const provider = buildUserProvider(config, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
  const deps: SpeechCatalogDeps = {
    catalog: { ...BUNDLED_CATALOG, providers: [provider] },
    gatewayAllowed: false,
    disabled: () => false,
    readKey: vi.fn(() => 'test-only-key'),
    gatewayConnection: () => {
      throw new Error('no_gateway');
    },
  };
  return { config, provider, deps };
}

it.each([
  [
    'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  ],
  [
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  ],
  [
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  ],
])('keeps the credential-owning origin for %s', (base, expected) => {
  const { deps } = fixture(base);
  const resolved = resolveRealtimeConnection(deps, { ...selected, protocol: 'openai-realtime' });
  expect(resolved).toEqual({
    protocol: 'qwen-audio-realtime',
    url: `${expected}?model=${selected.modelId}`,
    headers: { authorization: 'Bearer test-only-key' },
  });
  expect(deps.readKey).toHaveBeenCalledWith('byok', 'codex');
  expect(JSON.stringify(realtimeModels(deps))).not.toContain('test-only-key');
});

it('limits private voice discovery to the original official ordinary API connection', () => {
  const route = { ...selected, modelId: 'qwen-audio-3.1-realtime-flash' };
  const base = 'https://workspace.ap-southeast-1.maas.aliyuncs.com';
  const { deps } = fixture(base, { id: route.modelId });
  const model = realtimeModels(deps)[0];
  expect(model.hasCustomVoiceCatalog).toBe(true);
  expect(model.systemVoices).toHaveLength(71);
  expect(model.systemVoices?.some(v => v.id === 'yuxiaoyun_v3.1')).toBe(false);
  expect(realtimeCustomVoiceConnection(deps, route)).toMatchObject({ baseUrl: base + '/api/v1' });
  for (const origin of ['https://token-plan.cn-beijing.maas.aliyuncs.com', 'https://proxy.test']) {
    expect(() => realtimeCustomVoiceConnection(fixture(origin).deps, selected)).toThrow();
  }
});

it('admits OpenAI API keys but never subscription credentials', () => {
  const { deps, provider } = fixture('https://api.openai.com/v1', { id: 'gpt-realtime-2' });
  expect(resolveRealtimeConnection(deps, { ...selected, modelId: 'gpt-realtime-2' }).url).toBe(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-2',
  );
  provider.auth = { method: 'oauth', native: 'codex' };
  expect(realtimeModels(deps)).toEqual([]);
});

it('requires known native protocols or an explicit audio-in/audio-out compatible route', () => {
  const { deps, provider } = fixture('https://proxy.example/custom', { id: 'my-model' });
  expect(realtimeModels(deps)).toEqual([]);
  provider.audioModels![0].modalities = { input: ['audio'], output: ['audio'] };
  expect(realtimeModels(deps)[0].protocolLocked).toBe(false);
  expect(
    resolveRealtimeConnection(deps, {
      ...selected,
      modelId: 'my-model',
      protocol: 'openai-realtime',
    }).url,
  ).toBe('wss://proxy.example/custom/realtime?model=my-model');
  provider.audioModels![0].modalities.output = ['text'];
  expect(realtimeModels(deps)).toEqual([]);
});

it.each([
  'https://coding.dashscope.aliyuncs.com/v1',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
])('does not turn %s into a verified realtime route', (base) =>
  expect(realtimeModels(fixture(base).deps)).toEqual([]),
);

it('rejects cross-origin model overrides and retains hidden saved routes', () => {
  const { deps, provider } = fixture();
  provider.audioModels![0].defaultEnabled = false;
  expect(realtimeModels(deps)[0].pickerVisible).toBe(false);
  expect(resolveRealtimeConnection(deps, selected)).toBeTruthy();
  provider.models.codex![0].route = {
    baseUrl: 'https://other.example/v1',
    wireProtocol: 'openai-chat',
  };
  expect(realtimeModels(deps)).toEqual([]);
});

it.each([
  {
    baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    returned: ['qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash',
      'qwen-audio-3.1-realtime-plus', 'qwen-audio-3.1-realtime-flash', 'qwen3-tts-flash-realtime'],
    visible: ['qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash',
      'qwen-audio-3.1-realtime-plus', 'qwen-audio-3.1-realtime-flash'],
  },
  {
    baseUrl: 'https://api.openai.com/v1',
    returned: ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1', 'gpt-realtime-2',
      'gpt-realtime-mini-2025-12-15', 'gpt-realtime-whisper', 'gpt-realtime-translate', 'gpt-4o-mini-tts'],
    visible: ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1', 'gpt-realtime-2', 'gpt-realtime-mini-2025-12-15'],
  },
])('projects ID-only discovery at $baseUrl into selectable speech-to-speech routes', ({ baseUrl, returned, visible }) => {
  const registry = BUNDLED_CATALOG.modelRegistry;
  const discovered = parseModelsListResponse({ data: returned.map(id => ({ id })) })!;
  const models = mergeDiscoveredRuntimeModels([], discovered);
  const { config, deps } = fixture(baseUrl);
  const provider = buildUserProvider({ ...config, runtimes: {
    codex: { ...config.runtimes.codex, models },
  } }, { modelRegistry: registry });
  deps.catalog = { ...BUNDLED_CATALOG, providers: [provider] };
  expect(models.every(model => !model.mode && !model.discoveredMetadata?.mode)).toBe(true);
  const options = realtimeModels(deps).filter(model => model.pickerVisible);
  expect(options.map(model => model.id).sort()).toEqual([...visible].sort());
  for (const option of options) {
    const route = resolveRealtimeConnection(deps, { ...selected, modelId: option.id, protocol: option.protocol! });
    expect(new URL(route.url).searchParams.get('model')).toBe(option.id);
  }
});

it.each(['gpt-realtime-translate', 'gpt-realtime-whisper'])('keeps %s off the conversational OpenAI transport even with explicit audio metadata', id => {
  const { deps } = fixture('https://api.openai.com/v1', {
    id, mode: 'realtime', modalities: { input: ['audio'], output: ['audio'] },
  });
  expect(realtimeModels(deps)).toEqual([]);
});

it('appends a discovered realtime model without changing existing model choices', () => {
  const { config } = fixture();
  const reference = { id: 'qwen-audio-3.1-realtime-plus', name: 'Qwen Audio' };
  const request = {
    ...config,
    runtimes: { codex: { ...config.runtimes.codex, models: [reference] } },
  };
  const merged = appendSpeechModels(config, request, [], 'realtime');
  expect(merged.runtimes.codex!.models).toEqual([...config.runtimes.codex.models, reference]);
  expect(config.runtimes.codex.models).toHaveLength(1);
  expect(() => appendSpeechModels(config, request)).toThrow('speech_model_required');
});

it('keeps realtime and TTS preferences independent across reload and reset', () => {
  let settings = normalizeVoiceInputSettings({
    conversationSelections: { buddy: { modelId: 'tts', voice: 'alloy' } },
  });
  Object.assign(settings, updateRealtimeVoicePreference(settings, 'buddy', selected));
  settings = normalizeVoiceInputSettings(JSON.parse(JSON.stringify(settings)));
  expect(companionVoicePreference(settings, 'buddy').realtimeSelection).toEqual(selected);
  expect(companionVoicePreference(settings, 'buddy').selection).toEqual({
    modelId: 'tts',
    voice: 'alloy',
  });
  Object.assign(settings, updateRealtimeVoicePreference(settings, 'buddy', null));
  settings = normalizeVoiceInputSettings(JSON.parse(JSON.stringify(settings)));
  expect(companionVoicePreference(settings, 'buddy').previousRealtimeSelection).toEqual(selected);
  expect(companionVoicePreference(settings, 'buddy').realtimeSelection).toBeUndefined();
  expect(companionVoicePreference(settings, 'buddy').selection?.modelId).toBe('tts');
});

it('offers GLM Flash only from ordinary China API discovery and binds the model at handshake', () => {
  const base = 'https://open.bigmodel.cn/api/paas/v4';
  const id = 'glm-realtime-flash';
  const response = { data: [{ id }, { id: 'glm-realtime-air' }, { id: 'glm-5' }] };
  const discovered = parseModelsListResponse(response, base + '/models')!;
  const models = mergeDiscoveredRuntimeModels([], discovered);
  const { deps, config } = fixture(base);
  const provider = buildUserProvider({ ...config, runtimes: {
    codex: { ...config.runtimes.codex, models, catalogPresetId: 'zhipu-glm-cn' },
  } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
  deps.catalog = { ...deps.catalog, providers: [provider] };
  expect(realtimeModels(deps)).toMatchObject([{ id, protocol: 'glm-realtime', protocolLocked: true }]);
  expect(resolveRealtimeConnection(deps, { ...selected, modelId: id })).toEqual({
    protocol: 'glm-realtime', url: 'wss://open.bigmodel.cn/api/paas/v4/realtime',
    headers: { authorization: 'Bearer test-only-key' },
  });
  expect(realtimeModels(fixture(base, { id }).deps)).toEqual([]);
  for (const wrong of ['https://proxy.example', 'https://open.bigmodel.cn/api/coding/paas/v4']) {
    expect(parseModelsListResponse(response, wrong + '/models')![0].discoveredMetadata?.mode).toBeUndefined();
    expect(() => resolveRealtimeConnection(fixture(wrong, models[0]).deps,
      { ...selected, modelId: id, protocol: 'glm-realtime' })).toThrow();
  }
  expect(parseModelsListResponse({ data: [{ id, mode: 'chat' }] }, base + '/models')![0].discoveredMetadata?.mode).toBe('chat');
  const configured = provider.models.codex!.find(m => m.id === id)!;
  configured.catalogPresetId = 'zhipu-coding-plan-cn';
  expect(realtimeModels(deps)).toEqual([]);
});

it('keeps Flash on a runtime whose own key was confirmed when another chat route lost access', () => {
  const id = 'glm-realtime-flash';
  const api = 'https://open.bigmodel.cn/api/paas/v4';
  const { config, deps } = fixture(api);
  const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [{ id }] }, api + '/models')!);
  const preset = { catalogPresetId: 'zhipu-glm-cn' };
  deps.catalog = { ...deps.catalog, providers: [buildUserProvider({ ...config, runtimes: {
    'claude-code': { ...preset, baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: [{ id, name: id, discoveredMetadata: { mode: 'realtime' } }] },
    codex: { ...preset, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models },
  } })] };
  expect(realtimeModels(deps)).toMatchObject([{ id, agent: 'codex', protocol: 'glm-realtime' }]);
  expect(resolveRealtimeConnection(deps, { ...selected, modelId: id }).url).toBe('wss://open.bigmodel.cn/api/paas/v4/realtime');
  expect(() => resolveRealtimeConnection(deps, { ...selected, agent: 'claude-code', modelId: id })).toThrow('realtime_model_unavailable');
});
