import { expect, it, vi } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type Catalog,
  type ProviderMediaModel,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';
import { resolveSpeechConnection, speechModels, type SpeechCatalogDeps } from '../models.js';
import { speechRequest } from '../speechProtocols.js';
import { loadSpeechVoices } from '../voices.js';
import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import { voiceModelKey } from '../../../shared/voiceConversation.js';

const model = (id: string, extra: Partial<ProviderMediaModel> = {}): ProviderMediaModel => ({
  id,
  name: id,
  mode: 'audio_speech',
  availability: 'available',
  ...extra,
});
function deps(providers: Catalog['providers']): SpeechCatalogDeps {
  return {
    catalog: { ...BUNDLED_CATALOG, providers },
    gatewayAllowed: true,
    disabled: () => false,
    gatewayConnection: () => ({ baseUrl: 'https://gateway.test/v1', apiKey: 'gateway-key' }),
    readKey: vi.fn((id, agent) => `${id}-${agent}-key`),
  };
}
function custom(
  id: string,
  baseUrl: string,
  models: ProviderRuntimeModelConfig[] = [
    { id: 'tts', name: 'Speech', mode: 'audio_speech', nativeApi: 'openai-audio-speech' },
  ],
) {
  return buildUserProvider(
    { id, name: id, runtimes: { codex: { baseUrl, wireProtocol: 'openai-chat', models } } },
    { modelRegistry: BUNDLED_CATALOG.modelRegistry },
  );
}

// PR #6768 unit regression: speechModels must honor the wizard's saved deselection
// and later Settings switches. Existing route tests only covered the disable gate.
// Minimal input: two discovered TTS models, one unchecked, on two separate connections.
it('lists only selected speech models and applies connection-scoped display overrides', () => {
  const models: ProviderRuntimeModelConfig[] = [
    { id: 'eleven_flash_v2_5', name: 'Flash', discoveredMetadata: { mode: 'audio_speech' } },
    { id: 'eleven_v3', name: 'V3', discoveredMetadata: { mode: 'audio_speech' }, defaultEnabled: false },
  ];
  const d = deps([
    custom('a', 'https://api.elevenlabs.io/v1', models),
    custom('b', 'https://api.elevenlabs.io/v1', models),
  ]);
  const choices = () => speechModels(d).filter((item) => item.pickerVisible !== false).map((item) => [item.providerId, item.id]);
  expect(choices()).toEqual([['a', 'eleven_flash_v2_5'], ['b', 'eleven_flash_v2_5']]);
  d.visibilityOverride = (agent, provider, id) => agent === 'codex' && provider === 'a'
    ? id === 'eleven_v3' : undefined;
  expect(choices()).toEqual([['a', 'eleven_v3'], ['b', 'eleven_flash_v2_5']]);
  d.disabled = (provider, id) => provider === 'a' && id === 'eleven_v3';
  expect(choices()).toEqual([['b', 'eleven_flash_v2_5']]);
  // Hiding remains a display preference, not a replacement for route admission.
  expect(resolveSpeechConnection(d, { providerId: 'a', agent: 'codex', modelId: 'eleven_flash_v2_5' }).protocol).toBe('elevenlabs');
  d.visibilityOverride = () => undefined;
  expect(choices()).toEqual([['a', 'eleven_flash_v2_5'], ['b', 'eleven_flash_v2_5']]);
});

// Protocol authority comes from the real endpoint, not the UI's override.
it('rejects unsupported speed on an official binding before opening a call', () => {
  const d = deps([
    custom('eleven', 'https://api.elevenlabs.io/v1', [
      { id: 'eleven_flash_v2_5', name: 'Flash', mode: 'audio_speech' },
      { id: 'eleven_v3', name: 'V3', mode: 'audio_speech' },
    ]),
  ]);
  const choice = {
    providerId: 'eleven',
    agent: 'codex' as const,
    modelId: 'eleven_flash_v2_5',
    voice: 'voice',
    protocol: 'openai' as const,
  };
  expect(resolveSpeechConnection(d, { ...choice, speed: 1.2 }).protocol).toBe('elevenlabs');
  expect(() => resolveSpeechConnection(d, { ...choice, speed: 1.5 })).toThrow(
    'invalid_speech_speed',
  );
  expect(() => resolveSpeechConnection(d, { ...choice, modelId: 'eleven_v3', speed: 1 })).toThrow(
    'invalid_speech_speed',
  );
  expect(resolveSpeechConnection(d, { ...choice, modelId: 'eleven_v3' }).protocol).toBe(
    'elevenlabs',
  );
});

