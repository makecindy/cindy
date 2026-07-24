import {
  UnavailabilityError,
  requireNativeModule,
  type EventSubscription,
} from 'expo-modules-core';
import type { AudioTrace } from '@cindy/voice-input-core';
import { i18n } from '@/i18n';

export type MobileRealtimeAudioChunk = {
  pcm16: ArrayBuffer;
  trace: AudioTrace;
};

type NativeAudioChunkEvent = {
  base64Pcm16: string;
  capturedAt: number;
  chunkIndex: number;
  sampleRate: number;
  durationMs: number;
};

type NativeAudioErrorEvent = {
  message: string;
};

type NativeRealtimeAudioModule = {
  start(options?: { sampleRate?: number; bufferSize?: number }): Promise<void>;
  stop(): Promise<void>;
  prewarm(): Promise<void>;
};

type NativeRealtimeAudioEvents = {
  onAudioChunk: (event: NativeAudioChunkEvent) => void;
  onAudioError: (event: NativeAudioErrorEvent) => void;
};

type ExpoAudioStreamBufferEvent = {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
  timestamp: number;
};

type ExpoAudioStreamStatusEvent = {
  isStreaming: boolean;
};

type ExpoAudioStreamEvents = {
  audioStreamBuffer: (event: ExpoAudioStreamBufferEvent) => void;
  audioStreamStatus: (event: ExpoAudioStreamStatusEvent) => void;
};

type NativeEventSource<TEvents extends Record<string, (event: never) => void>> = {
  addListener<EventName extends keyof TEvents>(
    eventName: EventName,
    listener: TEvents[EventName],
  ): EventSubscription;
};

type NativeRealtimeAudioBinding =
  & NativeRealtimeAudioModule
  & NativeEventSource<NativeRealtimeAudioEvents>;

type RealtimeAudioNativeBinding = {
  module: NativeRealtimeAudioBinding;
};

type ExpoAudioStream = NativeEventSource<ExpoAudioStreamEvents> & {
  readonly id: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly isStreaming: boolean;
  start(): Promise<void>;
  stop(): void;
  release(): void;
};

type ExpoAudioNativeModule = {
  AudioStream: new (options: {
    sampleRate: number;
    channels: number;
    encoding: 'int16';
  }) => ExpoAudioStream;
};

type ExpoAudioPcm16ResampleState = {
  sourceSampleRate: number;
  sourceChannels: number;
  targetSampleRate: number;
  sourceFramesConsumed: number;
  outputFramesProduced: number;
};

const DEFAULT_NATIVE_AUDIO_BUFFER_SIZE = 4096;
const EXPO_AUDIO_STREAM_STALL_TIMEOUT_MS = 5_000;
const EXPO_AUDIO_STREAM_WATCHDOG_INTERVAL_MS = 1_000;

let nativeBinding: RealtimeAudioNativeBinding | null | undefined;
let expoAudioNativeModule: ExpoAudioNativeModule | null | undefined;

export function isMobileRealtimeAudioAvailable(): boolean {
  if (isE2eMockRealtimeAudioEnabled()) return true;
  return getNativeBinding() !== null || getExpoAudioNativeModule() !== null;
}

/**
 * Android uses expo-audio's native PCM AudioStream when the custom Apple module
 * is absent. Keep the entry hidden in builds that predate that native class or
 * otherwise failed to link it, instead of sending users into a known failure.
 */
export function shouldShowMobileVoiceUi(
  platform: string,
): boolean {
  if (isE2eMockRealtimeAudioEnabled()) return true;
  return platform !== 'android' || isMobileRealtimeAudioAvailable();
}

export async function startMobileRealtimeAudio(
  options: {
    onChunk: (chunk: MobileRealtimeAudioChunk) => void;
    onError?: (error: Error) => void;
    sampleRate?: number;
    bufferSize?: number;
  },
): Promise<() => Promise<void>> {
  if (isE2eMockRealtimeAudioEnabled()) {
    return startE2eMockRealtimeAudio(options);
  }
  const binding = getNativeBinding();
  if (binding) {
    return startCustomNativeRealtimeAudio(binding, options);
  }
  const expoAudioModule = getExpoAudioNativeModule();
  if (expoAudioModule) {
    return startExpoAudioRealtimeAudio(expoAudioModule, options);
  }
  throw new UnavailabilityError('Cindy mobile voice input', 'realtime microphone PCM capture');
}

