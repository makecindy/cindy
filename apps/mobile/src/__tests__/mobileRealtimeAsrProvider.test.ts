import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';
import { i18n } from '@/i18n';

const GW_PROXY = `${DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL}/proxy`;
const GW_PROXY_WSS = GW_PROXY.replace(/^https/, 'wss');
import { gzip } from 'pako';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import {
  MobileRealtimeAsrProvider,
  MobileVolcengineSaucAsrProvider,
  buildSessionUpdateMessage,
  createMobileAsrProvider,
} from '@/session/mobileRealtimeAsrProvider';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string; error?: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[] | null,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  rawMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

async function waitForFakeSocketCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (FakeSocket.instances.length >= count) return;
    await Promise.resolve();
  }
}

function volcengineTranscriptPacket(text: string, definite = false): ArrayBuffer {
  const payload = gzip(JSON.stringify({
    result: {
      text,
      ...(definite ? { definite: true } : {}),
    },
  }));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, payload.length, false);
  const packet = new Uint8Array(8 + payload.length);
  packet.set([0x11, 0x90, 0x11, 0x00], 0);
  packet.set(size, 4);
  packet.set(payload, 8);
  return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
}

function trace(chunkIndex: number, durationMs = 120): {
  capturedAt: number;
  convertedAt: number;
  chunkIndex: number;
  sampleRate: number;
  durationMs: number;
} {
  return {
    capturedAt: chunkIndex,
    convertedAt: chunkIndex + 1,
    chunkIndex,
    sampleRate: 16000,
    durationMs,
  };
}

function credential(overrides: Partial<StoredMobileVoiceCredential> = {}): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: GW_PROXY,
    proxyApiKey: 'sk-mobile-voice',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-06-19T00:01:00.000Z',
    asr: {
      provider: 'litellm-gpt-realtime-whisper',
      model: 'gpt-realtime-whisper',
      auth: 'api-key',
      mode: 'realtime-websocket',
      endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      pcmSampleRate: 24000,
      protocolProfile: 'openai-transcription-manual',
      litellmHeaderModel: 'gpt-realtime-whisper',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
    ...overrides,
  };
}

