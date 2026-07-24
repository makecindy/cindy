import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireNativeModule } from 'expo-modules-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('keeps the iOS native realtime recorder wired for interruption cleanup', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudioModule.swift'),
      'utf8',
    );

    expect(source).toContain('AVAudioSession.interruptionNotification');
    expect(source).toContain('AVAudioSession.routeChangeNotification');
    expect(source).toContain('removeAudioSessionObservers()');
    expect(source).toContain('handleAudioSessionInterruption');
    expect(source).toContain('handleAudioRouteChange');
    expect(source).toContain('OnAppEntersBackground');
    expect(source).toContain('stopCapture(deactivateImmediately: true)');
    expect(source).toContain('stopCapture()');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])');
  });

  it('cancels voice runs in both composers when the app enters the background', () => {
    const newSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/new.tsx'),
      'utf8',
    );
    const existingSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    );

    for (const source of [newSessionSource, existingSessionSource]) {
      expect(source).toContain("AppState.addEventListener('change'");
      expect(source).toContain("nextState !== 'background'");
      expect(source).toContain('voiceControllerSessionRef.current = null');
      expect(source).toContain('discardPendingPrewarm()');
      expect(source).toContain("setAudioModeAsync({ allowsRecording: false })");
    }
    expect(newSessionSource).toContain('cancelVoiceForDeviceSwitch();');
    expect(existingSessionSource).toContain('cancelVoiceForAppBackground();');
  });
});
