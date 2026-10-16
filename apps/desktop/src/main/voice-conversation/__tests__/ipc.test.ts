import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
  trusted: vi.fn(),
  emit: vi.fn(),
  append: vi.fn(),
  boundary: false,
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
  getActiveCatalog: () => ({
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
  readCustomProviderKey: () => null,
  getProviderSecretStore: () => ({ get: () => 'test-key' }),
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

import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import { registerVoiceConversationIpc } from '../index.js';
import { outboundFetch } from '../../maker-host/outbound-fetch.js';
const sender = (id = 1) => ({ sender: { id, once: vi.fn() } });
const call = (name: string, ...args: unknown[]) =>
  h.handlers.get(`voice-conversation:${name}`)!(sender(), ...args);
beforeEach(() => {
  h.handlers.clear();
  h.listeners.clear();
  h.trusted.mockReset();
  h.append.mockReset();
  h.boundary = false;
  vi.mocked(outboundFetch).mockReset();
  let settings = normalizeVoiceInputSettings({});
  registerVoiceConversationIpc({
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
  h.trusted.mockReset();
  await call('end', 'call');
  await call('stop-preview', 'preview');
});
const start = () =>
  call('start', {
    callId: 'call',
    botId: 'bot',
    sessionId: 'canonical',
    modelId: 'voice-test',
    voice: 'alloy',
  });

it('patches playback without replacing the saved route and validates boolean overrides', async () => {
  const choice = { modelId: 'voice-test', voice: 'alloy' };
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
