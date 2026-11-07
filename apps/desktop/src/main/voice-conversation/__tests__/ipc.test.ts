import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, providerPresetOAuth, type Catalog } from '@cindy/model-providers';

type Handler = (...args: unknown[]) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
  trusted: vi.fn(),
  emit: vi.fn(),
  append: vi.fn(),
  boundary: false,
  catalog: undefined as Catalog | undefined,
  oauthToken: vi.fn<() => string | null>(),
  readKey: vi.fn<() => string | null>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: Handler) => h.handlers.set(name, fn),
    on: (name: string, fn: Handler) => h.listeners.set(name, fn),
  },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: h.emit }) },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: h.trusted,
}));
vi.mock('../../cindy-brain/index.js', () => ({ hasEnabledGhostAssistantHook: () => false }));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => h.catalog ?? ({
    providers: [
      {
        id: 'xd',
        audioModels: [
          { id: 'voice-test', name: 'Speech', mode: 'audio_speech', availability: 'available' },
        ],
      },
    ],
  }),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: h.readKey,
  getProviderSecretStore: () => ({ get: () => 'test-key' }),
}));
vi.mock('../../maker-host/generic-oauth.js', () => ({
  readCachedGenericOAuthAccessToken: h.oauthToken,
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => 'https://gateway.test/v1',
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test-owner',
  isAppSessionBoundaryPending: () => h.boundary,
}));
vi.mock('../../localDb/ipc/bots.js', () => ({
  getBotRemoteResourceSource: async () => ({ hiddenAt: null, canonicalSessionId: 'canonical' }),
}));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  isProviderModelRouteDisabled: () => false,
}));
vi.mock('../semanticExit.js', () => ({ classifyVoiceExit: vi.fn(async () => false) }));

vi.mock('../dialogue.js', () => ({ CompanionCallDialogue: class {
  async start() {}
  async end() {}
  async submit() { return true; }
  async promote() { return true; }
} }));

import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import { registerVoiceConversationIpc } from '../index.js';
import { outboundFetch } from '../../maker-host/outbound-fetch.js';
import { clearModelVisibilityMirror, setModelVisibilityMirror } from '../../maker-host/model-visibility-mirror.js';
const sender = (id = 1) => ({ sender: { id, once: vi.fn(), on: vi.fn() } });
const call = (name: string, ...args: unknown[]) =>
  h.handlers.get(`voice-conversation:${name}`)!(sender(), ...args);
beforeEach(() => {
  h.handlers.clear();
  h.listeners.clear();
  h.trusted.mockReset();
  h.append.mockReset();
  h.boundary = false;
  h.catalog = undefined;
  h.oauthToken.mockReset().mockReturnValue(null);
  h.readKey.mockReset().mockReturnValue(null);
  setModelVisibilityMirror({});
  vi.mocked(outboundFetch).mockReset();
  let settings = normalizeVoiceInputSettings({});
  registerVoiceConversationIpc({
    createAudioGate: () => undefined,
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = normalizeVoiceInputSettings({ ...settings, ...patch });
      return settings;
    },
    hasDictation: () => false,
    createProvider: async () => ({
      start: async () => {},
      stop: async () => {},
      appendAudio: h.append,
      flushAudio: async () => {},
      onEvent: () => {},
      onSegment: () => {},
    }),
  });
});
afterEach(async () => {
  clearModelVisibilityMirror();
  h.trusted.mockReset();
  await call('end', 'call');
  await call('stop-preview', 'preview');
});
const startInput = () => ({
  callId: 'call',
  botId: 'bot',
  sessionId: 'canonical',
  modelId: 'voice-test',
  voice: 'alloy',
});
const start = () => call('start', startInput());

