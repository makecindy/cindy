import { expect, it, vi } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type Catalog,
  type ProviderMediaModel,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';
import { resolveSpeechConnection, speechModels, type SpeechCatalogDeps } from '../models.js';
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