// 托管票据建连:direct-dial(credential key 直拨上游)已删除,测试用一个从
// credential 派生等价 URL/token 的 connectionProvider 模拟 voice-server 票据。
function managedWsUrl(cred: StoredMobileVoiceCredential): string {
  const base = new URL(cred.proxyBaseUrl);
  const endpoint = new URL(cred.asr.endpointPath ?? '', 'https://placeholder.invalid');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${endpoint.pathname}`;
  base.search = endpoint.search;
  base.protocol = base.protocol === 'http:' ? 'ws:' : 'wss:';
  return base.toString();
}

function managedConnection(cred: StoredMobileVoiceCredential): () => Promise<{
  websocketUrl: string;
  authorizationToken: string;
}> {
  return async () => ({
    websocketUrl: managedWsUrl(cred),
    authorizationToken: cred.proxyApiKey,
  });
}

function managedChainConnection(cred: StoredMobileVoiceCredential): (providerId: string) => Promise<{
  websocketUrl: string;
  authorizationToken: string;
}> {
  return async (providerId: string) => {
    const asr = (cred.asrProviderChain ?? [cred.asr]).find((item) => item.provider === providerId) ?? cred.asr;
    return {
      websocketUrl: managedWsUrl({ ...cred, asr }),
      authorizationToken: cred.proxyApiKey,
    };
  };
}

type RealtimeProviderOptions = ConstructorParameters<typeof MobileRealtimeAsrProvider>[0];
function realtimeProvider(options: RealtimeProviderOptions): MobileRealtimeAsrProvider {
  return new MobileRealtimeAsrProvider({
    connectionProvider: managedConnection(options.credential),
    ...options,
  });
}

type VolcengineProviderOptions = ConstructorParameters<typeof MobileVolcengineSaucAsrProvider>[0];
function volcengineProvider(options: VolcengineProviderOptions): MobileVolcengineSaucAsrProvider {
  return new MobileVolcengineSaucAsrProvider({
    connectionProvider: managedConnection(options.credential),
    ...options,
  });
}

describe('mobileRealtimeAsrProvider', () => {
  it('cancels an in-flight fallback candidate before it can open a managed socket', async () => {
    FakeSocket.instances = [];
    let resolveConnection: ((value: { websocketUrl: string; authorizationToken: string }) => void) | undefined;
    const connectionProvider = vi.fn(() => new Promise<{ websocketUrl: string; authorizationToken: string }>((resolve) => {
      resolveConnection = resolve;
    }));
    const provider = createMobileAsrProvider(credential({
      asrProviderChain: [
        credential().asr,
        { ...credential().asr, provider: 'fallback-asr' },
      ],
    }), {
      connectionProvider,
      websocketFactory: FakeSocket,
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    await Promise.resolve();
    expect(connectionProvider).toHaveBeenCalledTimes(1);

    await provider.stop();
    resolveConnection?.({
      websocketUrl: 'wss://voice.example.com/api/voice/asr?ticket=stale',
      authorizationToken: 'stale',
    });

    await expect(started).rejects.toThrow('stopped');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(connectionProvider).toHaveBeenCalledTimes(1);
  });

  it('builds desktop-compatible OpenAI transcription session updates', () => {
    expect(buildSessionUpdateMessage(
      'gpt-realtime-whisper',
      'zh-CN',
      24000,
      'openai-transcription-manual',
    )).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: {
              model: 'gpt-realtime-whisper',
              language: 'zh',
            },
            turn_detection: null,
          },
        },
      },
    });
    expect(buildSessionUpdateMessage(
      'gpt-realtime-whisper',
      'Japanese',
      24000,
      'openai-transcription-manual',
    )).toMatchObject({
      session: {
        audio: {
          input: {
            transcription: {
              language: 'ja',
            },
          },
        },
      },
    });
  });

  it('streams PCM chunks into OpenAI-compatible realtime ASR and emits draft/stable text', async () => {
    FakeSocket.instances = [];
    const events: string[] = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'partial' || event.type === 'stable' || event.type === 'connected') {
        events.push(event.type === 'connected' ? 'connected' : `${event.type}:${event.text}`);
      }
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({ type: 'session.updated' });
    await started;

    expect(socket.url).toBe(`${GW_PROXY_WSS}/openai/passthrough/v1/realtime?intent=transcription`);
    expect(socket.options?.headers).toEqual({
      Authorization: 'Bearer sk-mobile-voice',
    });
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: { type: 'transcription' },
    });

    provider.appendAudio(new Uint8Array([1, 2, 3, 4]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });
    expect(socket.sent[1]).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AQIDBA==',
    });

    socket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'hello',
    });
    const flushed = provider.flushAudio();
    expect(socket.sent[2]).toEqual({ type: 'input_audio_buffer.commit' });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'hello world',
    });
    await flushed;

    expect(events).toEqual([
      'connected',
      'partial:hello',
      'stable:hello world',
    ]);
  });

  it('queues OpenAI-compatible PCM chunks until the realtime session is ready', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    provider.appendAudio(new Uint8Array([1, 2, 3, 4]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });

    expect(socket.sent).toHaveLength(1);
    socket.message({ type: 'session.updated' });
    await started;

    expect(socket.sent[1]).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AQIDBA==',
    });
  });

  it('stops OpenAI-compatible realtime ASR immediately while connect is waiting for session readiness', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: 'session.update' });

    const startRejection = expect(started).rejects.toThrow('Realtime ASR connection stopped.');
    await provider.stop();
    await startRejection;

    expect(socket.readyState).toBe(3);
  });

  it('does not open managed realtime ASR after stop while session allocation is pending', async () => {
    FakeSocket.instances = [];
    let resolveConnection!: (connection: { websocketUrl: string; authorizationToken: string }) => void;
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      connectionProvider: () => new Promise((resolve) => { resolveConnection = resolve; }),
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    await provider.stop();
    resolveConnection({ websocketUrl: 'wss://voice.example.com/asr', authorizationToken: 'ticket' });

    await expect(started).rejects.toThrow('Realtime ASR connection stopped.');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('recovers OpenAI-compatible realtime ASR by replaying unconfirmed audio', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    provider.appendAudio(new Uint8Array([3, 4]).buffer, {
      capturedAt: 3,
      convertedAt: 4,
      chunkIndex: 2,
      sampleRate: 24000,
      durationMs: 120,
    });
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ type: 'session.updated' });
    await recovered;

    expect(firstSocket.sent[1]).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AQI=',
    });
    expect(secondSocket.sent.slice(1)).toEqual([
      {
        type: 'input_audio_buffer.append',
        audio: 'AQI=',
      },
      {
        type: 'input_audio_buffer.append',
        audio: 'AwQ=',
      },
    ]);
  });

  it('rejects OpenAI-compatible recovery when replay audio cannot be sent', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ type: 'session.updated' });
    secondSocket.close();

    await expect(recovered).rejects.toThrow('Realtime ASR recovery replay failed.');
  });

  it('lets recovered OpenAI-compatible replay replace the interrupted partial item', async () => {
    FakeSocket.instances = [];
    const events: string[] = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'partial') events.push(event.text);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });
    firstSocket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'interrupted-item',
      delta: 'helo',
    });

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ type: 'session.updated' });
    await recovered;
    secondSocket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'replayed-item',
      delta: 'hello world',
    });

    expect(events).toEqual(['helo', 'hello world']);
  });

  it('keeps partial-only OpenAI-compatible audio in the replay buffer until completion', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential(),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 24000,
        durationMs: 120,
      });
      vi.advanceTimersByTime(2_000);
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'partial-only-item',
        delta: 'hello',
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        {
          type: 'input_audio_buffer.append',
          audio: 'AQI=',
        },
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps long partial-only OpenAI-compatible audio without evicting replay audio', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential(),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 24000,
        durationMs: 60_000,
      });
      vi.advanceTimersByTime(60_001);
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'long-partial-item',
        delta: 'long dictation',
      });
      provider.appendAudio(new Uint8Array([3, 4]).buffer, {
        capturedAt: 60_002,
        convertedAt: 60_003,
        chunkIndex: 2,
        sampleRate: 24000,
        durationMs: 120,
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        {
          type: 'input_audio_buffer.append',
          audio: 'AQI=',
        },
        {
          type: 'input_audio_buffer.append',
          audio: 'AwQ=',
        },
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops finalized OpenAI-compatible audio before recovery replay', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });

    const flushed = provider.flushAudio();
    expect(firstSocket.sent[2]).toEqual({ type: 'input_audio_buffer.commit' });
    firstSocket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'finalized-item',
      transcript: 'hello world',
    });
    await flushed;

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ type: 'session.updated' });
    await recovered;

    expect(secondSocket.sent.slice(1)).toEqual([]);
  });

  it('keeps later unfinalized OpenAI-compatible commits in the replay buffer', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 24000,
      durationMs: 120,
    });
    const firstFlush = provider.flushAudio();
    expect(firstSocket.sent[2]).toEqual({ type: 'input_audio_buffer.commit' });
    firstSocket.message({
      type: 'input_audio_buffer.committed',
      item_id: 'item-1',
    });

    provider.appendAudio(new Uint8Array([3, 4]).buffer, {
      capturedAt: 3,
      convertedAt: 4,
      chunkIndex: 2,
      sampleRate: 24000,
      durationMs: 120,
    });
    const secondFlush = provider.flushAudio();
    expect(firstSocket.sent[4]).toEqual({ type: 'input_audio_buffer.commit' });
    firstSocket.message({
      type: 'input_audio_buffer.committed',
      item_id: 'item-2',
    });
    firstSocket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'hello',
    });

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ type: 'session.updated' });
    await recovered;
    await Promise.all([firstFlush, secondFlush]);

    expect(secondSocket.sent.slice(1)).toEqual([
      {
        type: 'input_audio_buffer.append',
        audio: 'AwQ=',
      },
    ]);
  });

  it('does not reject OpenAI-compatible flush when stop cancels an in-flight recovery', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ type: 'session.updated' });
    await started;

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const flushed = provider.flushAudio();
    const stopped = provider.stop();

    await expect(flushed).resolves.toBeUndefined();
    await stopped;
    await recovered.catch(() => undefined);
  });

  it('redacts the synced voice key from OpenAI-compatible realtime ASR errors', async () => {
    FakeSocket.instances = [];
    const errors: string[] = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'error') errors.push(event.message);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({ type: 'session.updated' });
    await started;

    socket.message({
      type: 'error',
      error: { message: 'upstream rejected Authorization Bearer sk-mobile-voice' },
    });

    expect(errors).toEqual(['upstream rejected Authorization Bearer [REDACTED]']);
  });

  it('falls back to the next synced desktop ASR provider when the primary cannot start', async () => {
    FakeSocket.instances = [];
    const fallbackCredential = credential({
      asr: {
        provider: 'litellm-gpt-realtime-whisper',
        model: 'gpt-realtime-whisper',
        auth: 'api-key',
        mode: 'realtime-websocket',
        endpointPath: '/openai/passthrough/v1/realtime?intent=transcription&primary=1',
        pcmSampleRate: 24000,
        protocolProfile: 'openai-transcription-manual',
        litellmHeaderModel: 'gpt-realtime-whisper',
      },
      asrProviderChain: [
        {
          provider: 'litellm-gpt-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/openai/passthrough/v1/realtime?intent=transcription&primary=1',
          pcmSampleRate: 24000,
          protocolProfile: 'openai-transcription-manual',
          litellmHeaderModel: 'gpt-realtime-whisper',
        },
        {
          provider: 'litellm-qwen3-asr-flash-realtime',
          model: 'qwen3-asr-flash-realtime',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
          pcmSampleRate: 16000,
          protocolProfile: 'qwen-asr-server-vad',
        },
      ],
    });
    const provider = createMobileAsrProvider(fallbackCredential, {
      connectionProvider: managedChainConnection(fallbackCredential),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    const events: string[] = [];
    provider.onEvent((event) => {
      if (event.type === 'partial') events.push(`partial:${event.text}`);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const primarySocket = FakeSocket.instances[0];
    primarySocket.onerror?.({ message: 'primary unavailable' });
    await waitForFakeSocketCount(2);
    const fallbackSocket = FakeSocket.instances[1];
    fallbackSocket.open();
    fallbackSocket.message({ type: 'session.updated' });
    await started;
    fallbackSocket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'fallback-item',
      delta: 'fallback text',
    });

    expect(primarySocket.url).toContain('primary=1');
    expect(fallbackSocket.url).toBe(`${GW_PROXY_WSS}/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`);
    expect(fallbackSocket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
      },
    });
    expect(events).toEqual(['partial:fallback text']);
  });

  it('uses the websocket close status when a generic RN connect error is followed by 403', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential(),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.onerror?.({});
    socket.onclose?.({
      code: 1006,
      reason: 'Received bad response code from server: 403.',
    });

    await expect(started).rejects.toThrow('Cindy 语音会话已失效或没有权限（WebSocket 403）。请确认登录状态后重试。');
  });

  it('redacts the synced voice key from Volcengine websocket errors', async () => {
    FakeSocket.instances = [];
    const volcCredential = credential({
      asr: {
        provider: 'litellm-volcengine-sauc-asr',
        model: 'volcengine-sauc-asr',
        auth: 'api-key',
        mode: 'provider-native-websocket',
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        pcmSampleRate: 16000,
        protocolProfile: 'volcengine-sauc-duration',
        resourceId: 'volc.seedasr.sauc.duration',
      },
    });
    const provider = createMobileAsrProvider(volcCredential, {
      connectionProvider: managedChainConnection(volcCredential),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    const errors: string[] = [];
    provider.onEvent((event) => {
      if (event.type === 'error') errors.push(event.message);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    await started;
    socket.onerror?.({ message: 'Volcengine rejected Bearer sk-mobile-voice' });

    expect(errors).toEqual(['Volcengine rejected Bearer [REDACTED]']);
  });

  it('uses server-VAD session.finish for Qwen realtime ASR profiles', async () => {
    FakeSocket.instances = [];
    const provider = realtimeProvider({
      credential: credential({
        asr: {
          provider: 'litellm-qwen3-asr-flash-realtime',
          model: 'qwen3-asr-flash-realtime',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
          pcmSampleRate: 16000,
          protocolProfile: 'qwen-asr-server-vad',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({ type: 'session.updated' });
    await started;

    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        turn_detection: { type: 'server_vad' },
      },
    });
    provider.appendAudio(new Uint8Array([1, 2]).buffer, {
      capturedAt: 1,
      convertedAt: 2,
      chunkIndex: 1,
      sampleRate: 16000,
      durationMs: 120,
    });
    const flushed = provider.flushAudio();
    expect(socket.sent[2]).toMatchObject({ type: 'session.finish' });
    socket.message({ type: 'session.finished' });
    await flushed;
  });

  it('keeps later Qwen server-VAD audio when an earlier item completes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential({
          asr: {
            provider: 'litellm-qwen3-asr-flash-realtime',
            model: 'qwen3-asr-flash-realtime',
            auth: 'api-key',
            mode: 'realtime-websocket',
            endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
            pcmSampleRate: 16000,
            protocolProfile: 'qwen-asr-server-vad',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 16000,
        durationMs: 120,
      });
      vi.advanceTimersByTime(2_000);
      provider.appendAudio(new Uint8Array([3, 4]).buffer, {
        capturedAt: 3,
        convertedAt: 4,
        chunkIndex: 2,
        sampleRate: 16000,
        durationMs: 120,
      });
      firstSocket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'qwen-item-1',
      });
      vi.advanceTimersByTime(2_000);
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'qwen-item-1',
        transcript: 'hello',
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        expect.objectContaining({
          type: 'input_audio_buffer.append',
          audio: 'AwQ=',
        }),
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops finalized unbound Qwen server-VAD audio while keeping later audio', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential({
          asr: {
            provider: 'litellm-qwen3-asr-flash-realtime',
            model: 'qwen3-asr-flash-realtime',
            auth: 'api-key',
            mode: 'realtime-websocket',
            endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
            pcmSampleRate: 16000,
            protocolProfile: 'qwen-asr-server-vad',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 16000,
        durationMs: 120,
      });
      firstSocket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'qwen-short-item',
      });
      vi.advanceTimersByTime(1);
      provider.appendAudio(new Uint8Array([3, 4]).buffer, {
        capturedAt: 3,
        convertedAt: 4,
        chunkIndex: 2,
        sampleRate: 16000,
        durationMs: 120,
      });
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'qwen-short-item',
        transcript: 'hello',
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        expect.objectContaining({
          type: 'input_audio_buffer.append',
          audio: 'AwQ=',
        }),
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves next Qwen utterance audio when a short unbound commit arrives late', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential({
          asr: {
            provider: 'litellm-qwen3-asr-flash-realtime',
            model: 'qwen3-asr-flash-realtime',
            auth: 'api-key',
            mode: 'realtime-websocket',
            endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
            pcmSampleRate: 16000,
            protocolProfile: 'qwen-asr-server-vad',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 16000,
        durationMs: 120,
      });
      vi.advanceTimersByTime(500);
      provider.appendAudio(new Uint8Array([0, 0]).buffer, {
        capturedAt: 2,
        convertedAt: 3,
        chunkIndex: 2,
        sampleRate: 16000,
        durationMs: 500,
      });
      vi.advanceTimersByTime(1);
      provider.appendAudio(new Uint8Array([3, 4]).buffer, {
        capturedAt: 4,
        convertedAt: 5,
        chunkIndex: 3,
        sampleRate: 16000,
        durationMs: 120,
      });
      firstSocket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'qwen-short-item',
      });
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'qwen-short-item',
        transcript: 'hello',
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        expect.objectContaining({
          type: 'input_audio_buffer.append',
          audio: 'AwQ=',
        }),
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps next Qwen turn audio when a delayed bound commit crosses the retention window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = realtimeProvider({
        credential: credential({
          asr: {
            provider: 'litellm-qwen3-asr-flash-realtime',
            model: 'qwen3-asr-flash-realtime',
            auth: 'api-key',
            mode: 'realtime-websocket',
            endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
            pcmSampleRate: 16000,
            protocolProfile: 'qwen-asr-server-vad',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      firstSocket.message({ type: 'session.updated' });
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
      vi.advanceTimersByTime(500);
      provider.appendAudio(new Uint8Array([0, 0]).buffer, trace(2, 500));
      vi.advanceTimersByTime(1);
      provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(3));
      vi.advanceTimersByTime(2_000);
      firstSocket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'qwen-delayed-item',
      });
      firstSocket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'qwen-delayed-item',
        transcript: 'hello',
      });

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      secondSocket.message({ type: 'session.updated' });
      await recovered;

      expect(secondSocket.sent.slice(1)).toEqual([
        expect.objectContaining({
          type: 'input_audio_buffer.append',
          audio: 'AwQ=',
        }),
      ]);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a Volcengine provider for the desktop default provider-native ASR profile', async () => {
    FakeSocket.instances = [];
    const volcCredential = credential({
      asr: {
        provider: 'litellm-volcengine-sauc-asr',
        model: 'volcengine-sauc-asr',
        auth: 'api-key',
        mode: 'provider-native-websocket',
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        pcmSampleRate: 16000,
        protocolProfile: 'volcengine-sauc-duration',
        resourceId: 'volc.seedasr.sauc.duration',
      },
    });
    const provider = createMobileAsrProvider(volcCredential, {
      connectionProvider: managedChainConnection(volcCredential),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    socket.open();
    await started;

    expect(provider).toBeInstanceOf(MobileVolcengineSaucAsrProvider);
    expect(socket.url).toBe(`${GW_PROXY_WSS}/volcengine/api/v3/sauc/bigmodel_async`);
    expect(socket.options?.headers).toMatchObject({
      Authorization: 'Bearer sk-mobile-voice',
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
    });
    expect(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
  });

  it('stops Volcengine ASR immediately while connect is pending', async () => {
    FakeSocket.instances = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const socket = FakeSocket.instances[0];
    const startRejection = expect(started).rejects.toThrow('Volcengine SAUC ASR connection stopped.');
    await provider.stop();
    await startRejection;

    expect(socket.readyState).toBe(3);
  });

  it('does not reject Volcengine flush when stop cancels an in-flight recovery', async () => {
    FakeSocket.instances = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const flushed = provider.flushAudio();
    const stopped = provider.stop();

    await expect(flushed).resolves.toBeUndefined();
    await stopped;
    await recovered.catch(() => undefined);
  });

  it('recovers Volcengine ASR by replaying audio and preserving the finalized transcript prefix', async () => {
    FakeSocket.instances = [];
    const events: string[] = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'partial' || event.type === 'stable') events.push(event.text);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
    provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(2));
    firstSocket.rawMessage(volcengineTranscriptPacket('你好，今天', true));

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    provider.appendAudio(new Uint8Array([5, 6]).buffer, trace(3));
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    await recovered;
    secondSocket.rawMessage(volcengineTranscriptPacket('今天小镇周会'));

    expect(events).toContain('你好，今天');
    expect(events).toContain('你好，今天小镇周会');
    expect(secondSocket.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(secondSocket.sent.slice(1)).toHaveLength(1);
  });

  it('drops definite Volcengine audio before recovery replay', async () => {
    FakeSocket.instances = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
    provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(2));
    firstSocket.rawMessage(volcengineTranscriptPacket('你好，今天', true));

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    await recovered;

    expect(secondSocket.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(secondSocket.sent.slice(1)).toEqual([]);
  });

  it('rejects Volcengine recovery when replay audio cannot be sent', async () => {
    FakeSocket.instances = [];
    class ClosingAfterFirstReplaySocket extends FakeSocket {
      send(data: string | ArrayBuffer): void {
        super.send(data);
        if (FakeSocket.instances[1] === this && this.sent.length === 2) this.close();
      }
    }
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: ClosingAfterFirstReplaySocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent(() => {});

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
    provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(2));

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();

    await expect(recovered).rejects.toThrow('Volcengine SAUC ASR recovery replay failed.');
  });

  it('keeps partial-only Volcengine audio in the replay buffer until definite', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = volcengineProvider({
        credential: credential({
          asr: {
            provider: 'litellm-volcengine-sauc-asr',
            model: 'volcengine-sauc-asr',
            auth: 'api-key',
            mode: 'provider-native-websocket',
            endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
            pcmSampleRate: 16000,
            protocolProfile: 'volcengine-sauc-duration',
            resourceId: 'volc.seedasr.sauc.duration',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
      provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(2));
      vi.advanceTimersByTime(2_000);
      firstSocket.rawMessage(volcengineTranscriptPacket('你好，今天'));

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      await recovered;

      expect(secondSocket.sent[0]).toBeInstanceOf(ArrayBuffer);
      expect(secondSocket.sent.slice(1)).toHaveLength(2);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps long partial-only Volcengine audio without evicting replay audio', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = volcengineProvider({
        credential: credential({
          asr: {
            provider: 'litellm-volcengine-sauc-asr',
            model: 'volcengine-sauc-asr',
            auth: 'api-key',
            mode: 'provider-native-websocket',
            endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
            pcmSampleRate: 16000,
            protocolProfile: 'volcengine-sauc-duration',
            resourceId: 'volc.seedasr.sauc.duration',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1, 60_000));
      vi.advanceTimersByTime(60_001);
      firstSocket.rawMessage(volcengineTranscriptPacket('长语音前半段'));
      provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(2));

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      await recovered;

      expect(secondSocket.sent[0]).toBeInstanceOf(ArrayBuffer);
      expect(secondSocket.sent.slice(1)).toHaveLength(2);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves later Volcengine utterance audio when an earlier definite response arrives late', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
      FakeSocket.instances = [];
      const provider = volcengineProvider({
        credential: credential({
          asr: {
            provider: 'litellm-volcengine-sauc-asr',
            model: 'volcengine-sauc-asr',
            auth: 'api-key',
            mode: 'provider-native-websocket',
            endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
            pcmSampleRate: 16000,
            protocolProfile: 'volcengine-sauc-duration',
            resourceId: 'volc.seedasr.sauc.duration',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent(() => {});

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      await started;
      provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
      vi.advanceTimersByTime(500);
      provider.appendAudio(new Uint8Array([0, 0]).buffer, trace(2, 300));
      vi.advanceTimersByTime(1);
      provider.appendAudio(new Uint8Array([3, 4]).buffer, trace(3));
      vi.advanceTimersByTime(2_000);
      provider.appendAudio(new Uint8Array([5, 6]).buffer, trace(4));
      firstSocket.rawMessage(volcengineTranscriptPacket('你好，今天', true));

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      await recovered;

      expect(secondSocket.sent[0]).toBeInstanceOf(ArrayBuffer);
      expect(secondSocket.sent.slice(1)).toHaveLength(2);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets recovered Volcengine replay replace partial-only transcript prefixes', async () => {
    FakeSocket.instances = [];
    const events: string[] = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'partial' || event.type === 'stable') events.push(event.text);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;
    provider.appendAudio(new Uint8Array([1, 2]).buffer, trace(1));
    firstSocket.rawMessage(volcengineTranscriptPacket('yellow'));

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    await recovered;
    secondSocket.rawMessage(volcengineTranscriptPacket('hello world'));

    expect(events).toContain('yellow');
    expect(events).toContain('hello world');
    expect(events).not.toContain('yellowhello world');
  });

  it('deduplicates single-character overlap in recovered Volcengine transcripts', async () => {
    FakeSocket.instances = [];
    const events: string[] = [];
    const provider = volcengineProvider({
      credential: credential({
        asr: {
          provider: 'litellm-volcengine-sauc-asr',
          model: 'volcengine-sauc-asr',
          auth: 'api-key',
          mode: 'provider-native-websocket',
          endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
          pcmSampleRate: 16000,
          protocolProfile: 'volcengine-sauc-duration',
          resourceId: 'volc.seedasr.sauc.duration',
        },
      }),
      websocketFactory: FakeSocket,
      flushTimeoutMs: 10,
    });
    provider.onEvent((event) => {
      if (event.type === 'partial' || event.type === 'stable') events.push(event.text);
    });

    const started = provider.start();
    await waitForFakeSocketCount(1);
    const firstSocket = FakeSocket.instances[0];
    firstSocket.open();
    await started;
    firstSocket.rawMessage(volcengineTranscriptPacket('你好', true));

    const recovered = provider.recover();
    await waitForFakeSocketCount(2);
    const secondSocket = FakeSocket.instances[1];
    secondSocket.open();
    await recovered;
    secondSocket.rawMessage(volcengineTranscriptPacket('好世界'));

    expect(events).toContain('你好世界');
  });

  it('handles ASCII overlaps at recovered Volcengine word boundaries', async () => {
    const runScenario = async (
      prefix: string,
      transcript: string,
      expected: string,
      corrupted: string,
    ): Promise<void> => {
      FakeSocket.instances = [];
      const events: string[] = [];
      const provider = volcengineProvider({
        credential: credential({
          asr: {
            provider: 'litellm-volcengine-sauc-asr',
            model: 'volcengine-sauc-asr',
            auth: 'api-key',
            mode: 'provider-native-websocket',
            endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
            pcmSampleRate: 16000,
            protocolProfile: 'volcengine-sauc-duration',
            resourceId: 'volc.seedasr.sauc.duration',
          },
        }),
        websocketFactory: FakeSocket,
        flushTimeoutMs: 10,
      });
      provider.onEvent((event) => {
        if (event.type === 'partial' || event.type === 'stable') events.push(event.text);
      });

      const started = provider.start();
      await waitForFakeSocketCount(1);
      const firstSocket = FakeSocket.instances[0];
      firstSocket.open();
      await started;
      firstSocket.rawMessage(volcengineTranscriptPacket(prefix, true));

      const recovered = provider.recover();
      await waitForFakeSocketCount(2);
      const secondSocket = FakeSocket.instances[1];
      secondSocket.open();
      await recovered;
      secondSocket.rawMessage(volcengineTranscriptPacket(transcript));

      expect(events).toContain(expected);
      expect(events).not.toContain(corrupted);
      await provider.stop();
    };

    await runScenario('I am', 'amazing work', 'I am amazing work', 'I amazing work');
    await runScenario('we can', 'cancel', 'we can cancel', 'we cancel');
    await runScenario('hello', 'hello world', 'hello world', 'hello hello world');
    await runScenario('hello', 'hello', 'hello', 'hello hello');
  });
});
