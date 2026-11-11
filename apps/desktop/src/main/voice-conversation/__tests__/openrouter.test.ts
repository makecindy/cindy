import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  isAgentSelectableModel,
  mergeDiscoveredRuntimeModels,
  parseModelsListResponse,
  providerPresetOAuth,
} from '@cindy/model-providers';
import { fetchProviderModels } from '../../maker-host/provider-model-fetch.js';
import { resolveSpeechConnection, speechModels, type SpeechCatalogDeps } from '../models.js';
import { SpeechSynthesisSession, type SpeechConnection } from '../speech.js';
import { speechRequest } from '../speechProtocols.js';
import { loadSpeechVoices } from '../voices.js';

// Unit tier: exercise the actual discovery -> saved runtime -> picker -> transport path.
// The ordinary OpenRouter catalog omits speech; its dedicated list has no Cindy mode.
const catalogUrl = 'https://openrouter.ai/api/v1/models';
const speechUrl = `${catalogUrl}?output_modalities=speech`;
const speechId = 'elevenlabs/eleven-v3';
const speechEntry = {
  id: speechId,
  name: 'Eleven v3',
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  supported_voices: ['george', 'sarah'],
  pricing: { prompt: '0.00018' }, // per character, not per token
};
const chatEntry = {
  id: 'openai/audio-chat',
  architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text', 'audio'] },
  pricing: { prompt: '0.000001' },
};
const json = (data: unknown) => new Response(JSON.stringify(data));
const connection: SpeechConnection = {
  protocol: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  headers: { authorization: 'Bearer test-openrouter-key' },
};
const current = () => {};

