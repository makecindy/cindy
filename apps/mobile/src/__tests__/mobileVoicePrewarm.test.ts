import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';

const prewarmMobileRealtimeAudio = vi.fn();
const createProvider = vi.fn();

vi.mock('@/session/mobileRealtimeAudio', () => ({
  prewarmMobileRealtimeAudio: (...args: unknown[]) => prewarmMobileRealtimeAudio(...args),
}));
vi.mock('@/session/mobileRealtimeAsrProvider', () => ({
  createMobileAsrProvider: (...args: unknown[]) => createProvider(...args),
}));
const createCindyCredential = vi.fn();
vi.mock('@/session/mobileCindyVoiceSession', () => ({
  CINDY_MANAGED_REFINER_PROVIDER: 'auto',
  createMobileCindyVoiceCredential: (...args: unknown[]) => createCindyCredential(...args),
  MobileCindyVoiceRunContext: class {
    createAsrConnection = vi.fn();
    createRefinerTarget = vi.fn();
    warmRefiner = vi.fn();
  },
}));

import {
  __testing,
  discardPendingPrewarm,
  prewarmMobileVoiceStart,
  takePrewarmedMobileVoiceAsr,
} from '@/session/mobileVoicePrewarm';

class FakeProvider implements AsrProvider {
  startCalls = 0;
  stopCalls = 0;
  private release: (() => void) | null = null;
  private fail: ((error: Error) => void) | null = null;

  async start(): Promise<void> {
    this.startCalls += 1;
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
  }

  resolveStart(): void {
    this.release?.();
  }

  failStart(error: Error): void {
    this.fail?.(error);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  appendAudio(_chunk: ArrayBuffer, _trace?: AudioTrace): void {}

  async flushAudio(): Promise<void> {}

  private callback: (event: AsrEvent) => void = () => {};

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  emit(event: AsrEvent): void {
    this.callback(event);
  }
}

const CREDENTIAL = { hostDeviceId: 'host-a' } as never;

const AUTH = {
  getAccessToken: async () => 'token',
  refreshAccessToken: async () => 'token',
  apiFetch: async () => ({} as never),
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mobileVoicePrewarm', () => {
  afterEach(() => {
    __testing.reset();
    vi.clearAllMocks();
  });

  it('starts the ASR connect at prewarm and hands the in-flight connection to the claiming run', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    expect(prewarmMobileRealtimeAudio).toHaveBeenCalledTimes(1);
    expect(provider.startCalls).toBe(1);

    // Claiming returns the provider immediately while its speculative connect
    // is still pending, so the caller can open the mic in parallel.
    const claimed = takePrewarmedMobileVoiceAsr('device-1');
    expect(claimed?.credential).toBe(CREDENTIAL);
    expect(__testing.hasPending()).toBe(false);

    // The consumer's first start() joins the in-flight connect instead of
    // restarting the provider.
    let started = false;
    const startPromise = claimed!.asr.start().then(() => {
      started = true;
    });
    await settle();
    expect(provider.startCalls).toBe(1);
    expect(started).toBe(false);
    provider.resolveStart();
    await startPromise;
    expect(provider.startCalls).toBe(1);

    // A later run on the same session starts the provider normally.
    void claimed!.asr.start();
    expect(provider.startCalls).toBe(2);
  });

  it('does not hand a prewarmed connection to a different device', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    expect(takePrewarmedMobileVoiceAsr('device-2')).toBeNull();
    expect(__testing.hasPending()).toBe(true);
  });

  it('discard immediately propagates cancellation to an in-flight speculative connection', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    await settle();
    discardPendingPrewarm();
    await settle();
    expect(provider.stopCalls).toBe(1);

    provider.resolveStart();
    await settle();
    expect(provider.stopCalls).toBe(1);
  });

  it('repeated pressIn for the same device reuses the pending prewarm instead of reconnecting', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    prewarmMobileVoiceStart('device-1', AUTH);
    await settle();
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(provider.startCalls).toBe(1);
  });

  it('retries with a fresh connection when the speculative connect failed', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    await settle();
    // The speculative connect fails (e.g. transient network blip at pressIn).
    provider.failStart(new Error('blip'));
    await settle();

    // The claimed connection must not block the recording with the stale
    // failure: its first start() falls back to one fresh connect.
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    const startPromise = claimed!.asr.start();
    await settle();
    expect(provider.startCalls).toBe(2);
    provider.resolveStart();
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('reconnects when the transport dropped after the speculative connect succeeded', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    await settle();
    provider.resolveStart();
    await settle();
    // The socket dies while parked (e.g. server-side idle timeout) — this
    // event goes to the prewarm sentinel, not to any consumer.
    provider.emit({ type: 'disconnected', at: Date.now() });

    // The claiming run must get a live transport, not the silently dead one.
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    const startPromise = claimed!.asr.start();
    await settle();
    expect(provider.startCalls).toBe(2);
    provider.resolveStart();
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('falls back to null when the managed credential cannot be built', async () => {
    createCindyCredential.mockImplementation(() => {
      throw new Error('当前区域未配置 Cindy 语音服务。');
    });

    prewarmMobileVoiceStart('device-1', AUTH);
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    expect(claimed).toBeNull();
  });

  it('managed prewarm uses the cindy credential and exposes a voiceContext', async () => {
    const provider = new FakeProvider();
    const managedCredential = {
      hostDeviceId: 'host-managed',
      refiner: { provider: 'auto' },
      settings: { language: 'zh-CN' },
    } as never;
    createCindyCredential.mockReturnValue(managedCredential);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1', AUTH);
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');

    expect(createCindyCredential).toHaveBeenCalledWith('device-1');
    expect(claimed?.credential).toBe(managedCredential);
    expect(claimed?.voiceContext).toBeDefined();
    // The managed provider dials through voice-server tickets.
    expect(createProvider.mock.calls[0][1]).toHaveProperty('connectionProvider');
  });

  it('without auth there is nothing to prewarm (managed-only voice input)', async () => {
    const provider = new FakeProvider();
    createCindyCredential.mockReturnValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');

    expect(claimed).toBeNull();
    expect(createCindyCredential).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });
});