async function startCustomNativeRealtimeAudio(
  binding: RealtimeAudioNativeBinding,
  options: {
    onChunk: (chunk: MobileRealtimeAudioChunk) => void;
    onError?: (error: Error) => void;
    sampleRate?: number;
    bufferSize?: number;
  },
): Promise<() => Promise<void>> {
  const subscriptions: EventSubscription[] = [
    binding.module.addListener('onAudioChunk', (event) => {
      options.onChunk({
        pcm16: decodeBase64ToArrayBuffer(event.base64Pcm16),
        trace: {
          capturedAt: event.capturedAt,
          convertedAt: Date.now(),
          chunkIndex: event.chunkIndex,
          sampleRate: event.sampleRate,
          durationMs: event.durationMs,
        },
      });
    }),
    binding.module.addListener('onAudioError', (event) => {
      options.onError?.(new Error(event.message));
    }),
  ];

  try {
    await binding.module.start({
      sampleRate: options.sampleRate ?? 16_000,
      bufferSize: options.bufferSize ?? DEFAULT_NATIVE_AUDIO_BUFFER_SIZE,
    });
  } catch (error) {
    subscriptions.forEach((subscription) => subscription.remove());
    throw error;
  }

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    subscriptions.forEach((subscription) => subscription.remove());
    await binding.module.stop();
  };
}

/**
 * Mobile already ships expo-audio for permission and audio-mode management.
 * SDK 56 also exposes the native SharedObject behind its public useAudioStream
 * hook. The voice controller is intentionally imperative, so construct that
 * same stream class directly rather than carrying a second AudioRecord stack.
 */
async function startExpoAudioRealtimeAudio(
  module: ExpoAudioNativeModule,
  options: {
    onChunk: (chunk: MobileRealtimeAudioChunk) => void;
    onError?: (error: Error) => void;
    sampleRate?: number;
  },
): Promise<() => Promise<void>> {
  const targetSampleRate = normalizeSampleRate(options.sampleRate);
  const convertPcm16 = createExpoAudioPcm16Converter(targetSampleRate);
  const stream = new module.AudioStream({
    sampleRate: targetSampleRate,
    channels: 1,
    encoding: 'int16',
  });
  let streamStarted = false;
  let stopping = false;
  let failureReported = false;
  let chunkIndex = 0;
  let lastChunkAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const subscriptions: EventSubscription[] = [];

  const stopStream = (): void => {
    if (stopping) return;
    stopping = true;
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    subscriptions.splice(0).forEach((subscription) => subscription.remove());
    try {
      stream.stop();
    } catch {
      // The native stream may already have stopped after an Android audio
      // interruption. Releasing the SharedObject below is still required.
    }
    try {
      stream.release();
    } catch {
      // release() is best-effort and may already have run during teardown.
    }
  };

  const reportFailure = (): void => {
    if (stopping || failureReported) return;
    failureReported = true;
    stopStream();
    options.onError?.(new Error(i18n.t('composer.voice.incomplete')));
  };

  subscriptions.push(
    stream.addListener('audioStreamBuffer', (event) => {
      if (stopping) return;
      const capturedAt = Date.now();
      lastChunkAt = capturedAt;
      let pcm16: ArrayBuffer;
      try {
        pcm16 = convertPcm16(
          event.data,
          event.sampleRate,
          event.channels,
        );
      } catch {
        reportFailure();
        return;
      }
      if (pcm16.byteLength === 0) return;
      const convertedAt = Date.now();
      options.onChunk({
        pcm16,
        trace: {
          capturedAt,
          convertedAt,
          chunkIndex,
          sampleRate: targetSampleRate,
          durationMs: pcm16.byteLength / 2 / targetSampleRate * 1_000,
        },
      });
      chunkIndex += 1;
    }),
    stream.addListener('audioStreamStatus', (event) => {
      if (!event.isStreaming && streamStarted && !stopping) {
        reportFailure();
      }
    }),
  );

  try {
    await stream.start();
    streamStarted = true;
    lastChunkAt = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > EXPO_AUDIO_STREAM_STALL_TIMEOUT_MS) {
        reportFailure();
      }
    }, EXPO_AUDIO_STREAM_WATCHDOG_INTERVAL_MS);
  } catch (error) {
    stopStream();
    throw error;
  }

  return async () => {
    stopStream();
  };
}