describe('OpenRouter speech integration', () => {
  // PR #6900: API-key-only fixtures missed discovered OAuth models being removed
  // from the picker. Unit: real catalog projection and transport for both logins.
  it.each((['claude-code', 'codex', 'pi'] as const).flatMap(agent =>
    (['apiKey', 'oauth'] as const).map(auth => ({ agent, auth }))))(
    'discovers speech alongside chat and executes the owning $agent/$auth connection',
    async ({ agent, auth }) => {
      const oauth = providerPresetOAuth('openrouter')!;
      const baseUrl = agent === 'claude-code' ? 'https://openrouter.ai/api' : connection.baseUrl;
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(init?.headers).toEqual({ authorization: 'Bearer test-openrouter-key' });
        return json({ data: String(url) === speechUrl ? [speechEntry] : [chatEntry] });
      });
      const result = await fetchProviderModels(
        {
          agent,
          baseUrl,
          apiKey: 'test-openrouter-key',
          redirect: 'error',
        },
        fetcher,
      );
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([catalogUrl, speechUrl]);
      expect(result.ok).toBe(true);
      const discovered = result.models!;
      expect(discovered.find((m) => m.id === speechId)?.discoveredCost).toBeUndefined();
      expect(discovered.find((m) => m.id === chatEntry.id)?.discoveredCost).toEqual({ input: 1 });
      const saved = mergeDiscoveredRuntimeModels([], discovered);
      const provider = buildUserProvider({
        id: 'router',
        name: 'My OpenRouter',
        ...(auth === 'oauth' ? { auth: { method: 'oauth' as const, oauth } } : {}),
        runtimes: {
          [agent]: { baseUrl, models: saved },
        },
      });
      provider.routing[agent]!.headerOverride = {
        'anthropic-version': '2023-06-01',
        'x-api-key': 'stale-key',
      };
      expect(provider.audioModels).toEqual([
        expect.objectContaining({ id: speechId, mode: 'audio_speech' }),
      ]);
      expect(
        provider.models[agent]!.filter((m) =>
          isAgentSelectableModel(m, { userProvider: true }),
        ).map((m) => m.id),
      ).toEqual([chatEntry.id]);
      const deps: SpeechCatalogDeps = {
        catalog: { ...BUNDLED_CATALOG, providers: [provider] },
        gatewayAllowed: false,
        disabled: () => false,
        readKey: vi.fn(() => 'test-openrouter-key'),
        readOAuthToken: vi.fn(() => 'test-openrouter-key'),
        gatewayConnection: () => {
          throw new Error('not Gateway');
        },
      };
      expect(speechModels(deps)).toEqual([
        expect.objectContaining({
          id: speechId,
          providerId: 'router',
          providerName: 'My OpenRouter',
          agent,
          protocol: 'openai',
          protocolLocked: true,
          defaultVoice: '',
          speedRange: null,
        }),
      ]);
      const selection = { providerId: 'router', agent, modelId: speechId, voice: 'sarah' };
      const bound = resolveSpeechConnection(deps, { ...selection, protocol: 'elevenlabs' });
      expect(bound.baseUrl).toBe(connection.baseUrl);
      expect(bound.protocol).toBe('openai');
      expect(bound.headers).toEqual({ ...connection.headers,
        'http-referer': 'https://cindy.app', 'x-openrouter-title': 'Cindy',
      });
      if (auth === 'oauth') {
        expect(deps.readOAuthToken).toHaveBeenCalledWith('router', oauth);
        expect(deps.readKey).not.toHaveBeenCalled();
      } else {
        expect(deps.readKey).toHaveBeenCalledWith('router', agent);
        expect(deps.readOAuthToken).not.toHaveBeenCalled();
      }
      expect(provider.routing[agent]?.upstream).toBe(baseUrl);
      expect(() => resolveSpeechConnection(deps, { ...selection, speed: 1.5 })).toThrow(
        'invalid_speech_speed',
      );
      const request = speechRequest(bound, { modelId: speechId, voice: 'sarah', text: 'Hello' });
      expect(request.url.href).toBe('https://openrouter.ai/api/v1/audio/speech');
      expect(JSON.parse(request.body)).toEqual({
        model: speechId,
        voice: 'sarah',
        input: 'Hello',
        response_format: 'pcm',
      });
      expect(() =>
        speechRequest(bound, { modelId: speechId, voice: 'sarah', text: 'Hello', speed: 1.5 }),
      ).toThrow();
    },
  );

  // Unit boundary: a name/model family or saved API key must not admit another
  // OAuth contract, a non-official route, or a logged-out OpenRouter connection.
  it.each(['unknown-oauth', 'subscription', 'native', 'proxy', 'wrong-path', 'wrong-auth', 'logged-out'] as const)(
    'keeps OAuth speech unavailable for %s', (kind) => {
      const oauth = kind === 'subscription' ? providerPresetOAuth('minimax')!
        : { ...providerPresetOAuth('openrouter')!, ...(kind === 'unknown-oauth'
          ? { tokenUrl: 'https://auth.example/token' } : {}) };
      const baseUrl = kind === 'proxy' ? 'https://proxy.example/api/v1'
        : kind === 'wrong-path' ? 'https://openrouter.ai/proxy/v1' : connection.baseUrl;
      const provider = buildUserProvider({
        id: 'router', name: 'OpenRouter', auth: { method: 'oauth', oauth },
        runtimes: { codex: { baseUrl, models: [{ id: speechId, name: speechId, mode: 'audio_speech' }] } },
      });
      if (kind === 'native') provider.auth.native = 'codex';
      if (kind === 'wrong-auth') provider.routing.codex!.authStrategy = 'api-key-header';
      const deps: SpeechCatalogDeps = {
        catalog: { ...BUNDLED_CATALOG, providers: [provider] }, gatewayAllowed: false,
        disabled: () => false, gatewayConnection: () => { throw new Error('not Gateway'); },
        readKey: vi.fn(() => 'fake-unrelated-key'),
        readOAuthToken: vi.fn(() => kind === 'logged-out' ? null : 'fake-oauth-key'),
      };
      expect(speechModels(deps)).toEqual([]);
      expect(() => resolveSpeechConnection(deps, {
        providerId: 'router', agent: 'codex', modelId: speechId, protocol: 'openai',
      })).toThrow('model_unavailable');
      expect(deps.readKey).not.toHaveBeenCalled();
      if (kind !== 'logged-out') expect(deps.readOAuthToken).not.toHaveBeenCalled();
    },
  );

  it('retains chat on a failed optional speech query, and honors an explicit catalog filter', async () => {
    const spec = { agent: 'codex' as const, baseUrl: connection.baseUrl, apiKey: 'test-key' };
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === speechUrl ? new Response(null, { status: 503 }) : json({ data: [chatEntry] }),
    );
    expect((await fetchProviderModels(spec, fetcher)).models?.map((m) => m.id)).toEqual([
      chatEntry.id,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    await fetchProviderModels(
      { ...spec, modelsUrl: `${catalogUrl}?output_modalities=text` },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps user type/name overrides and does not infer TTS from audio or a different origin', () => {
    const discovered = parseModelsListResponse({ data: [speechEntry, chatEntry] }, speechUrl)!;
    expect(discovered[0].discoveredMetadata?.mode).toBe('audio_speech');
    expect(discovered[0].discoveredMetadata?.nativeApi).toBeUndefined();
    expect(discovered[1].discoveredMetadata?.mode).toBeUndefined();
    const saved = mergeDiscoveredRuntimeModels(
      [{ id: speechId, name: 'My name', mode: 'chat' }],
      discovered,
    );
    expect(saved.find((m) => m.id === speechId)).toMatchObject({
      name: 'My name',
      mode: 'chat',
      discoveredMetadata: { mode: 'audio_speech' },
    });
    expect(
      parseModelsListResponse({ data: [speechEntry] }, 'https://proxy.test/api/v1/models')![0]
        .discoveredMetadata?.mode,
    ).toBeUndefined();
  });

  it.each([
    'https://openrouter.ai/proxy/v1',
    'https://openrouter.ai:8443/api/v1',
    'https://openrouter.ai.untrusted.test/api/v1',
    'http://openrouter.ai/api/v1',
  ])('does not apply official routing or speed limits to %s', (baseUrl) => {
    const provider = buildUserProvider({
      id: 'proxy',
      name: 'Proxy',
      runtimes: {
        codex: {
          baseUrl,
          models: [{ id: speechId, name: speechId, mode: 'audio_speech', nativeApi: null }],
        },
      },
    });
    const deps: SpeechCatalogDeps = {
      catalog: { ...BUNDLED_CATALOG, providers: [provider] },
      gatewayAllowed: false,
      disabled: () => false,
      readKey: () => 'test-key',
      gatewayConnection: () => {
        throw new Error('not Gateway');
      },
    };
    expect(speechModels(deps)[0]).toMatchObject({ protocolLocked: false });
    expect(() =>
      resolveSpeechConnection(deps, { providerId: 'proxy', agent: 'codex', modelId: speechId }),
    ).toThrow('model_unavailable');
    const explicit = resolveSpeechConnection(deps, {
      providerId: 'proxy',
      agent: 'codex',
      modelId: speechId,
      protocol: 'openai',
    });
    expect(explicit.baseUrl).toBe(baseUrl);
    expect(explicit.speedRange).toBeUndefined();
  });

  it('loads and refreshes only the selected model voices, keeping manual IDs valid', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: [
            { ...speechEntry, supported_voices: ['george', 'sarah', 'george', null, '../bad'] },
            { id: 'another-model', supported_voices: ['wrong-model'] },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ ...speechEntry, supported_voices: ['alice'] }] }));
    expect(await loadSpeechVoices(connection, speechId, fetcher, current, 'router')).toEqual({
      source: 'provider',
      voices: [
        { id: 'george', name: 'george' },
        { id: 'sarah', name: 'sarah' },
      ],
    });
    expect(await loadSpeechVoices(connection, speechId, fetcher, current, 'router')).toEqual({
      source: 'provider',
      voices: [{ id: 'alice', name: 'alice' }],
    });
    expect(fetcher).toHaveBeenCalledWith(
      speechUrl,
      expect.objectContaining({ method: 'GET', headers: connection.headers, redirect: 'error' }),
    );
    expect(
      JSON.parse(
        speechRequest(connection, { modelId: speechId, voice: 'custom-voice-id', text: 'Hello' })
          .body,
      ).voice,
    ).toBe('custom-voice-id');
  });

  it.each([null, undefined])(
    'keeps manual entry when supported_voices is %s',
    async (supported_voices) => {
      expect(
        await loadSpeechVoices(
          connection,
          speechId,
          vi.fn(async () => json({ data: [{ ...speechEntry, supported_voices }] })),
          current,
        ),
      ).toEqual({ source: 'manual', voices: [] });
    },
  );

  it('rejects missing models, malformed catalogs and stale account results', async () => {
    for (const data of [
      { data: [] },
      { data: [{ ...speechEntry, supported_voices: 'sarah' }] },
      {},
    ]) {
      await expect(
        loadSpeechVoices(
          connection,
          speechId,
          vi.fn(async () => json(data)),
          current,
        ),
      ).rejects.toThrow();
    }
    let active = true;
    await expect(
      loadSpeechVoices(
        connection,
        speechId,
        vi.fn(async () => {
          active = false;
          return json({ data: [speechEntry] });
        }),
        () => {
          if (!active) throw new Error('stale account');
        },
      ),
    ).rejects.toThrow('stale account');
  });

  it('never queries OpenRouter for Gateway or a third-party proxy', async () => {
    const fetcher = vi.fn();
    for (const baseUrl of ['https://proxy.test/api/v1', 'https://openrouter.ai/proxy/v1']) {
      expect(
        await loadSpeechVoices({ ...connection, baseUrl }, speechId, fetcher, current),
      ).toEqual({ source: 'manual', voices: [] });
    }
    await loadSpeechVoices(connection, 'elevenlabs/eleven_v3', fetcher, current, 'xd');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams binary PCM through the existing cancellable playback contract', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 0, 255, 127]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    );
    const speech = new SpeechSynthesisSession({
      connection: () => connection,
      fetch: fetcher,
      assertCurrent: current,
    });
    expect(
      await speech.start({
        requestId: 'or-test',
        modelId: speechId,
        voice: 'sarah',
        text: 'Hello',
      }),
    ).toEqual({ sampleRate: 24000 });
    expect(new Uint8Array((await speech.read('or-test')).pcm)).toEqual(
      new Uint8Array([1, 0, 255, 127]),
    );
    expect((await speech.read('or-test')).done).toBe(true);
    speech.cancel();
  });
});
