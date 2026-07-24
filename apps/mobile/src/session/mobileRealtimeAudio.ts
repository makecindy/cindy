import {
  UnavailabilityError,
  requireNativeModule,
  type EventSubscription,
} from 'expo-modules-core';
import type { AudioTrace } from '@cindy/voice-input-core';

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

const DEFAULT_NATIVE_AUDIO_BUFFER_SIZE = 4096;

let nativeBinding: RealtimeAudioNativeBinding | null | undefined;

export function isMobileRealtimeAudioAvailable(): boolean {
  if (isE2eMockRealtimeAudioEnabled()) return true;
  return getNativeBinding() !== null;
}

/**
 * Keeps unfinished platform implementations out of the product surface. This
 * is intentionally a UI-only gate; the native permission and runtime fallback
 * stay unchanged so Android can be re-enabled without a native configuration
 * migration.
 */
export function shouldShowMobileVoiceUi(
  platform: string,
): boolean {
  if (isE2eMockRealtimeAudioEnabled()) return true;
  return platform !== 'android';
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
  if (!binding) {
    throw new UnavailabilityError('Cindy mobile voice input', 'realtime microphone PCM capture');
  }
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
 * Best-effort microphone warm-up, wired to touch-down (pressIn) of the mic
 * button. Activating the iOS audio session costs ~100-150ms; doing it while the
 * finger is still down means capture is live almost immediately when the tap
 * completes and recording actually starts, instead of losing the first syllable
 * to the warm-up window. Never throws and never blocks the caller — a real
 * failure will surface from the subsequent start.
 */
export function prewarmMobileRealtimeAudio(): void {
  if (isE2eMockRealtimeAudioEnabled()) return;
  const binding = getNativeBinding();
  if (!binding) return;
  void binding.module.prewarm().catch(() => undefined);
}

export const __testing = {
  decodeBase64ToArrayBuffer,
  resetNativeBindingForTests: () => {
    nativeBinding = undefined;
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
