import { requireNativeModule } from 'expo-modules-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logMobileVoice } from '@/session/mobileVoiceDiagnostics';

vi.mock('@/session/mobileVoiceDiagnostics', () => ({ logMobileVoice: vi.fn() }));

vi.mock('expo-modules-core', () => ({
  EventEmitter: class {
    addListener() {
      return { remove: vi.fn() };
    }
  },
  UnavailabilityError: class extends Error {
    constructor(moduleName: string, propertyName: string) {
      super(`${moduleName}.${propertyName} is unavailable`);
      this.name = 'UnavailabilityError';
    }
  },
  requireNativeModule: vi.fn(() => {
    throw new Error('native module not linked');
  }),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(requireNativeModule).mockReset();
  vi.mocked(requireNativeModule).mockImplementation(() => {
    throw new Error('native module not linked');
  });
  const { __testing } = await import('@/session/mobileRealtimeAudio');
  __testing.resetNativeBindingForTests();
});

describe('mobileRealtimeAudio', () => {
  it('replays a packet rejected after stop even when its event beat the native start receipt', async () => {
    let listener!: (event: unknown) => void;
    let finishStart!: () => void;
    const packet = { chunkIndex: 0, base64Pcm16: '6APoAw==', capturedAt: 10, sampleRate: 16000, durationMs: .125 };
    const native = {
      addListener: vi.fn((name: string, callback: (event: unknown) => void) => {
        if (name === 'onAudioChunk') listener = callback;
        return { remove: vi.fn() };
      }),
      start: vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve; })),
      stopAndDrain: vi.fn(async () => [packet]),
    };
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    const onChunk = vi.fn((chunk: { drained?: boolean }) => chunk.drained === true);
    const opening = startMobileRealtimeAudio({ onChunk });
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));
    listener(packet);
    finishStart();
    await (await opening)(20);
    expect(native.stopAndDrain).toHaveBeenCalledWith(-1, 20);
    expect(onChunk.mock.calls.map(([chunk]) => chunk.drained)).toEqual([undefined, true]);
  });

  it('drains only undelivered pre-stop packets, deduplicates the receipt, and ignores a previous capture', async () => {
    type Packet = { captureId: string; chunkIndex: number; base64Pcm16: string; capturedAt: number; sampleRate: number; durationMs: number };
    let listener!: (event: Packet) => void;
    let captureId = '';
    const packet = (index: number): Packet => ({
      captureId, chunkIndex: index, base64Pcm16: '6APoAw==',
      capturedAt: 10, sampleRate: 16000, durationMs: .125,
    });
    const native = {
      addListener: vi.fn((name: string, callback: (event: Packet) => void) => {
        if (name === 'onAudioChunk') listener = callback;
        return { remove: vi.fn() };
      }),
      start: vi.fn(async (options: { captureId: string }) => { captureId = options.captureId; }),
      stop: vi.fn(async () => undefined),
      stopAndDrain: vi.fn(async () => [packet(0), packet(1)]),
    };
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    const onChunk = vi.fn();
    const stop = await startMobileRealtimeAudio({ onChunk });
    listener({ ...packet(0), captureId: 'previous' });
    listener(packet(0));
    await stop(20);
    expect(native.stopAndDrain).toHaveBeenCalledWith(0, 20);
    expect(native.stop).not.toHaveBeenCalled();
    expect(onChunk.mock.calls.map(([chunk]) => [chunk.trace.chunkIndex, chunk.drained])).toEqual([[0, undefined], [1, true]]);
    expect([...new Int16Array(onChunk.mock.calls[1][0].pcm16)]).toEqual([1000, 1000]);
    await stop();
    expect(native.stopAndDrain).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent native prewarm calls and allows a later prewarm', async () => {
    let finish!: () => void;
    const native = { prewarm: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { prewarmMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    prewarmMobileRealtimeAudio();
    prewarmMobileRealtimeAudio();
    expect(native.prewarm).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    prewarmMobileRealtimeAudio();
    expect(native.prewarm).toHaveBeenCalledTimes(2);
    finish();
    await Promise.resolve();
    await Promise.resolve();
  });

  it.each([undefined, { inputPortTypes: ['MicrophoneBuiltIn'], inputSampleRate: 48000, inputChannels: 1 }])(
    'logs input metadata and supports installed modules without it: %j', async (input) => {
      const native = {
        addListener: vi.fn(() => ({ remove: vi.fn() })),
        start: vi.fn(async () => input),
        stop: vi.fn(async () => undefined),
      };
      vi.mocked(requireNativeModule).mockReturnValue(native);
      const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
      const stop = await startMobileRealtimeAudio({ onChunk: vi.fn() });
      expect(logMobileVoice).toHaveBeenLastCalledWith('debug', 'capture input', {
        backend: 'ios-native',
        inputPortTypes: input?.inputPortTypes ?? ['unknown'],
        inputSampleRate: input?.inputSampleRate,
        inputChannels: input?.inputChannels,
      });
      await stop();
    },
  );

  it('waits for the previous singleton recorder to finish starting and stopping before reuse', async () => {
    let finishStart!: () => void;
    let finishStop!: () => void;
    const native = {
      addListener: vi.fn(() => ({ remove: vi.fn() })),
      start: vi.fn(async (): Promise<void> => {})
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishStart = resolve; })),
      stop: vi.fn(async (): Promise<void> => {})
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; })),
    };
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    const first = startMobileRealtimeAudio({ onChunk: vi.fn() });
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));
    const second = startMobileRealtimeAudio({ onChunk: vi.fn() });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const startsWhileStarting = native.start.mock.calls.length;
    const listenersWhileStarting = native.addListener.mock.calls.length;
    finishStart();
    const stopFirst = await first;
    const stopping = stopFirst();
    await vi.waitFor(() => expect(finishStop).toBeTypeOf('function'));
    const startsWhileStopping = native.start.mock.calls.length;
    finishStop();
    await stopping;
    const stopSecond = await second;
    await stopFirst();
    const stopsAfterOldCleanup = native.stop.mock.calls.length;
    await stopSecond();

    expect(startsWhileStarting).toBe(1);
    expect(listenersWhileStarting).toBe(2);
    expect(startsWhileStopping).toBe(1);
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(stopsAfterOldCleanup).toBe(1);
    expect(native.stop).toHaveBeenCalledTimes(2);
  });

  it.each(['start', 'stop'] as const)('allows a new singleton recording after the previous %s rejects', async (failure) => {
    const native = {
      addListener: vi.fn(() => ({ remove: vi.fn() })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    native[failure].mockRejectedValueOnce(new Error('native failure'));
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    const first = startMobileRealtimeAudio({ onChunk: vi.fn() });
    if (failure === 'start') await expect(first).rejects.toThrow('native failure');
    else await expect((await first)()).rejects.toThrow('native failure');
    const stop = await startMobileRealtimeAudio({ onChunk: vi.fn() });
    await stop();
    expect(native.start).toHaveBeenCalledTimes(2);
  });

  it.each(['subscribe', 'unsubscribe'] as const)('releases the singleton recorder after %s throws', async (failure) => {
    const remove = vi.fn();
    const native = {
      addListener: vi.fn(() => ({ remove })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    if (failure === 'subscribe') {
      native.addListener
        .mockImplementationOnce(() => ({ remove }))
        .mockImplementationOnce(() => { throw new Error('listener failure'); });
    } else {
      remove.mockImplementationOnce(() => { throw new Error('listener failure'); });
    }
    vi.mocked(requireNativeModule).mockReturnValue(native);
    const { startMobileRealtimeAudio } = await import('@/session/mobileRealtimeAudio');
    const first = startMobileRealtimeAudio({ onChunk: vi.fn() });
    if (failure === 'subscribe') await expect(first).rejects.toThrow('listener failure');
    else await expect((await first)()).rejects.toThrow('listener failure');
    expect(remove).toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledTimes(failure === 'subscribe' ? 0 : 1);
    const stop = await startMobileRealtimeAudio({ onChunk: vi.fn() });
    await stop();
  });

  it('decodes native PCM base64 payloads into ArrayBuffer chunks', async () => {
    const { __testing } = await import('@/session/mobileRealtimeAudio');

    const decoded = new Uint8Array(__testing.decodeBase64ToArrayBuffer('AQIDBA=='));

    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  it('reports realtime audio as unavailable when the dev client has not linked the native module', async () => {
    const {
      __testing,
      isMobileRealtimeAudioAvailable,
      startMobileRealtimeAudio,
    } = await import('@/session/mobileRealtimeAudio');

    __testing.resetNativeBindingForTests();

    expect(isMobileRealtimeAudioAvailable()).toBe(false);
    await expect(startMobileRealtimeAudio({ onChunk: vi.fn() }))
      .rejects.toThrow('realtime microphone PCM capture');
  });

  it('hides voice UI when an Android build has no native PCM stream', async () => {
    const { shouldShowMobileVoiceUi } = await import('@/session/mobileRealtimeAudio');

    expect(shouldShowMobileVoiceUi('android')).toBe(false);
    expect(shouldShowMobileVoiceUi('ios')).toBe(true);
    expect(shouldShowMobileVoiceUi('web')).toBe(true);
  });

  it('streams and converts Android Expo AudioStream PCM into the ASR format', async () => {
    type StreamEvent = 'audioStreamBuffer' | 'audioStreamStatus';
    const listeners = new Map<StreamEvent, (event: never) => void>();
    const removedEvents: StreamEvent[] = [];
    const streamStart = vi.fn(async () => undefined);
    const streamStop = vi.fn();
    const streamRelease = vi.fn();
    let streamOptions: unknown;

    class MockExpoAudioStream {
      readonly id = 'android-pcm-stream';
      readonly sampleRate = 24_000;
      readonly channels = 2;
      readonly isStreaming = true;

      constructor(options: unknown) {
        streamOptions = options;
      }

      addListener(eventName: StreamEvent, listener: (event: never) => void) {
        listeners.set(eventName, listener);
        return {
          remove: () => {
            removedEvents.push(eventName);
            listeners.delete(eventName);
          },
        };
      }

      start = streamStart;
      stop = streamStop;
      release = streamRelease;
    }

    vi.mocked(requireNativeModule).mockImplementation((moduleName: string) => {
      if (moduleName === 'ExpoAudio') {
        return { AudioStream: MockExpoAudioStream };
      }
      throw new Error(`${moduleName} not linked`);
    });
    const {
      __testing,
      isMobileRealtimeAudioAvailable,
      shouldShowMobileVoiceUi,
      startMobileRealtimeAudio,
    } = await import('@/session/mobileRealtimeAudio');
    __testing.resetNativeBindingForTests();

    expect(isMobileRealtimeAudioAvailable()).toBe(true);
    expect(shouldShowMobileVoiceUi('android')).toBe(true);

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_200)
      .mockReturnValueOnce(1_225)
      .mockReturnValue(1_300);
    const onChunk = vi.fn();
    const onError = vi.fn();
    const stopCapture = await startMobileRealtimeAudio({
      sampleRate: 12_000,
      onChunk,
      onError,
    });

    expect(streamOptions).toEqual({
      sampleRate: 12_000,
      channels: 1,
      encoding: 'int16',
    });
    expect(streamStart).toHaveBeenCalledTimes(1);

    const input = new ArrayBuffer(16);
    const inputView = new DataView(input);
    [
      1_000, 3_000,
      5_000, 7_000,
      9_000, 11_000,
      13_000, 15_000,
    ].forEach((sample, index) => inputView.setInt16(index * 2, sample, true));
    listeners.get('audioStreamBuffer')?.({
      data: input,
      sampleRate: 24_000,
      channels: 2,
      timestamp: 0.1,
    } as never);

    expect(onChunk).toHaveBeenCalledTimes(1);
    const chunk = onChunk.mock.calls[0]?.[0];
    expect(Array.from(new Int16Array(chunk.pcm16))).toEqual([2_000, 10_000]);
    expect(chunk.trace).toMatchObject({
      capturedAt: 1_200,
      convertedAt: 1_225,
      chunkIndex: 0,
      sampleRate: 12_000,
    });
    expect(chunk.trace.durationMs).toBeCloseTo(2 / 12_000 * 1_000);

    listeners.get('audioStreamStatus')?.({
      isStreaming: false,
    } as never);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(streamStop).toHaveBeenCalledTimes(1);
    expect(streamRelease).toHaveBeenCalledTimes(1);
    expect(removedEvents).toEqual(['audioStreamBuffer', 'audioStreamStatus']);

    await stopCapture();

    expect(streamStop).toHaveBeenCalledTimes(1);
    expect(streamRelease).toHaveBeenCalledTimes(1);
  });

  it('preserves non-integer resampling phase across native buffer boundaries', async () => {
    const { __testing } = await import('@/session/mobileRealtimeAudio');
    const convert = __testing.createExpoAudioPcm16Converter(16_000);

    const firstChunk = Int16Array.from(
      { length: 7 },
      (_, index) => index,
    );
    const secondChunk = Int16Array.from(
      { length: 7 },
      (_, index) => index + 7,
    );

    const firstOutput = new Int16Array(
      convert(firstChunk.buffer, 44_100, 1),
    );
    const secondOutput = new Int16Array(
      convert(secondChunk.buffer, 44_100, 1),
    );

    expect(Array.from(firstOutput)).toEqual([0, 2, 5]);
    expect(Array.from(secondOutput)).toEqual([8, 11, 13]);
    expect(firstOutput.length + secondOutput.length).toBe(
      Math.ceil(14 * 16_000 / 44_100),
    );
  });

  it('reuses an aligned mono PCM buffer when no conversion is needed', async () => {
    const { __testing } = await import('@/session/mobileRealtimeAudio');
    const input = new Int16Array([1, 2, 3]).buffer;

    expect(__testing.convertExpoAudioPcm16(input, 16_000, 1, 16_000))
      .toBe(input);
  });

  it('keeps the Android voice entry available to explicit E2E mock runs', async () => {
    vi.stubEnv('EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO', '1');
    const { shouldShowMobileVoiceUi } = await import('@/session/mobileRealtimeAudio');

    expect(shouldShowMobileVoiceUi('android')).toBe(true);
  });
});
