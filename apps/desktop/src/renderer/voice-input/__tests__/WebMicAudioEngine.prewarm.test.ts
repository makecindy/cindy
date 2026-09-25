import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prewarmVoiceInputAudio } from '../audioContextPool';
import {
  disposeKeepAliveVoiceInputMicrophone,
  isMicrophoneDeviceUnavailableError,
  prewarmVoiceInputMicrophoneWithAutomaticFallback,
  WebMicAudioEngine,
} from '../WebMicAudioEngine';

vi.mock('../audioContextPool', () => ({
  PCM16K_WORKLET_NAME: 'pcm16k-worklet',
  prewarmVoiceInputAudio: vi.fn(),
}));

type FakeTrack = MediaStreamTrack & {
  listeners: Record<string, Array<() => void>>;
  stopped: boolean;
};

function createFakeTrack(): FakeTrack {
  return {
    label: 'fallback microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    stopped: false,
    listeners: {},
    addEventListener(event: string, listener: () => void) {
      this.listeners[event] ??= [];
      this.listeners[event].push(listener);
    },
    removeEventListener(event: string, listener: () => void) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((item) => item !== listener);
    },
    getSettings() {
      return { deviceId: 'fallback-device' };
    },
    stop() {
      this.stopped = true;
    },
  } as FakeTrack;
}

function createFakeAudioNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('prewarmVoiceInputMicrophoneWithAutomaticFallback', () => {
  let track: FakeTrack;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let enumerateDevices: ReturnType<typeof vi.fn>;
  let deviceChangeListener: (() => void) | undefined;

  beforeEach(() => {
    track = createFakeTrack();
    getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [track],
      getTracks: () => [track],
    }));
    enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'other-device' },
    ]);

    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices,
        getUserMedia,
        addEventListener: vi.fn((event: string, listener: () => void) => {
          if (event === 'devicechange') deviceChangeListener = listener;
        }),
      },
    });
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: {
        close: vi.fn(),
        postMessage: vi.fn(),
        onmessage: null,
      },
    })));

    const fakeContext = {
      currentTime: 0,
      state: 'running',
      destination: createFakeAudioNode(),
      createGain: vi.fn(() => ({
        ...createFakeAudioNode(),
        gain: { value: 1 },
      })),
      createMediaStreamSource: vi.fn(() => createFakeAudioNode()),
      resume: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    vi.mocked(prewarmVoiceInputAudio).mockResolvedValue({
      context: fakeContext,
      workletReady: Promise.resolve(),
      workletUrl: 'https://app.local/pcm16k-worklet.js',
    });
  });

  afterEach(async () => {
    await disposeKeepAliveVoiceInputMicrophone('test_cleanup');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests microphone permission only once when keep-alive capture is denied', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const engine = new WebMicAudioEngine({
      workletUrl: 'https://app.local/pcm16k-worklet.js',
      keepAlive: true,
    });
    await expect(engine.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('defers keep-alive disposal when the active microphone receives a devicechange event', async () => {
    const onStateChange = vi.fn();
    const engine = new WebMicAudioEngine({
      workletUrl: 'https://app.local/pcm16k-worklet.js',
      keepAlive: true,
      onStateChange,
    });

    await engine.start();
    expect(deviceChangeListener).toBeDefined();

    deviceChangeListener?.();

    expect(track.stopped).toBe(false);
    expect(onStateChange).toHaveBeenCalledWith('keep_alive_devicechange_deferred', {
      reason: 'active_recording',
    });

    await engine.stop();

    expect(track.stopped).toBe(true);
  });

  it('falls back to automatic microphone prewarm when the selected device is unavailable', async () => {
    const onFallback = vi.fn();

    await prewarmVoiceInputMicrophoneWithAutomaticFallback({
      workletUrl: 'https://app.local/pcm16k-worklet.js',
      deviceId: 'missing-device',
    }, onFallback);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  });

  it('recognizes a cross-realm device error and falls back automatically', async () => {
    const onFallback = vi.fn();
    const crossRealmError = {
      name: 'NotFoundError',
      message: 'Requested device not found',
    };
    enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'missing-device' },
    ]);
    getUserMedia
      .mockRejectedValueOnce(crossRealmError)
      .mockResolvedValueOnce({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      });

    await prewarmVoiceInputMicrophoneWithAutomaticFallback({
      workletUrl: 'https://app.local/pcm16k-worklet.js',
      deviceId: 'missing-device',
    }, onFallback);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(isMicrophoneDeviceUnavailableError(crossRealmError)).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0]).toEqual({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  });
});
