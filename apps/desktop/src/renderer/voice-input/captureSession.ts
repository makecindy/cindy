import { createLogger } from '@/lib/logger';
import {
  WebMicAudioEngine,
  currentPowerReleaseGeneration,
  isPowerReleaseCancellation,
  isSelectedMicrophoneUnavailableError,
  powerReleaseCancellation,
  type PcmChunk,
} from './WebMicAudioEngine';
import { createVoiceInputAudioProfile } from './audioProfile';

const log = createLogger('voice-input-capture');

// Cap on the audio chunks captured before voice-input:start IPC settles.
// 1500 × ~40ms ≈ 60s. Slow start/auth/ASR connect buffers the user's opening
// words instead of silently dropping them after ~6s. Drop-on-overflow remains
// a last resort with a throttled warn so we can see when it actually trips.
const MAX_PENDING_AUDIO_CHUNKS = 1500;

export type VoiceInputCaptureSessionStartResult =
  | {
      ok: true;
      drainPendingChunks: () => void;
    }
  | {
      ok: false;
      error: string;
      /**
       * Startup was cancelled rather than broken — currently only by a power
       * release (suspend / lock) landing mid-start. Callers should clean up
       * silently instead of surfacing `error`, which is an internal message.
       */
      cancelled?: boolean;
    };

type VoiceInputCaptureSessionOptions = {
  label: string;
  workletUrl: string;
  deviceId?: string;
  fastActivationEnabled: boolean;
  getRunId: () => string | null;
  setEngine: (engine: WebMicAudioEngine | null) => void;
  isCurrentEngine?: (engine: WebMicAudioEngine) => boolean;
  canAcceptAudioChunk?: () => boolean;
  appendAudioChunk: (chunk: PcmChunk) => void;
  onInterrupted: (message: string) => void;
  onStateChange: (event: string, details?: Record<string, unknown>) => void;
  getFallbackMessage: () => string;
  onFallback: (message: string) => void;
  formatStartError: (error: unknown) => string;
  elapsedMs?: () => number;
};

function message(label: string, text: string): string {
  return label ? `${label} ${text}` : text;
}

export async function startVoiceInputCaptureSession(
  options: VoiceInputCaptureSessionOptions,
): Promise<VoiceInputCaptureSessionStartResult> {
  const pendingChunks: PcmChunk[] = [];
  let pendingOverflowWarnedAt = 0;
  let firstChunkLogged = false;
  let engine: WebMicAudioEngine;

  const createEngine = (deviceId?: string): WebMicAudioEngine => {
    const next = new WebMicAudioEngine({
      workletUrl: options.workletUrl,
      deviceId,
      ...createVoiceInputAudioProfile(options.fastActivationEnabled),
      onStateChange: options.onStateChange,
      onInterrupted: options.onInterrupted,
    });
    next.onPcm16k((chunk) => {
      if (options.isCurrentEngine && !options.isCurrentEngine(next)) return;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        log.debug(message(options.label, 'first pcm16k chunk'), chunk.trace);
      }
      if (options.canAcceptAudioChunk && !options.canAcceptAudioChunk()) return;
      if (!options.getRunId()) {
        if (pendingChunks.length >= MAX_PENDING_AUDIO_CHUNKS) {
          const now = Date.now();
          if (now - pendingOverflowWarnedAt > 1000) {
            pendingOverflowWarnedAt = now;
            const bufferedMs = pendingChunks.reduce(
              (sum, c) => sum + (c.trace.durationMs ?? 40),
              0,
            );
            log.warn(message(options.label, 'pending audio buffer overflow before start IPC settled, dropping oldest chunk'), {
              pendingChunks: pendingChunks.length,
              bufferedMs: Math.round(bufferedMs),
            });
          }
          pendingChunks.shift();
        }
        pendingChunks.push(chunk);
        return;
      }
      options.appendAudioChunk(chunk);
    });
    return next;
  };

  engine = createEngine(options.deviceId);
  options.setEngine(engine);
  const powerGenerationAtStart = currentPowerReleaseGeneration();

  const startEngineWithAutomaticFallback = async (): Promise<void> => {
    try {
      await engine.start();
      return;
    } catch (error) {
      if (!options.deviceId || !isSelectedMicrophoneUnavailableError(error)) {
        throw error;
      }
      const fallbackMessage = options.getFallbackMessage();
      log.warn(message(options.label, 'selected microphone unavailable, falling back to automatic microphone:'), fallbackMessage);
      options.onFallback(fallbackMessage);
      await engine.stop().catch((stopError) => {
        log.warn(
          message(options.label, 'stop unavailable microphone engine failed:'),
          stopError instanceof Error ? stopError.message : String(stopError),
        );
      });
      // A release can land during the stop() above, and by then no session error
      // carries the power reason any more — the check below would only see the
      // earlier device error and happily open the default microphone after the
      // one-shot event.
      if (currentPowerReleaseGeneration() !== powerGenerationAtStart) {
        throw powerReleaseCancellation();
      }
      engine = createEngine(undefined);
      options.setEngine(engine);
      await engine.start();
    }
  };

  try {
    log.debug(message(options.label, 'microphone start requested'), { elapsedMs: options.elapsedMs?.() });
    await startEngineWithAutomaticFallback();
    log.info(message(options.label, 'microphone started'), { elapsedMs: options.elapsedMs?.() });
  } catch (error) {
    options.setEngine(null);
    // Suspend/lock cancelling startup is the user walking away on purpose, not
    // a failure worth an error surface. Report it as cancellation so callers
    // clean up quietly instead of showing an internal message.
    if (isPowerReleaseCancellation(error)) {
      log.debug(message(options.label, 'microphone start cancelled by power release'));
      return {
        ok: false,
        cancelled: true,
        error: options.formatStartError(error),
      };
    }
    return {
      ok: false,
      error: options.formatStartError(error),
    };
  }

  return {
    ok: true,
    drainPendingChunks: () => {
      pendingChunks.splice(0).forEach((chunk) => options.appendAudioChunk(chunk));
    },
  };
}