// Unit regression: the real Gateway Qwen route rejects OpenAI's wider speed
// range. Exercise admission and request serialization at the verified boundaries.
it('uses Qwen Audio 3.1 Plus speed limits on the OpenAI-compatible Gateway', () => {
  const modelId = 'qwen/qwen-audio-3.1-tts-plus';
  const d = deps([{ id: 'xd', audioModels: [model(modelId)] }] as Catalog['providers']);
  const choice = { providerId: 'xd', modelId, voice: 'longanlingxin_v3.1' };
  for (const speed of [0.5, 2]) {
    const selected = { ...choice, speed };
    const connection = resolveSpeechConnection(d, selected);
    expect(connection.protocol).toBe('openai');
    expect(JSON.parse(speechRequest(connection, { ...selected, text: 'hello' }).body)).toMatchObject({
      model: modelId,
      speed,
      response_format: 'pcm',
    });
  }
  for (const speed of [0.25, 4]) {
    expect(() => resolveSpeechConnection(d, { ...choice, speed })).toThrow('invalid_speech_speed');
  }
});

it('keeps Gateway entitlement and supported-protocol gates', () => {
  const d = deps([
    {
      id: 'xd',
      audioModels: [
        model('new-speech'),
        model('paid', { availability: 'requires_payment' }),
        model('registry-only', { availability: undefined }),
        model('disabled', { disabled: true }),
        model('override'),
        model('asr', { mode: 'audio_transcription' }),
        model('wrong', { nativeApi: 'openai-responses' }),
        model('unverified', { nativeApi: null }),
      ],
    },
  ] as Catalog['providers']);
  d.disabled = (provider, id) => provider === 'xd' && id === 'override';
  expect(speechModels(d).map((m) => m.id)).toEqual(['new-speech']);
  expect(speechModels({ ...d, gatewayAllowed: false })).toEqual([]);
});

