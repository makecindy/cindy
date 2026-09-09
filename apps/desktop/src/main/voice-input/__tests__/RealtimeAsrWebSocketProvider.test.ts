import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
}));

import {
  buildSessionUpdateMessage,
  invalidatePrewarmedRealtimeAsrWebSocketSession,
  prewarmRealtimeAsrWebSocketSession,
  realtimeErrorMessage,
  RealtimeAsrWebSocketProvider,
  resamplePcm16,
} from '../RealtimeAsrWebSocketProvider.js';
import { openAiLanguageCode } from '../language.js';
import {
  LITELLM_QWEN3_REALTIME_TRANSCRIPTION_PATH,
  buildLiteLlmRealtimeWebSocketUrl,
  buildProxyEndpointUrl,
  describeAsrHandshakeTraceId,
  describeAsrWebSocketTarget,
  estimateVoiceInputAsrCostUsd,
  getVoiceInputAsrProfiles,
  isRealtimeAsrProvider,
  liteLlmRealtimeHeaders,
  voiceInputProviderModel,
} from '../voiceInputAsrConfig.js';
import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  estimateVoiceInputRefinerCostUsd,
  getVoiceInputRefinerProfile,
  getVoiceInputRefinerProfiles,
  resolveVoiceInputRefinerProviderKindAlias,
} from '../../../shared/voiceInputRefinerProfiles.js';

