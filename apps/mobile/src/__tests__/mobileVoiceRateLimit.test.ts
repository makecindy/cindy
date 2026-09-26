import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
  deleteSecureItem: vi.fn(async () => undefined),
}));
vi.mock('@/session/mobileRealtimeAudio', () => ({
  startMobileRealtimeAudio: vi.fn(),
}));

import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';
import { ApiError } from '@/api/client';
import { i18n } from '@/i18n';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { createMobileAsrProvider } from '@/session/mobileRealtimeAsrProvider';
import { createMobileVoiceControllerSession } from '@/session/mobileVoiceController';
import { isMobileVoiceRateLimited } from '@/session/mobileVoiceInput';

const rateLimited = () => new ApiError('RATE_LIMITED', 429, 'Too many requests');
const RATE_LIMITED_TEXT = '语音请求过于频繁，请稍后重试。';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const volcAsr = (provider: string): StoredMobileVoiceCredential['asr'] => ({
  provider,
  model: 'volcengine-sauc-asr',
  auth: 'api-key',
  mode: 'provider-native-websocket',
  endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
  pcmSampleRate: 16_000,
  protocolProfile: 'volcengine-sauc-duration',
  resourceId: 'volc.seedasr.sauc.duration',
});

// A managed-style credential: several ASR candidates behind one account.
function managedCredential(): StoredMobileVoiceCredential {
  const chain = [volcAsr('managed-asr-a'), volcAsr('managed-asr-b'), volcAsr('managed-asr-c')];
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-09-26T00:00:00.000Z',
    proxyBaseUrl: 'https://voice.example.test/proxy',
    proxyApiKey: '',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-09-26T00:01:00.000Z',
    asr: chain[0],
    asrProviderChain: chain,
    refiner: {
      provider: 'managed-refiner',
      model: 'auto',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
  };
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

async function startAudibleAudio({
  onChunk,
}: {
  onChunk: (chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void;
}): Promise<() => Promise<void>> {
  onChunk({
    pcm16: new Int16Array(160).fill(1000).buffer,
    trace: { capturedAt: 1, convertedAt: 2, chunkIndex: 1, sampleRate: 16000, durationMs: 10 },
  });
  return async () => undefined;
}

class ScriptedAsr implements AsrProvider {
  private callback: (event: AsrEvent) => void = () => {};
  recover?: () => Promise<void>;
  constructor(private readonly startError?: unknown) {}
  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.callback({ type: 'connected', at: Date.now() });
  }
  async stop(): Promise<void> {}
  appendAudio(): void {}
  async flushAudio(): Promise<void> {}
  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }
  emit(event: AsrEvent): void {
    this.callback(event);
  }
}

describe('mobile voice account rate limit', () => {
  it('recognizes only the structured 429 RATE_LIMITED error', () => {
    expect(isMobileVoiceRateLimited(rateLimited())).toBe(true);
    expect(isMobileVoiceRateLimited(new ApiError('RATE_LIMITED', 503, 'x'))).toBe(false);
    expect(isMobileVoiceRateLimited(new ApiError('UPSTREAM_ERROR', 429, 'x'))).toBe(false);
    expect(isMobileVoiceRateLimited(new Error('RATE_LIMITED 429'))).toBe(false);
  });

  it('stops switching managed ASR candidates on an account rate limit', async () => {
    const connectionProvider = vi.fn(async () => {
      throw rateLimited();
    });
    const provider = createMobileAsrProvider(managedCredential(), {
      connectionProvider,
      websocketFactory: FakeSocket as never,
    });
    await expect(provider.start()).rejects.toSatisfy(isMobileVoiceRateLimited);
    expect(connectionProvider).toHaveBeenCalledTimes(1);
  });

  it('still tries the next candidate for other session failures', async () => {
    const credential = managedCredential();
    const connectionProvider = vi.fn(async () => {
      throw new ApiError('UPSTREAM_ERROR', 502, 'Bad gateway');
    });
    const provider = createMobileAsrProvider(credential, {
      connectionProvider,
      websocketFactory: FakeSocket as never,
    });
    await expect(provider.start()).rejects.toThrow('Bad gateway');
    expect(connectionProvider).toHaveBeenCalledTimes(credential.asrProviderChain!.length);
  });

  it('reports a start-time account limit with the localized retry message', async () => {
    const session = createMobileVoiceControllerSession({
      credential: managedCredential(),
      initialDraft: '',
      asr: new ScriptedAsr(rateLimited()),
      refiner: null,
      startAudio: startAudibleAudio,
      onDraftChanged: () => {},
    });
    await expect(session.start()).rejects.toThrow(RATE_LIMITED_TEXT);
  });

  it('reports a recovery account limit instead of the generic stalled message', async () => {
    const errors: string[] = [];
    const asr = new ScriptedAsr();
    asr.recover = async () => {
      throw rateLimited();
    };
    const session = createMobileVoiceControllerSession({
      credential: managedCredential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: startAudibleAudio,
      onDraftChanged: () => {},
      onError: (message) => errors.push(message),
    });
    await session.start();
    asr.emit({ type: 'disconnected', at: Date.now() });
    await vi.waitFor(() => expect(errors).toEqual([RATE_LIMITED_TEXT]));
  });
});