// PR #6900 unit: injected model tests missed production credential-store wiring.
// Exercise real IPC -> catalog -> voice query/synthesis with a legacy display ID,
// then remove its login. Only the stored ID is read, never an API-key fallback.
it('uses the saved OpenRouter OAuth connection without exposing its credential to the renderer', async () => {
  const oauth = providerPresetOAuth('openrouter')!;
  const modelId = 'elevenlabs/eleven-v3';
  const provider = buildUserProvider({
    id: 'xai', name: 'My router', auth: { method: 'oauth', oauth },
    runtimes: { codex: { baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: modelId, name: 'Speech', mode: 'audio_speech' }] } },
  });
  h.catalog = { ...BUNDLED_CATALOG, providers: [provider] };
  h.oauthToken.mockReturnValue('fake-saved-oauth-key');
  h.readKey.mockReturnValue('fake-unrelated-api-key');
  const models = await call('models');
  expect(models).toEqual([expect.objectContaining({ providerId: 'custom:xai', id: modelId })]);
  expect(h.oauthToken).toHaveBeenCalledWith('xai', oauth);
  expect(JSON.stringify(models)).not.toContain('fake-saved-oauth-key');
  const selection = { providerId: 'custom:xai', agent: 'codex', modelId, voice: 'sarah' };
  vi.mocked(outboundFetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: [
    { id: modelId, supported_voices: ['sarah'] },
  ] })));
  expect(await call('voices', selection)).toMatchObject({ voices: [{ id: 'sarah' }] });
  await call('start', { ...selection, callId: 'call', botId: 'bot', sessionId: 'canonical' });
  vi.mocked(outboundFetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 0]), {
    headers: { 'Content-Type': 'audio/pcm' },
  }));
  await call('speak', { callId: 'call', requestId: 'oauth-speech', text: 'Hello' });
  expect(vi.mocked(outboundFetch).mock.calls.map(([url]) => String(url))).toEqual([
    'https://openrouter.ai/api/v1/models?output_modalities=speech',
    'https://openrouter.ai/api/v1/audio/speech',
  ]);
  for (const [, init] of vi.mocked(outboundFetch).mock.calls)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-saved-oauth-key');
  expect(h.readKey).not.toHaveBeenCalled();
  h.oauthToken.mockReturnValue(null);
  expect(await call('models')).toEqual([]);
  await expect(call('voices', selection)).rejects.toThrow('Voice conversation is unavailable');
  expect(outboundFetch).toHaveBeenCalledTimes(2);
});

// PR #6768 unit regression: model discovery must wait for current-owner display
// preferences. Existing IPC tests start with ready state and cannot catch this race.
it('waits for display preferences before returning the speech picker catalog', async () => {
  clearModelVisibilityMirror();
  const ready = vi.fn();
  const pending = call('models') as Promise<unknown>;
  void pending.then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  setModelVisibilityMirror({});
  await expect(pending).resolves.toEqual([expect.objectContaining({ id: 'voice-test' })]);
});

// Oct 21 TTS stall: transport tests did not cover the IPC catch-all losing its
// timeout cause. Unit: real handlers/service/transport, stalled fetch or PCM read.
it.each(['headers', 'read'] as const)(
  'exposes only a safe timeout code for stalled speech %s',
  async (stage) => {
    vi.useFakeTimers();
    try {
      await start();
      if (stage === 'headers') {
        vi.mocked(outboundFetch).mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new Error('private network detail')),
                { once: true },
              );
            }),
        );
      } else {
        vi.mocked(outboundFetch).mockResolvedValue(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
              },
            }),
            { headers: { 'Content-Type': 'audio/pcm' } },
          ),
        );
      }
      const speech = call('speak', { callId: 'call', requestId: 'one', text: 'hello' });
      let pending = speech;
      if (stage === 'read') {
        await speech;
        await call('read-speech', 'call', 'one');
        pending = call('read-speech', 'call', 'one');
      }
      const result = expect(pending).rejects.toThrow(
        '[VOICE_SPEECH_TIMEOUT] Speech response timed out.',
      );
      await vi.advanceTimersByTimeAsync(stage === 'headers' ? 30_000 : 15_000);
      await result;
      expect(outboundFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);

it('keeps untrusted upstream errors generic rather than forwarding their text or claimed timeout code', async () => {
  await start();
  vi.mocked(outboundFetch).mockRejectedValue(
    new Error('[VOICE_SPEECH_TIMEOUT] private upstream detail'),
  );
  await expect(call('speak', { callId: 'call', requestId: 'one', text: 'hello' })).rejects.toThrow(
    '[PRECONDITION_FAILED] Voice conversation is unavailable.',
  );
});

it('patches playback without replacing the saved route and validates boolean overrides', async () => {
  const choice = { modelId: 'voice-test', voice: 'alloy', speed: 1.15 };
  await call('set-preference', 'bot-a', choice);
  await call('set-preference', 'bot-a', undefined, false);
  expect(await call('preference', 'bot-a')).toEqual({
    selection: choice,
    customized: true,
    sentencePlayback: false,
  });
  await expect(call('set-preference', 'bot-a', undefined, 'false')).rejects.toThrow();
  expect(await call('preference', 'bot-a')).toMatchObject({ sentencePlayback: false });
  await call('set-preference', 'bot-a', null, null);
  expect(await call('preference', 'bot-a')).toEqual({
    selection: null,
    customized: false,
    sentencePlayback: true,
  });
  await start();
  await expect(
    call('speak', { callId: 'call', requestId: 'a', text: 'hi', streaming: 'true' }),
  ).rejects.toThrow();
});