describe('RealtimeAsrWebSocketProvider helpers', () => {
  it('resamples 16 kHz PCM16 audio to OpenAI realtime 24 kHz PCM16', () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(0, 0);
    input.writeInt16LE(1_000, 2);

    const output = resamplePcm16(input, 16_000, 24_000);

    expect(output.length).toBe(6);
    expect(output.readInt16LE(0)).toBe(0);
    expect(output.readInt16LE(2)).toBeGreaterThan(0);
    expect(output.readInt16LE(4)).toBe(1_000);
  });

  it('normalizes app language settings to OpenAI language codes', () => {
    expect(openAiLanguageCode('auto')).toBeUndefined();
    expect(openAiLanguageCode('zh-CN')).toBe('zh');
    expect(openAiLanguageCode('en-US')).toBe('en');
    expect(openAiLanguageCode('Japanese')).toBe('ja');
  });

  it('builds LiteLLM passthrough realtime WebSocket URLs without query model leakage', () => {
    expect(buildProxyEndpointUrl('https://llm.example.com/base/', '/openai/passthrough/v1/realtime?intent=transcription'))
      .toBe('https://llm.example.com/base/openai/passthrough/v1/realtime?intent=transcription');
    expect(buildLiteLlmRealtimeWebSocketUrl('https://llm.example.com/proxy'))
      .toBe('wss://llm.example.com/proxy/openai/passthrough/v1/realtime?intent=transcription');
    expect(buildLiteLlmRealtimeWebSocketUrl('https://llm.example.com/proxy', LITELLM_QWEN3_REALTIME_TRANSCRIPTION_PATH))
      .toBe('wss://llm.example.com/proxy/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime');
    expect(liteLlmRealtimeHeaders('litellm-gpt-realtime-whisper')).toEqual({
      'x-litellm-model': 'gpt-realtime-whisper',
    });
    expect(liteLlmRealtimeHeaders('litellm-qwen3-asr-flash-realtime')).toEqual({});
  });

  it('describes handshake targets without credentials and picks known gateway trace headers', () => {
    expect(describeAsrWebSocketTarget('wss://llm.example.com/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'))
      .toBe('llm.example.com/dashscope/api-ws/v1/realtime');
    expect(describeAsrWebSocketTarget('ws://127.0.0.1:8080/volcengine/api/v3/sauc/bigmodel_async'))
      .toBe('127.0.0.1:8080/volcengine/api/v3/sauc/bigmodel_async');
    expect(describeAsrWebSocketTarget('not a url')).toBe('invalid-url');

    expect(describeAsrHandshakeTraceId({ 'x-request-id': 'req-1', 'cf-ray': 'ray-2' })).toBe('x-request-id=req-1');
    expect(describeAsrHandshakeTraceId({ 'x-litellm-call-id': ['call-3'] })).toBe('x-litellm-call-id=call-3');
    expect(describeAsrHandshakeTraceId({ 'content-type': 'text/html' })).toBeNull();
    expect(describeAsrHandshakeTraceId({ 'x-request-id': '  ' })).toBeNull();
  });

  it('classifies realtime ASR providers and model ids', () => {
    expect(isRealtimeAsrProvider('openai-realtime-whisper')).toBe(true);
    expect(isRealtimeAsrProvider('litellm-gpt-realtime-whisper')).toBe(true);
    expect(isRealtimeAsrProvider('litellm-qwen3-asr-flash-realtime')).toBe(true);
    expect(isRealtimeAsrProvider('litellm-volcengine-sauc-asr')).toBe(true);
    expect(isRealtimeAsrProvider('litellm-batch')).toBe(false);
    expect(voiceInputProviderModel('openai-realtime-whisper')).toBe('gpt-realtime-whisper');
    expect(voiceInputProviderModel('litellm-gpt-realtime-whisper')).toBe('gpt-realtime-whisper');
    expect(voiceInputProviderModel('litellm-qwen3-asr-flash-realtime')).toBe('qwen3-asr-flash-realtime');
    expect(voiceInputProviderModel('litellm-volcengine-sauc-asr')).toBe('volcengine-sauc-asr');
    expect(voiceInputProviderModel('litellm-batch')).toBe('elevenlabs/scribe_v2');
    expect(voiceInputProviderModel('elevenlabs-scribe-realtime')).toBe('scribe_v2_realtime');
  });

  it('keeps ASR provider profile metadata complete for future model additions', () => {
    const profiles = getVoiceInputAsrProfiles();
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length);
    for (const profile of profiles) {
      expect(profile.id).toBeTruthy();
      expect(profile.model).toBeTruthy();
      expect(profile.missingCredentialMessage).toBeTruthy();
      expect(profile.errorFallbackMessage).toBeTruthy();
      if (profile.mode === 'realtime-websocket') {
        expect(profile.realtime?.pcmSampleRate).toBeGreaterThan(0);
        expect(profile.realtime?.protocolProfile).toMatch(/^(openai-transcription-manual|qwen-asr-server-vad)$/);
      }
      if (profile.mode === 'provider-native-websocket') {
        expect(profile.nativeWebSocket?.pcmSampleRate).toBeGreaterThan(0);
        expect(profile.nativeWebSocket?.endpointPath).toBeTruthy();
        expect(profile.nativeWebSocket?.resourceId).toBeTruthy();
        expect(profile.nativeWebSocket?.protocolProfile).toBe('volcengine-sauc-duration');
      }
    }
    expect(estimateVoiceInputAsrCostUsd('litellm-qwen3-asr-flash-realtime', 1_000))
      .toBeCloseTo(0.00009, 8);
    expect(estimateVoiceInputAsrCostUsd('litellm-gpt-realtime-whisper', 60_000))
      .toBeCloseTo(0.017, 8);
    expect(estimateVoiceInputAsrCostUsd('elevenlabs-scribe-realtime', 60_000))
      .toBe(0);
  });

  it('keeps refiner profiles configurable without hardcoding one model in call sites', () => {
    expect(DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND).toBe('codex-gpt-5.4-mini');
    expect(resolveVoiceInputRefinerProviderKindAlias('')).toBe('codex-gpt-5.4-mini');
    expect(resolveVoiceInputRefinerProviderKindAlias('litellm')).toBe('litellm-gpt-5.4-mini');
    expect(resolveVoiceInputRefinerProviderKindAlias('qwen/qwen3.6-plus')).toBe('litellm-qwen3.6-plus');
    expect(resolveVoiceInputRefinerProviderKindAlias('unknown')).toBeNull();

    const profiles = getVoiceInputRefinerProfiles();
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length);
    for (const profile of profiles) {
      expect(profile.id).toBeTruthy();
      expect(profile.model).toBeTruthy();
      expect(profile.missingCredentialMessage).toBeTruthy();
      expect(profile.transport).toMatch(/^(codex-responses|litellm-chat-completions)$/);
    }

    const defaultProfile = getVoiceInputRefinerProfile(DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND);
    expect(estimateVoiceInputRefinerCostUsd(defaultProfile, {
      promptTokens: 1_000_000,
      cachedTokens: 500_000,
      completionTokens: 100_000,
    })).toBeCloseTo(0.57, 8);

    const knownCatalogProfile = getVoiceInputRefinerProfile(
      'cat:openai:codex:gpt-5.4-mini' as Parameters<typeof getVoiceInputRefinerProfile>[0],
    );
    expect(knownCatalogProfile.pricing).toEqual(defaultProfile.pricing);
    expect(estimateVoiceInputRefinerCostUsd(knownCatalogProfile, {
      promptTokens: 1_000_000,
      cachedTokens: 500_000,
      completionTokens: 100_000,
    })).toBeCloseTo(0.57, 8);

    const unknownCatalogProfile = getVoiceInputRefinerProfile(
      'cat:xd:codex:deepseek/deepseek-v4-flash' as Parameters<typeof getVoiceInputRefinerProfile>[0],
    );
    expect(unknownCatalogProfile.pricing).toBeUndefined();
  });

  it('uses provider-specific fallback error messages when upstream omits one', () => {
    expect(realtimeErrorMessage({ type: 'error' }, 'XD LiteLLM realtime transcription failed.'))
      .toBe('XD LiteLLM realtime transcription failed.');
    expect(realtimeErrorMessage({ type: 'error', error: { message: 'upstream rejected session' } }, 'fallback'))
      .toBe('upstream rejected session');
    expect(realtimeErrorMessage(
      { type: 'error', error: { message: 'signed_url=https://example.test?token=secret' } },
      'Custom realtime ASR failed.',
      true,
    )).toBe('Custom realtime ASR failed.');
  });

  it('redacts upstream application errors before custom startup rejects', async () => {
    const server = new WebSocketServer({ port: 0 });
    let provider: RealtimeAsrWebSocketProvider | undefined;
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'session.update') {
          socket.send(JSON.stringify({
            type: 'error',
            error: { message: 'signed_url=https://example.test?token=secret' },
          }));
        }
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'test-key',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
        providerKind: 'custom-realtime-asr',
        errorFallbackMessage: 'Custom realtime ASR failed.',
        redactUpstreamErrors: true,
      });
      provider.onEvent(() => {});

      await expect(provider.start()).rejects.toThrow('Custom realtime ASR failed.');
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds provider-specific session update payloads', () => {
    expect(buildSessionUpdateMessage('gpt-realtime-whisper', 'zh-CN')).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: {
              model: 'gpt-realtime-whisper',
              language: 'zh',
            },
            turn_detection: null,
          },
        },
      },
    });

    expect(buildSessionUpdateMessage('qwen3-asr-flash-realtime', 'auto', 16_000, 'qwen-asr-server-vad'))
      .toEqual({
        event_id: expect.any(String),
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_format: 'pcm',
          sample_rate: 16_000,
          input_audio_transcription: {},
          turn_detection: {
            type: 'server_vad',
            threshold: 0.0,
            silence_duration_ms: 400,
          },
        },
      });
  });

  it('fails startup instead of hanging when an OpenAI-compatible realtime socket does not open in time', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        setTimeout(() => done(true), 200);
      },
    });
    const sockets: WebSocket[] = [];
    let provider: RealtimeAsrWebSocketProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'test-token',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'qwen3-asr-flash-realtime',
        protocolProfile: 'qwen-asr-server-vad',
        providerKind: 'litellm-qwen3-asr-flash-realtime',
        connectTimeoutMs: 25,
      });
      provider.onEvent(() => {});

      await expect(provider.start()).rejects.toThrow('Realtime ASR connection timed out after 25ms');
      await sleep(250);

      expect(sockets).toHaveLength(0);
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports OpenAI-compatible realtime handshake failures without waiting for the connect timeout', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        done(false, 403, 'Forbidden');
      },
    });
    let provider: RealtimeAsrWebSocketProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'test-token',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
        protocolProfile: 'openai-transcription-manual',
        providerKind: 'litellm-gpt-realtime-whisper',
        connectTimeoutMs: 2_000,
      });
      provider.onEvent(() => {});

      // The dialed host/path must ride along so a route-level 404/403 can be
      // attributed to the exact gateway address (issue #220 diagnosability).
      await expect(provider.start()).rejects.toThrow(
        `Realtime ASR handshake failed: HTTP 403 Forbidden (127.0.0.1:${address.port}/v1/realtime)`,
      );
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('redacts custom handshake details while preserving the HTTP status for classification', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        done(false, 401, 'token=upstream-secret');
      },
    });
    let provider: RealtimeAsrWebSocketProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'test-key',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
        providerKind: 'custom-realtime-asr',
        errorFallbackMessage: 'Custom realtime ASR failed.',
        redactUpstreamErrors: true,
      });
      provider.onEvent(() => {});

      const error = await provider.start().then(
        () => null,
        (startError: unknown) => startError,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Custom realtime ASR failed. (HTTP 401)');
      expect((error as Error).message).not.toContain('upstream-secret');
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reuse a prewarmed socket across credential cache identities', async () => {
    const server = new WebSocketServer({ port: 0 });
    const authorizations: Array<string | undefined> = [];
    const sockets: WebSocket[] = [];
    let provider: RealtimeAsrWebSocketProvider | undefined;
    server.on('connection', (socket, request) => {
      sockets.push(socket);
      authorizations.push(request.headers.authorization);
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated' }));
        }
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');
      const realtimeUrl = `ws://127.0.0.1:${address.port}/v1/realtime`;

      await prewarmRealtimeAsrWebSocketSession({
        accessTokenProvider: async () => 'old-key',
        credentialCacheKey: 'old-key-hash',
        realtimeUrl,
        model: 'gpt-realtime-whisper',
      });
      await waitFor(() => authorizations.length === 1);

      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'new-key',
        credentialCacheKey: 'new-key-hash',
        realtimeUrl,
        model: 'gpt-realtime-whisper',
      });
      provider.onEvent(() => {});
      await provider.start();

      expect(authorizations).toEqual(['Bearer old-key', 'Bearer new-key']);
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('immediately closes a prewarmed socket when credentials are invalidated', async () => {
    const server = new WebSocketServer({ port: 0 });
    let serverSocket: WebSocket | undefined;
    server.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated' }));
        }
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      await prewarmRealtimeAsrWebSocketSession({
        accessTokenProvider: async () => 'old-key',
        credentialCacheKey: 'old-key-hash',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
      });
      await waitFor(() => serverSocket?.readyState === WebSocket.OPEN);

      invalidatePrewarmedRealtimeAsrWebSocketSession();

      await waitFor(() => serverSocket?.readyState === WebSocket.CLOSED);
    } finally {
      serverSocket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes a prewarmed socket when readiness fails after upgrade', async () => {
    const server = new WebSocketServer({ port: 0 });
    let serverSocket: WebSocket | undefined;
    server.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'session.update') {
          socket.send(JSON.stringify({
            type: 'error',
            error: { message: 'session rejected' },
          }));
        }
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      await prewarmRealtimeAsrWebSocketSession({
        accessTokenProvider: async () => 'test-key',
        credentialCacheKey: 'test-key-revision',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
        errorFallbackMessage: 'Custom realtime ASR failed.',
        redactUpstreamErrors: true,
      });

      await waitFor(() => serverSocket?.readyState === WebSocket.CLOSED);
    } finally {
      serverSocket?.terminate();
      invalidatePrewarmedRealtimeAsrWebSocketSession();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not install a prewarm whose credential lookup finishes after invalidation', async () => {
    const server = new WebSocketServer({ port: 0 });
    let connectionCount = 0;
    server.on('connection', () => {
      connectionCount += 1;
    });
    let resolveAccessToken: ((value: string) => void) | undefined;
    const accessTokenProvider = vi.fn(() => new Promise<string>((resolve) => {
      resolveAccessToken = resolve;
    }));

    try {
      invalidatePrewarmedRealtimeAsrWebSocketSession();
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const prewarm = prewarmRealtimeAsrWebSocketSession({
        accessTokenProvider,
        credentialCacheKey: 'old-credential-revision',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'gpt-realtime-whisper',
      });
      await waitFor(() => accessTokenProvider.mock.calls.length === 1);

      invalidatePrewarmedRealtimeAsrWebSocketSession();
      resolveAccessToken?.('old-key');
      await prewarm;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(connectionCount).toBe(0);
    } finally {
      resolveAccessToken?.('old-key');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reopen a socket after stop while recovery is connecting', async () => {
    let handshakeCount = 0;
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        handshakeCount += 1;
        setTimeout(() => done(true), handshakeCount === 1 ? 0 : 80);
      },
    });
    const sockets: WebSocket[] = [];
    let provider: RealtimeAsrWebSocketProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data) => {
        let message: { type?: string };
        try {
          message = JSON.parse(data.toString()) as { type?: string };
        } catch {
          return;
        }
        if (message.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated' }));
        }
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string }> = [];
      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'test-token',
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'qwen3-asr-flash-realtime',
        protocolProfile: 'qwen-asr-server-vad',
        providerKind: 'litellm-qwen3-asr-flash-realtime',
      });
      provider.onEvent((event) => events.push(event));

      await provider.start();
      await waitFor(() => sockets.length === 1);
      provider.appendAudio(makePcmChunk(), makeTrace(0));
      sockets[0].close(1011, 'WebSocket passthrough error');
      await waitFor(() => events.some((event) => event.type === 'disconnected'));

      const recoverPromise = provider.recover().catch(() => undefined);
      await sleep(10);
      await provider.stop();
      await recoverPromise;
      await sleep(120);

      const connectedAfterStop = events.slice(1).some((event) => event.type === 'connected');
      expect(connectedAfterStop).toBe(false);
      expect(sockets.every((socket) => socket.readyState === 2 || socket.readyState === 3)).toBe(true);
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not open a managed socket when stopped during session allocation', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    server.on('connection', (socket) => sockets.push(socket));
    let allocationStarted = false;
    let releaseAllocation: ((value: { websocketUrl: string; authorizationToken: string }) => void) | undefined;
    const connectionProvider = vi.fn(() => new Promise<{ websocketUrl: string; authorizationToken: string }>((resolve) => {
      allocationStarted = true;
      releaseAllocation = resolve;
    }));
    let provider: RealtimeAsrWebSocketProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');
      provider = new RealtimeAsrWebSocketProvider({
        accessTokenProvider: async () => 'unused',
        connectionProvider,
        realtimeUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        model: 'qwen3-asr-flash-realtime',
        protocolProfile: 'qwen-asr-server-vad',
        providerKind: 'managed-qwen3-asr-flash-realtime',
      });

      const started = provider.start();
      await waitFor(() => allocationStarted);
      await provider.stop();
      releaseAllocation?.({
        websocketUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
        authorizationToken: 'stale-ticket',
      });

      await expect(started).rejects.toThrow('stopped');
      expect(sockets).toHaveLength(0);
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function makePcmChunk(): ArrayBuffer {
  const buffer = new ArrayBuffer(320);
  new Int16Array(buffer).fill(256);
  return buffer;
}

function makeTrace(chunkIndex: number) {
  return {
    capturedAt: Date.now(),
    convertedAt: Date.now(),
    chunkIndex,
    sampleRate: 16_000,
    durationMs: 10,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