// Unit: a new Gateway selection needs a usable reference default, while a saved
// manual ID remains the request value. Qwen 3.1 Plus was advertised as audio_speech
// but its chat-family rule excluded it; the earlier vendor cases missed this route.
it.each([
  'elevenlabs/eleven_multilingual_v2',
  'minimax/speech-2.8-hd',
  'qwen/qwen-audio-3.1-tts-plus',
])(
  'uses the reference default without restricting manual voices for %s',
  async (modelId) => {
    const d = deps([{ id: 'xd', audioModels: [model(modelId)] }] as Catalog['providers']);
    const selected = speechModels(d)[0];
    expect(selected.defaultVoice).not.toBe('');
    const choice = { providerId: 'xd', modelId, voice: 'saved-manual-voice' };
    const connection = resolveSpeechConnection(d, choice);
    const fetcher = vi.fn();
    const catalog = await loadSpeechVoices(connection, modelId, fetcher, () => {}, 'xd');
    expect(catalog.voices[0]?.id).toBe(selected.defaultVoice);
    expect(JSON.parse(speechRequest(connection, { ...choice, text: 'hello' }).body)).toMatchObject({
      model: modelId,
      voice: choice.voice,
      response_format: 'pcm',
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

// Unit regression: both Registry layers must receive the discovered media mode.
// Without it, a previously unknown Qwen TTS ID inherits the bundled chat prefix.
// Exact declarations (including null) remain authoritative over the mode hint.
it.each(['current', 'bundled'] as const)(
  'keeps Gateway speech mode when resolving %s Registry protocols',
  (layer) => {
    const modelId = 'qwen/qwen-audio-3.1-tts-plus';
    const media = model(modelId);
    const d = deps([{ id: 'xd', audioModels: [media] }] as Catalog['providers']);
    if (layer === 'bundled') d.catalog.modelRegistry = undefined;
    expect(speechModels(d)).toMatchObject([{ id: modelId, protocol: 'openai' }]);
    const selected = { providerId: 'xd', modelId, voice: 'longanlingxin_v3.1' };
    expect(resolveSpeechConnection(d, selected).protocol).toBe('openai');
    for (const nativeApi of [null, 'openai-completions'] as const) {
      media.nativeApi = nativeApi;
      expect(speechModels(d)).toEqual([]);
      expect(() => resolveSpeechConnection(d, selected)).toThrow('model_unavailable');
    }
  },
);

// Unit regression: resolveSpeechConnection -> speechRequest must send Gateway TTS
// to /v1/audio/speech. Live root endpoints returned 404; previous fixtures already
// included /v1. Cover the root, existing API base and deployment prefix without I/O.
it.each([
  ['https://gateway.test', 'https://gateway.test/v1/audio/speech'],
  ['https://gateway.test/', 'https://gateway.test/v1/audio/speech'],
  ['https://gateway.test/v1', 'https://gateway.test/v1/audio/speech'],
  ['https://gateway.test/v1/', 'https://gateway.test/v1/audio/speech'],
  ['https://gateway.test/prefix/', 'https://gateway.test/prefix/v1/audio/speech'],
  ['https://gateway.test/prefix/v1/', 'https://gateway.test/prefix/v1/audio/speech'],
])('uses the Gateway speech API path for %s', (baseUrl, expectedUrl) => {
  const credentials = { baseUrl, apiKey: 'gateway-key' };
  const d = deps([
    { id: 'xd', audioModels: [model('gateway-speech', { nativeApi: 'openai-audio-speech' })] },
  ] as Catalog['providers']);
  d.gatewayConnection = () => credentials;
  const input = { modelId: 'gateway-speech', voice: 'voice-id', text: 'hello' };
  const connection = resolveSpeechConnection(d, input);
  const request = speechRequest(connection, input);
  expect(request.url.href).toBe(expectedUrl);
  expect(JSON.parse(request.body)).toEqual({
    model: input.modelId,
    voice: input.voice,
    input: input.text,
    response_format: 'pcm',
  });
  expect(connection.headers).toEqual({ authorization: 'Bearer gateway-key' });
  // The shared server credential endpoint must remain unchanged for chat/media callers.
  expect(credentials).toEqual({ baseUrl, apiKey: 'gateway-key' });
});

it('keeps a BYOK speech API prefix without adding the Gateway version path', () => {
  const d = deps([custom('proxy', 'https://speech-proxy.test/tts-api')]);
  const input = { modelId: 'tts', voice: 'voice-id', text: 'hello' };
  const connection = resolveSpeechConnection(d, { ...input, providerId: 'proxy', agent: 'codex' });
  expect(speechRequest(connection, input).url.href).toBe(
    'https://speech-proxy.test/tts-api/audio/speech',
  );
});

it('distinguishes two user connections with the same upstream ID and uses only the selected runtime key', () => {
  const d = deps([custom('a', 'https://a.test/prefix/v1'), custom('b', 'https://b.test/v1')]);
  const models = speechModels({ ...d, gatewayAllowed: false });
  expect(models).toHaveLength(2);
  expect(voiceModelKey(models[0])).not.toBe(voiceModelKey(models[1]));
  expect(JSON.stringify(models)).not.toContain('-key');
  vi.mocked(d.readKey).mockClear();
  const connection = resolveSpeechConnection(d, {
    providerId: 'b',
    agent: 'codex',
    modelId: 'tts',
    voice: 'alloy',
  });
  expect(d.readKey).toHaveBeenCalledExactlyOnceWith('b', 'codex');
  expect(connection).toEqual({
    baseUrl: 'https://b.test/v1',
    protocol: 'openai',
    headers: { authorization: 'Bearer b-codex-key' },
  });
  expect(() => resolveSpeechConnection(d, { modelId: 'tts', voice: 'alloy' })).toThrow(
    'model_unavailable',
  );
  expect(() =>
    resolveSpeechConnection(d, { providerId: 'b', agent: 'pi', modelId: 'tts', voice: 'alloy' }),
  ).toThrow('model_unavailable');
});

it('supports documented native endpoints without guessing protocols from model IDs or chat wire', () => {
  const tts: ProviderRuntimeModelConfig[] = [
    { id: 'private-voice', name: 'Voice', discoveredMetadata: { mode: 'audio_speech' } },
  ];
  const d = deps([
    custom('eleven', 'https://api.elevenlabs.io/v1', tts),
    custom('mini', 'https://api.minimax.io/anthropic', tts),
    custom('openai', 'https://api.openai.com/v1', tts),
    custom('unknown', 'https://proxy.test/v1', tts),
    custom('chat', 'https://api.elevenlabs.io/v1', [{ id: 'chat', name: 'Chat' }]),
  ]);
  expect(speechModels(d).map((m) => m.protocol)).toEqual([
    'elevenlabs',
    'minimax',
    'openai',
    undefined,
  ]);
  expect(
    resolveSpeechConnection(d, {
      providerId: 'eleven',
      agent: 'codex',
      modelId: 'private-voice',
      voice: 'voice',
    }).headers,
  ).toEqual({ 'xi-api-key': 'eleven-codex-key' });
  expect(
    resolveSpeechConnection(d, {
      providerId: 'mini',
      agent: 'codex',
      modelId: 'private-voice',
      voice: 'voice',
    }).baseUrl,
  ).toBe('https://api.minimax.io/v1');
});

it('requires an explicit choice for null protocols and excludes unusable credentials/routes', () => {
  const provider = custom('p', 'https://proxy.test/v1', [
    { id: 'voice', name: 'Voice', mode: 'audio_speech', nativeApi: null },
  ]);
  const d = deps([provider]);
  expect(speechModels(d)[0].protocol).toBeUndefined();
  expect(speechModels(d)[0].protocolLocked).toBe(false);
  const selected = { providerId: 'p', agent: 'codex' as const, modelId: 'voice', voice: 'v' };
  expect(() => resolveSpeechConnection(d, selected)).toThrow('model_unavailable');
  expect(resolveSpeechConnection(d, { ...selected, protocol: 'elevenlabs' }).protocol).toBe(
    'elevenlabs',
  );
  const p = custom('p', 'https://proxy.test/v1');
  d.catalog.providers = [p];
  expect(speechModels({ ...d, readKey: () => null })).toEqual([]);
  expect(speechModels({ ...d, disabled: () => true })).toEqual([]);
  p.routing.codex!.disabled = true;
  expect(speechModels(d)).toEqual([]);
  p.routing.codex!.disabled = false;
  p.auth.native = 'codex';
  expect(speechModels(d)).toEqual([]);
});

it.each([
  ['https://api.elevenlabs.io/v1', 'elevenlabs', 'openai'],
  ['https://api.minimax.io/anthropic', 'minimax', 'elevenlabs'],
  ['https://api.minimax.cn/v1', 'minimax', 'openai'],
  ['https://api.minimaxi.com/v1', 'minimax', 'openai'],
  ['https://api.minimax.chat/v1', 'minimax', 'openai'],
  ['https://api-uw.minimax.io/v1', 'minimax', 'openai'],
  ['https://api.openai.com/v1', 'openai', 'minimax'],
] as const)(
  'keeps %s on its official %s contract even with a saved %s override',
  (baseUrl, protocol, savedProtocol) => {
    // The host contract also wins over absent, unverified or incompatible catalog metadata.
    for (const nativeApi of [undefined, null, 'openai-audio-speech'] as const) {
      const d = deps([
        custom('official', baseUrl, [
          { id: 'speech', name: 'Speech', mode: 'audio_speech', nativeApi },
        ]),
      ]);
      expect(speechModels(d)[0]).toMatchObject({ protocol, protocolLocked: true });
      expect(
        resolveSpeechConnection(d, {
          providerId: 'official',
          agent: 'codex',
          modelId: 'speech',
          protocol: savedProtocol,
        }),
      ).toEqual({
        baseUrl: `${new URL(baseUrl).origin}/v1`,
        protocol,
        headers:
          protocol === 'elevenlabs'
            ? { 'xi-api-key': 'official-codex-key' }
            : { authorization: 'Bearer official-codex-key' },
      });
    }
  },
);

it.each([
  'https://speech-proxy.test/api.elevenlabs.io/v1',
  'https://api.elevenlabs.io.proxy.test/prefix/v1',
  'https://api.elevenlabs.io:8443/prefix/v1',
  'http://127.0.0.1:8000/prefix/v1',
])(
  'preserves manual overrides for a compatible proxy at %s regardless of model brand',
  (baseUrl) => {
    const d = deps([
      custom('proxy', baseUrl, [
        { id: 'eleven_flash_v2_5', name: 'ElevenLabs', mode: 'audio_speech' },
      ]),
    ]);
    expect(speechModels(d)[0].protocolLocked).toBe(false);
    expect(
      resolveSpeechConnection(d, {
        providerId: 'proxy',
        agent: 'codex',
        modelId: 'eleven_flash_v2_5',
        protocol: 'openai',
      }),
    ).toEqual({
      baseUrl,
      protocol: 'openai',
      headers: { authorization: 'Bearer proxy-codex-key' },
    });
  },
);

it('rejects cross-origin model overrides and stale credentials in headers; permits explicit local no-auth', () => {
  const p = custom('p', 'https://api.elevenlabs.io/v1', [
    { id: 'v', name: 'V', mode: 'audio_speech' },
  ]);
  const d = deps([p]);
  p.routing.codex!.headerOverride = {
    Authorization: 'old',
    'xi-api-key': 'stale',
    Cookie: 'private',
    'Content-Type': 'bad',
    'X-Project': 'project',
  };
  expect(
    resolveSpeechConnection(d, { providerId: 'p', agent: 'codex', modelId: 'v', voice: 'v' })
      .headers,
  ).toEqual({ 'xi-api-key': 'p-codex-key', 'x-project': 'project' });
  p.models.codex![0].route = { baseUrl: 'https://foreign.test/v1', wireProtocol: 'openai-chat' };
  expect(speechModels(d)).toEqual([]);
  const local = custom('local', 'http://127.0.0.1:8000/v1');
  local.auth.method = 'none';
  local.routing.codex!.authStrategy = 'none';
  expect(speechModels(deps([local]))).toHaveLength(1);
  local.routing.codex!.upstream = 'https://remote.test/v1';
  expect(speechModels(deps([local]))).toEqual([]);
});

it('normalizes legacy settings while validating connection/runtime identity', () => {
  expect(normalizeVoiceInputSettings({}).conversationSelection).toBeUndefined();
  expect(
    normalizeVoiceInputSettings({ conversationSelection: { modelId: 'tts', voice: 'alloy' } })
      .conversationSelection,
  ).toEqual({ modelId: 'tts', voice: 'alloy' });
  expect(
    normalizeVoiceInputSettings({ conversationSelection: null }).conversationSelection,
  ).toBeUndefined();
  for (const invalid of [
    { modelId: 'tts', voice: 'bad\nvoice' },
    { modelId: 'tts', voice: 'alloy', providerId: 'byok' },
  ])
    expect(
      normalizeVoiceInputSettings({ conversationSelection: invalid }).conversationSelection,
    ).toBeUndefined();
});

it.each(['openai', 'elevenlabs', 'minimax'] as const)(
  'requires a user choice to execute an unknown proxy with %s and keeps its prefix',
  (protocol) => {
    const d = deps([
      custom('proxy', 'https://proxy.test/prefix/v1', [
        { id: 'private-tts', name: 'TTS', mode: 'audio_speech' },
      ]),
    ]);
    const selection = {
      providerId: 'proxy',
      agent: 'codex' as const,
      modelId: 'private-tts',
      voice: 'voice-id',
    };
    expect(speechModels(d)[0].protocol).toBeUndefined();
    expect(() => resolveSpeechConnection(d, selection)).toThrow('model_unavailable');
    expect(resolveSpeechConnection(d, { ...selection, protocol })).toEqual({
      baseUrl: 'https://proxy.test/prefix/v1',
      protocol,
      headers:
        protocol === 'elevenlabs'
          ? { 'xi-api-key': 'proxy-codex-key' }
          : { authorization: 'Bearer proxy-codex-key' },
    });
  },
);

// Unit tier, real catalog -> connection projection. HTTP protocol selection must
// bind both documented model and official origin; a matching brand is insufficient.
it.each([
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-tts-flash', 'qwen-tts', 'Cherry'],
  [
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'qwen3-tts-flash',
    'qwen-tts',
    'Cherry',
  ],
  [
    'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'cosyvoice-v3-flash',
    'dashscope-tts',
    'longanyang',
  ],
  ['https://work.cn-beijing.maas.aliyuncs.com/api/v1', 'cosyvoice-v3.5-plus', 'dashscope-tts', ''],
  [
    'https://work.ap-southeast-1.maas.aliyuncs.com/api/v1',
    'qwen-audio-3.1-tts-flash',
    'dashscope-tts',
    'longanhuan_v3.1',
  ],
  [
    'https://work.ap-southeast-1.maas.aliyuncs.com/api/v1',
    'qwen-audio-3.0-tts-plus',
    'dashscope-tts',
    'longanlingxin',
  ],
] as const)(
  'binds %s %s to its verified HTTP adapter',
  (baseUrl, modelId, protocol, defaultVoice) => {
    const d = deps([
      custom('ali', baseUrl, [
        { id: modelId, name: modelId, mode: 'audio_speech', nativeApi: null },
      ]),
    ]);
    expect(speechModels(d)[0]).toMatchObject({ protocol, protocolLocked: true, defaultVoice });
    expect(
      resolveSpeechConnection(d, {
        providerId: 'ali',
        agent: 'codex',
        modelId,
        protocol: 'elevenlabs',
      }),
    ).toEqual({
      protocol,
      baseUrl: `${new URL(baseUrl).origin}/api/v1`,
      headers: { authorization: 'Bearer ali-codex-key' },
    });
    if (protocol === 'qwen-tts')
      expect(() =>
        resolveSpeechConnection(d, {
          providerId: 'ali',
          agent: 'codex',
          modelId,
          voice: 'Cherry',
          speed: 1,
        }),
      ).toThrow('invalid_speech_speed');
  },
);
it.each([
  ['https://dashscope.aliyuncs.com/api/v1', 'qwen3-tts-flash-realtime'],
  ['https://dashscope.aliyuncs.com/api/v1', 'qwen-future-tts'],
  ['https://dashscope.aliyuncs.com/api/v1', 'cosyvoice-v3-flash'],
  ['https://work.ap-southeast-1.maas.aliyuncs.com/api/v1', 'cosyvoice-v3-flash'],
  ['https://dashscope.aliyuncs.com.untrusted.test/api/v1', 'qwen3-tts-flash'],
  ['http://dashscope.aliyuncs.com/api/v1', 'qwen3-tts-flash'],
  ['https://dashscope.aliyuncs.com:8443/api/v1', 'qwen3-tts-flash'],
])(
  'does not infer native HTTP from an unsupported model/region/origin: %s %s',
  (baseUrl, modelId) => {
    const d = deps([
      custom('ali', baseUrl, [
        { id: modelId, name: modelId, mode: 'audio_speech', nativeApi: null },
      ]),
    ]);
    expect(speechModels(d)[0]?.protocol).toBeUndefined();
    expect(() =>
      resolveSpeechConnection(d, { providerId: 'ali', agent: 'codex', modelId }),
    ).toThrow('model_unavailable');
  },
);
it.each(['qwen-tts', 'dashscope-tts'] as const)(
  'keeps explicit %s proxy choices on the same origin, prefix and key',
  (protocol) => {
    const d = deps([
      custom('proxy', 'https://proxy.test/tenant/api/v1', [
        { id: 'speech', name: 'Speech', mode: 'audio_speech', nativeApi: null },
      ]),
    ]);
    expect(speechModels(d)[0].protocolLocked).toBe(false);
    expect(
      resolveSpeechConnection(d, {
        providerId: 'proxy',
        agent: 'codex',
        modelId: 'speech',
        protocol,
      }),
    ).toEqual({
      protocol,
      baseUrl: 'https://proxy.test/tenant/api/v1',
      headers: { authorization: 'Bearer proxy-codex-key' },
    });
  },
);
