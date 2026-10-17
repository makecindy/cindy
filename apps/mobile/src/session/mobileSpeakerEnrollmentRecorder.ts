import { SPEAKER_GATE_SAMPLE_RATE } from '@cindy/voice-input-core';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { AppState } from 'react-native';

import { startMobileRealtimeAudio } from './mobileRealtimeAudio';
import { resolveMobileVoiceRecordingPermission, waitForMobileVoiceAppActive } from './mobileVoiceStartup';

export class MobileSpeakerEnrollmentAbortedError extends Error {
  constructor() {
    super('speaker enrollment recording aborted');
    this.name = 'MobileSpeakerEnrollmentAbortedError';
  }
}

export class MobileSpeakerEnrollmentNoAudioError extends Error {
  constructor() {
    super('microphone delivered no audio');
    this.name = 'MobileSpeakerEnrollmentNoAudioError';
  }
}

/** A stalled microphone fails the clip instead of hanging the screen. */
const NO_AUDIO_GRACE_MS = 5_000;

type RecordOptions = {
  durationMs: number;
  /** Elapsed fraction in [0, 1]. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Finish and keep captured audio; `signal` instead cancels and discards it. */
  stopSignal?: AbortSignal;
  /** Injection point for tests. */
  startAudio?: typeof startMobileRealtimeAudio;
};

/**
 * Records one read-aloud clip for voiceprint enrollment as PCM16 mono 16 kHz,
 * through the same capture dictation uses, so the voiceprint matches the
 * audio the gate later judges. Stops at `durationMs` or on `stopSignal`.
 */
export async function recordMobileSpeakerClip(options: RecordOptions): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new MobileSpeakerEnrollmentAbortedError();
  if (options.stopSignal?.aborted) throw new MobileSpeakerEnrollmentNoAudioError();
  const startAudio = options.startAudio ?? startMobileRealtimeAudio;
  const targetSamples = Math.round((options.durationMs / 1000) * SPEAKER_GATE_SAMPLE_RATE);
  const chunks: Int16Array[] = [];
  let samples = 0;
  let failure: Error | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stoppedEarly = false;
  const onStop = (): void => {
    stoppedEarly = true;
    finish();
  };
  options.stopSignal?.addEventListener('abort', onStop, { once: true });

  const lifecycle = new AbortController();
  const onAbort = (): void => {
    lifecycle.abort();
    finish();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const subscribeToAppState = (listener: (state: string) => void): (() => void) => {
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  };
  let removeBackgroundListener: (() => void) | undefined;
  let stop: (() => Promise<void>) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const permission = await resolveMobileVoiceRecordingPermission({
      getPermission: getRecordingPermissionsAsync,
      requestPermission: requestRecordingPermissionsAsync,
      isRequestCurrent: () => !lifecycle.signal.aborted,
      isAppActive: () => AppState.currentState === 'active',
      subscribeToAppState,
      signal: lifecycle.signal,
      waitForAppActive: () => waitForMobileVoiceAppActive({
        isAppActive: () => AppState.currentState === 'active',
        subscribe: subscribeToAppState,
        signal: lifecycle.signal,
      }),
    });
    if (permission === 'cancelled') throw new MobileSpeakerEnrollmentAbortedError();
    if (permission === 'denied') throw new Error('microphone permission denied');
    if (stoppedEarly) throw new MobileSpeakerEnrollmentNoAudioError();
    removeBackgroundListener = subscribeToAppState((state) => {
      if (state !== 'active') onAbort();
    });
    stop = await startAudio({
      sampleRate: SPEAKER_GATE_SAMPLE_RATE,
      onChunk: (chunk) => {
        if (lifecycle.signal.aborted || stoppedEarly || samples >= targetSamples) return;
        const pcm = new Int16Array(chunk.pcm16.slice(0, chunk.pcm16.byteLength - (chunk.pcm16.byteLength % 2)));
        chunks.push(pcm);
        samples += pcm.length;
        options.onProgress?.(Math.min(1, samples / targetSamples));
        if (samples >= targetSamples) finish();
      },
      onError: (error) => {
        failure = error;
        finish();
      },
    });
    watchdog = setTimeout(finish, options.durationMs + NO_AUDIO_GRACE_MS);
    await done;
  } catch (error) {
    if (lifecycle.signal.aborted) throw new MobileSpeakerEnrollmentAbortedError();
    throw error;
  } finally {
    clearTimeout(watchdog);
    removeBackgroundListener?.();
    options.signal?.removeEventListener('abort', onAbort);
    options.stopSignal?.removeEventListener('abort', onStop);
    await stop?.().catch(() => undefined);
  }
  if (lifecycle.signal.aborted || options.signal?.aborted) throw new MobileSpeakerEnrollmentAbortedError();
  if (failure) throw failure;
  if (samples === 0 || (!stoppedEarly && samples < targetSamples)) throw new MobileSpeakerEnrollmentNoAudioError();

  const out = new Int16Array(Math.min(samples, targetSamples));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out.buffer;
}