/**
 * Best-effort microphone warm-up, wired to touch-down (pressIn) of the mic
 * button. The custom iOS module can activate AVAudioSession ahead of start;
 * Android's Expo AudioStream has no prepare phase, so Android safely no-ops
 * here while its ASR connection still prewarms in parallel. Never throws and
 * never blocks the caller — a real failure will surface from start.
 */
export function prewarmMobileRealtimeAudio(): void {
  if (isE2eMockRealtimeAudioEnabled()) return;
  const binding = getNativeBinding();
  if (!binding) return;
  void binding.module.prewarm().catch(() => undefined);
}

export const __testing = {
  decodeBase64ToArrayBuffer,
  convertExpoAudioPcm16,
  createExpoAudioPcm16Converter,
  resetNativeBindingForTests: () => {
    nativeBinding = undefined;
    expoAudioNativeModule = undefined;
  },
};

function getNativeBinding(): RealtimeAudioNativeBinding | null {
  if (nativeBinding !== undefined) return nativeBinding;
  try {
    const module = requireNativeModule<NativeRealtimeAudioBinding>('XdtMobileRealtimeAudio');
    nativeBinding = {
      module,
    };
  } catch {
    nativeBinding = null;
  }
  return nativeBinding ?? null;
}

function getExpoAudioNativeModule(): ExpoAudioNativeModule | null {
  if (expoAudioNativeModule !== undefined) return expoAudioNativeModule;
  try {
    const module = requireNativeModule<ExpoAudioNativeModule>('ExpoAudio');
    expoAudioNativeModule =
      typeof module.AudioStream === 'function'
        ? module
        : null;
  } catch {
    expoAudioNativeModule = null;
  }
  return expoAudioNativeModule ?? null;
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = typeof atob === 'function'
    ? atob(base64)
    : decodeBase64(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function decodeBase64(base64: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/=+$/, '');
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  if (sampleRate === undefined) return 16_000;
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError(`Unsupported realtime audio sample rate: ${sampleRate}`);
  }
  return Math.round(sampleRate);
}

function createExpoAudioPcm16Converter(
  targetSampleRate: number,
): (
  input: ArrayBuffer,
  sourceSampleRate: number,
  sourceChannels: number,
) => ArrayBuffer {
  const state: ExpoAudioPcm16ResampleState = {
    sourceSampleRate: 0,
    sourceChannels: 0,
    targetSampleRate,
    sourceFramesConsumed: 0,
    outputFramesProduced: 0,
  };
  return (input, sourceSampleRate, sourceChannels) => convertExpoAudioPcm16(
    input,
    sourceSampleRate,
    sourceChannels,
    targetSampleRate,
    state,
  );
}

/**
 * Converts interleaved little-endian PCM16 from Expo AudioStream into the mono
 * sample rate declared to the ASR provider. AudioStream may fall back to a
 * hardware-supported rate, so forwarding its bytes unchanged would make the
 * provider interpret (for example) 48 kHz audio as 16 kHz. The optional state
 * keeps the resampling clock continuous across native buffer boundaries.
 */