it.each([NaN, Infinity, '1.2', 0.1, 4.1])('rejects invalid speed %s without replacing the saved preference', async (speed) => {
  const choice = { modelId: 'voice-test', voice: 'alloy', speed: 1.15 };
  await call('set-preference', 'bot', choice);
  await expect(call('set-preference', 'bot', { ...choice, speed })).rejects.toThrow();
  expect(await call('preference', 'bot')).toMatchObject({ selection: choice });
});

it('rejects an untrusted sender before returning models or opening a connection', async () => {
  h.trusted.mockImplementation(() => {
    throw new Error('untrusted frame');
  });
  await expect(call('models')).rejects.toThrow('untrusted frame');
  await expect(start()).rejects.toThrow('untrusted frame');
  for (const name of ['voices', 'preview', 'read-preview', 'stop-preview', 'start-playback']) {
    await expect(call(name, {})).rejects.toThrow('untrusted frame');
  }
});

it('validates playback-only starts with the same canonical, account and selection boundaries', async () => {
  const input = {
    callId: 'call',
    botId: 'bot',
    sessionId: 'canonical',
    modelId: 'voice-test',
    voice: 'alloy',
  };
  await expect(call('start-playback', { ...input, voice: 'bad\nvoice' })).rejects.toThrow();
  await expect(call('start-playback', { ...input, sessionId: 'not-canonical' })).rejects.toThrow();
  await expect(call('start-playback', { ...input, callId: 'x'.repeat(65) })).rejects.toThrow();
  h.boundary = true;
  await expect(call('start-playback', input)).rejects.toThrow();
  h.boundary = false;
  expect(await call('start-playback', input)).toEqual({ callId: 'call' });
  await expect(call('set-input-muted', 'call', false)).rejects.toThrow();
  expect(outboundFetch).not.toHaveBeenCalled();
});

it('validates preview boundaries before synthesis and cleans up when its sender is destroyed', async () => {
  const input = {
    previewId: 'preview',
    botId: 'bot',
    sessionId: 'canonical',
    modelId: 'voice-test',
    voice: 'alloy',
    text: 'sample',
  };
  await expect(call('preview', { ...input, voice: 'bad\nvoice' })).rejects.toThrow();
  await expect(call('preview', { ...input, text: 'x'.repeat(257) })).rejects.toThrow();
  await expect(call('preview', { ...input, sessionId: 'another-task' })).rejects.toThrow();
  h.boundary = true;
  await expect(call('voices', { modelId: 'voice-test' })).rejects.toThrow();
  await expect(call('preview', input)).rejects.toThrow();
  h.boundary = false;
  expect(outboundFetch).not.toHaveBeenCalled();
  vi.mocked(outboundFetch).mockResolvedValue(
    new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
  );
  const event = sender(3);
  await h.handlers.get('voice-conversation:preview')!(event, input);
  expect(h.append).not.toHaveBeenCalled();
  const destroyed = event.sender.once.mock.calls.find(([name]) => name === 'destroyed')?.[1] as
    (() => void) | undefined;
  expect(destroyed).toBeTypeOf('function');
  destroyed!();
  await expect(
    h.handlers.get('voice-conversation:read-preview')!(event, 'preview'),
  ).rejects.toThrow();
  await expect(start()).resolves.toEqual({ callId: 'call' });
});

// The call now outlives every route, so only a real reload may release it. A lease
// left behind would refuse all later calls. Unit, real IPC wiring; under 1s with the file.
it('reports a held voice lease distinctly and releases it when the owner window reloads', async () => {
  const event = sender();
  const input = await h.handlers.get('voice-conversation:start')!(event, startInput());
  expect(input).toEqual({ callId: 'call' });
  await expect(h.handlers.get('voice-conversation:start')!(sender(2), startInput())).rejects.toThrow(
    '[VOICE_CONVERSATION_BUSY]',
  );
  const reloaded = event.sender.on.mock.calls.find(([name]) => name === 'did-navigate')?.[1] as
    | (() => void)
    | undefined;
  reloaded!();
  await vi.waitFor(async () => {
    await expect(h.handlers.get('voice-conversation:start')!(sender(2), startInput())).resolves.toEqual({
      callId: 'call',
    });
  });
  await h.handlers.get('voice-conversation:end')!(sender(2), 'call');
});

