import { createVoiceInputAudioProfile } from './audioProfile';
import { WebMicAudioEngine } from './WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from './workletUrl';

export type SpeakerEnrollmentClipOptions = {
  /** Same microphone the user dictates with, so the voiceprint matches it. */
  deviceId?: string;
  durationMs: number;
  /** Peak level of the latest chunk in [0, 1], for the recording meter. */
  onLevel?: (level: number) => void;
  /** Elapsed fraction in [0, 1]. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Finish and keep captured audio; `signal` instead cancels and discards it. */
  stopSignal?: AbortSignal;
};

export class SpeakerEnrollmentNoAudioError extends Error {
  constructor() {
    super('microphone delivered no audio');
    this.name = 'SpeakerEnrollmentNoAudioError';
  }
}

/** A stalled microphone fails the clip instead of hanging the dialog. */
const NO_AUDIO_GRACE_MS = 5_000;

export class SpeakerEnrollmentAbortedError extends Error {
  constructor() {
    super('speaker enrollment recording aborted');
    this.name = 'SpeakerEnrollmentAbortedError';
  }
}

/**
 * Records one read-aloud clip for voiceprint enrollment as PCM16 mono 16 kHz.
 *
 * Uses the dictation capture profile (same processing, no keep-alive) so the
 * enrolled voice sounds like the audio the gate later judges. Stops by
 * itself at `durationMs` or on `stopSignal`; aborting `signal` discards the clip.
 */
export async function recordSpeakerEnrollmentClip(options: SpeakerEnrollmentClipOptions): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new SpeakerEnrollmentAbortedError();
  if (options.stopSignal?.aborted) throw new SpeakerEnrollmentNoAudioError();
  const engine = new WebMicAudioEngine({
    workletUrl: getVoiceInputWorkletUrl(),
    deviceId: options.deviceId,
    ...createVoiceInputAudioProfile(false),
  });
  const chunks: Int16Array[] = [];
  let samples = 0;
  const targetSamples = Math.round((options.durationMs / 1000) * 16_000);
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

  engine.onPcm16k(({ pcm16k }) => {
    if (options.signal?.aborted || stoppedEarly || samples >= targetSamples) return;
    const chunk = new Int16Array(pcm16k.slice(0));
    chunks.push(chunk);
    samples += chunk.length;
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const value = Math.abs(chunk[i]);
      if (value > peak) peak = value;
    }
    options.onLevel?.(peak / 32768);
    options.onProgress?.(Math.min(1, samples / targetSamples));
    if (samples >= targetSamples) finish();
  });

  const onAbort = (): void => finish();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await engine.start();
    watchdog = setTimeout(() => {
      stalled = true;
      finish();
    }, options.durationMs + NO_AUDIO_GRACE_MS);
    await done;
  } finally {
    clearTimeout(watchdog);
    options.signal?.removeEventListener('abort', onAbort);
    options.stopSignal?.removeEventListener('abort', onStop);
    await engine.stop().catch(() => undefined);
  }
  if (options.signal?.aborted) throw new SpeakerEnrollmentAbortedError();
  if (samples === 0 || (stalled && !stoppedEarly && samples < targetSamples)) throw new SpeakerEnrollmentNoAudioError();

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
