import { createLogger } from '@/lib/logger';
import {
  WebMicAudioEngine,
  currentPowerReleaseGeneration,
  isMicrophonePermissionDeniedError,
  isPowerReleaseCancellation,
  isSelectedMicrophoneUnavailableError,
  powerReleaseCancellation,
  type PcmChunk,
} from './WebMicAudioEngine';
import { createVoiceInputAudioProfile } from './audioProfile';
import { hasPcmSound } from './pcmActivity';
import type { VoiceInputStartupTimeline } from './startupTimeline';

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
       * Startup was cancelled rather than broken — by its owner or a power
       * release (suspend / lock) landing mid-start. Callers should clean up
       * silently instead of surfacing `error`, which is an internal message.
       */
      cancelled?: boolean;
      /**
       * getUserMedia reported that microphone access is (no longer) allowed.
       * The start guard may have trusted a positive permission cache, so this
       * is the first place the revocation becomes visible; callers should show
       * the permission recovery UI now instead of a generic capture error.
       */
      permissionDenied?: boolean;
    };

type VoiceInputCaptureSessionOptions = {
  label: string;
  workletUrl: string;
  deviceId?: string;
  fastActivationEnabled: boolean;
  getRunId: () => string | null;
  setEngine: (engine: WebMicAudioEngine | null) => void;
  isCurrentEngine?: (engine: WebMicAudioEngine) => boolean;
  /** Fires once after the first PCM frame has been retained locally. */
  onCaptureReady?: () => void;
  /** Fires once when captured PCM contains sound, even before cloud startup. */
  onSoundDetected?: () => void;
  timeline?: VoiceInputStartupTimeline;
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
  let captureReady = false;
  let soundDetected = false;
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
      if (chunk.pcm16k.byteLength === 0) return;
      if (!soundDetected && hasPcmSound(chunk.pcm16k)) {
        soundDetected = true;
        options.onSoundDetected?.();
      }
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        options.timeline?.mark('first_pcm');
      }
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
        options.timeline?.mark('first_buffered_audio');
      } else {
        options.appendAudioChunk(chunk);
      }
      // System mute and cloud setup must never discard the user's opening
      // words. Readiness means PCM is retained, not merely engine.start() done.
      if (!captureReady) {
        captureReady = true;
        options.onCaptureReady?.();
      }
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
      if (options.isCurrentEngine && !options.isCurrentEngine(engine)) throw error;
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
      if (options.isCurrentEngine && !options.isCurrentEngine(engine)) throw error;
      engine = createEngine(undefined);
      options.setEngine(engine);
      await engine.start();
    }
  };

  try {
    options.timeline?.mark('microphone_requested');
    log.debug(message(options.label, 'microphone start requested'), { elapsedMs: options.elapsedMs?.() });
    await startEngineWithAutomaticFallback();
    // A cancellation can finish while getUserMedia is still pending. Never
    // leave the late device open or clear a newer attempt's engine reference.
    if (options.isCurrentEngine && !options.isCurrentEngine(engine)) {
      await engine.stop();
      return { ok: false, cancelled: true, error: 'Voice input start was cancelled.' };
    }
    options.timeline?.mark('engine_ready');
    void window.electronAPI.voiceInput.setRendererMicrophonePermissionVerified(true).catch(() => undefined);
    log.info(message(options.label, 'microphone started'), { elapsedMs: options.elapsedMs?.() });
  } catch (error) {
    if (options.isCurrentEngine && !options.isCurrentEngine(engine)) {
      await engine.stop().catch(() => undefined);
      return { ok: false, cancelled: true, error: options.formatStartError(error) };
    }
    if (!options.isCurrentEngine || options.isCurrentEngine(engine)) options.setEngine(null);
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
    // The real capture requests permission once and detects revocation. Keep
    // the cached UI snapshot in sync and show the existing recovery surface.
    if (isMicrophonePermissionDeniedError(error)) {
      log.warn(message(options.label, 'microphone permission denied during capture start'));
      void window.electronAPI.voiceInput
        .setRendererMicrophonePermissionVerified(false)
        .catch(() => undefined);
      return {
        ok: false,
        permissionDenied: true,
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