it('enforces sender ownership and PCM size/alignment on the non-awaitable capture channel', async () => {
  await start();
  const audio = h.listeners.get('voice-conversation:audio')!;
  audio(sender(2), { callId: 'call', pcm: new ArrayBuffer(2) });
  audio(sender(), { callId: 'call', pcm: new ArrayBuffer(16_002) });
  audio(sender(), { callId: 'call', pcm: new ArrayBuffer(3) });
  audio(sender(), { callId: 'call', pcm: 'invalid' });
  expect(h.append).not.toHaveBeenCalled();
  audio(sender(), { callId: 'call', pcm: new ArrayBuffer(1280) });
  expect(h.append).toHaveBeenCalledOnce();
});

it('refuses a start during an account transition, malformed voice parameters and oversized TTS text', async () => {
  h.boundary = true;
  await expect(start()).rejects.toThrow();
  h.boundary = false;
  await expect(
    call('start', {
      callId: 'call',
      botId: 'bot',
      sessionId: 'canonical',
      modelId: 'voice-test',
      voice: '../bad',
    }),
  ).rejects.toThrow();
  await start();
  await expect(
    call('speak', { callId: 'call', requestId: 'x', text: 'x'.repeat(4097) }),
  ).rejects.toThrow();
});

it('saves and resets one companion without overwriting another, and guards settings IPC', async () => {
  const choice = {
    providerId: 'byok',
    agent: 'codex',
    modelId: 'tts',
    voice: 'nova',
    protocol: 'openai',
  };
  await call('set-preference', 'bot-a', choice);
  await call('set-preference', 'bot-b', { ...choice, voice: 'alloy' });
  expect(await call('preference', 'bot-a')).toEqual({
    selection: choice,
    customized: true,
    sentencePlayback: true,
  });
  await call('set-preference', 'bot-a', null);
  expect(await call('preference', 'bot-a')).toEqual({
    selection: null,
    customized: false,
    sentencePlayback: true,
  });
  expect(await call('preference', 'bot-b')).toMatchObject({ selection: { voice: 'alloy' } });
  h.boundary = true;
  await expect(call('preference', 'bot-b')).rejects.toThrow();
  await expect(call('set-preference', 'bot-b', null)).rejects.toThrow();
  h.boundary = false;
  h.trusted.mockImplementation(() => {
    throw new Error('untrusted');
  });
  await expect(call('preference', 'bot-b')).rejects.toThrow('untrusted');
  await expect(call('set-preference', 'bot-b', null)).rejects.toThrow('untrusted');
});

it('validates microphone mute ownership and drops PCM from previous input generations', async () => {
  await start();
  await expect(call('set-input-muted', 'call', 'true')).rejects.toThrow();
  await expect(
    h.handlers.get('voice-conversation:set-input-muted')!(sender(2), 'call', true),
  ).rejects.toThrow();
  expect(await call('set-input-muted', 'call', true)).toEqual({ inputGeneration: 1 });
  h.boundary = true;
  await expect(call('set-input-muted', 'call', false)).rejects.toThrow();
  h.boundary = false;
  expect(await call('set-input-muted', 'call', false)).toEqual({ inputGeneration: 2 });
  const audio = h.listeners.get('voice-conversation:audio')!;
  for (const inputGeneration of [undefined, 0, -1, 0.5, '2', NaN, Infinity])
    audio(sender(), { callId: 'call', inputGeneration, pcm: new ArrayBuffer(2) });
  expect(h.append).not.toHaveBeenCalled();
  audio(sender(), { callId: 'call', inputGeneration: 2, pcm: new ArrayBuffer(2) });
  expect(h.append).toHaveBeenCalledOnce();
  h.trusted.mockImplementation(() => {
    throw new Error('untrusted frame');
  });
  await expect(call('set-input-muted', 'call', true)).rejects.toThrow('untrusted frame');
});

it('bounds semantic exit IPC to trusted local call/final/generation references', async () => {
  await start();
  expect(await call('classify-exit', 'call', 'unknown-final', 0)).toBe(false);
  for (const generation of [-1, 0.5, '0', NaN, Infinity])
    await expect(call('classify-exit', 'call', '1', generation)).rejects.toThrow();
  await expect(call('classify-exit', 'call', 'x'.repeat(129), 0)).rejects.toThrow();
  await expect(
    h.handlers.get('voice-conversation:classify-exit')!(sender(2), 'call', '1', 0),
  ).rejects.toThrow();
  h.trusted.mockImplementation(() => {
    throw new Error('untrusted frame');
  });
  await expect(call('classify-exit', 'call', '1', 0)).rejects.toThrow('untrusted frame');
});