function convertExpoAudioPcm16(
  input: ArrayBuffer,
  sourceSampleRate: number,
  sourceChannels: number,
  targetSampleRate: number,
  state?: ExpoAudioPcm16ResampleState,
): ArrayBuffer {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new RangeError(`Invalid source sample rate: ${sourceSampleRate}`);
  }
  if (!Number.isInteger(sourceChannels) || sourceChannels <= 0) {
    throw new RangeError(`Invalid source channel count: ${sourceChannels}`);
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError(`Invalid target sample rate: ${targetSampleRate}`);
  }

  const resampleState = state ?? {
    sourceSampleRate,
    sourceChannels,
    targetSampleRate,
    sourceFramesConsumed: 0,
    outputFramesProduced: 0,
  };
  if (
    resampleState.sourceSampleRate !== sourceSampleRate
    || resampleState.sourceChannels !== sourceChannels
    || resampleState.targetSampleRate !== targetSampleRate
  ) {
    resampleState.sourceSampleRate = sourceSampleRate;
    resampleState.sourceChannels = sourceChannels;
    resampleState.targetSampleRate = targetSampleRate;
    resampleState.sourceFramesConsumed = 0;
    resampleState.outputFramesProduced = 0;
  }

  const bytesPerFrame = sourceChannels * 2;
  const sourceFrameCount = Math.floor(input.byteLength / bytesPerFrame);
  if (sourceFrameCount === 0) return new ArrayBuffer(0);
  const sourceFrameStart = resampleState.sourceFramesConsumed;
  const sourceFrameEnd = sourceFrameStart + sourceFrameCount;
  const outputFrameEnd = Math.ceil(
    sourceFrameEnd * targetSampleRate / sourceSampleRate,
  );
  const outputFrameCount = outputFrameEnd - resampleState.outputFramesProduced;

  if (sourceChannels === 1 && sourceSampleRate === targetSampleRate) {
    resampleState.sourceFramesConsumed = sourceFrameEnd;
    resampleState.outputFramesProduced = outputFrameEnd;
    const alignedByteLength = sourceFrameCount * bytesPerFrame;
    return input.byteLength === alignedByteLength
      ? input
      : input.slice(0, alignedByteLength);
  }

  const inputView = new DataView(input);
  const output = new ArrayBuffer(outputFrameCount * 2);
  const outputView = new DataView(output);

  for (let outputIndex = 0; outputIndex < outputFrameCount; outputIndex += 1) {
    const globalOutputFrameIndex =
      resampleState.outputFramesProduced + outputIndex;
    const sourceFrameIndex = Math.floor(
      globalOutputFrameIndex * sourceSampleRate / targetSampleRate,
    ) - sourceFrameStart;
    if (sourceFrameIndex < 0 || sourceFrameIndex >= sourceFrameCount) {
      throw new RangeError(
        `Invalid realtime audio resampling phase: ${sourceFrameIndex}`,
      );
    }
    let monoSample = 0;
    for (let channelIndex = 0; channelIndex < sourceChannels; channelIndex += 1) {
      const byteOffset = (
        sourceFrameIndex * sourceChannels + channelIndex
      ) * 2;
      monoSample += inputView.getInt16(byteOffset, true);
    }
    const averagedSample = Math.max(
      -32_768,
      Math.min(32_767, Math.round(monoSample / sourceChannels)),
    );
    outputView.setInt16(outputIndex * 2, averagedSample, true);
  }

  resampleState.sourceFramesConsumed = sourceFrameEnd;
  resampleState.outputFramesProduced = outputFrameEnd;
  return output;
}

function isE2eMockRealtimeAudioEnabled(): boolean {
  return process.env.EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO === '1';
}

function startE2eMockRealtimeAudio(options: {
  onChunk: (chunk: MobileRealtimeAudioChunk) => void;
  sampleRate?: number;
}): Promise<() => Promise<void>> {
  let stopped = false;
  let chunkIndex = 0;
  const sampleRate = options.sampleRate ?? 16_000;
  const durationMs = 20;
  const sampleCount = Math.round(sampleRate * durationMs / 1000);
  const sendChunk = () => {
    if (stopped) return;
    const pcm = new Int16Array(sampleCount);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = Math.round(Math.sin((index / pcm.length) * Math.PI * 2) * 900);
    }
    options.onChunk({
      pcm16: pcm.buffer.slice(0),
      trace: {
        capturedAt: Date.now(),
        convertedAt: Date.now(),
        chunkIndex,
        durationMs,
        sampleRate,
      },
    });
    chunkIndex += 1;
  };
  const firstTimer = setTimeout(sendChunk, 20);
  const interval = setInterval(sendChunk, 80);
  return Promise.resolve(async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(firstTimer);
    clearInterval(interval);
  });
}
