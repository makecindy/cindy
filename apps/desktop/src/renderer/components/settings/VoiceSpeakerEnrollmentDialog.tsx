import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Mic, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { requestRendererMicrophonePermission } from '@/voice-input/startGuards';
import {
  recordSpeakerEnrollmentClip,
  SpeakerEnrollmentAbortedError,
  SpeakerEnrollmentNoAudioError,
} from '@/voice-input/speakerEnrollmentRecorder';
import {
  VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT,
  VOICE_SPEAKER_ENROLLMENT_TARGET_CLIP_SEC,
  type VoiceSpeakerEnrollResult,
  type VoiceSpeakerFilterStatus,
} from '../../../shared/voiceSpeakerFilter';

const log = createLogger('VoiceSpeakerEnrollmentDialog');
const CLIP_INDEXES = Array.from({ length: VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT }, (_, index) => index);

type EnrollErrorKey = Extract<VoiceSpeakerEnrollResult, { ok: false }>['reason'] | 'microphone' | 'noAudio';

type EnrollError = { key: EnrollErrorKey; clipIndex?: number };

interface VoiceSpeakerEnrollmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The microphone chosen for dictation; enrollment must record from it. */
  microphoneDeviceId: string | null;
  onEnrolled: (status: VoiceSpeakerFilterStatus) => void;
}

/**
 * Reads three short passages aloud to build the voiceprint. Each clip records
 * up to 30 seconds or until the user finishes; any clip can be re-recorded, and main
 * points at the clip to redo when one does not match the others.
 */
export function VoiceSpeakerEnrollmentDialog({
  open,
  onOpenChange,
  microphoneDeviceId,
  onEnrolled,
}: VoiceSpeakerEnrollmentDialogProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  // The model covers Chinese and English; other UI locales use English passages.
  const passageLanguage = language === 'zh-CN' || language === 'zh-TW' ? language : 'en';
  const [clips, setClips] = useState<Array<ArrayBuffer | null>>(() => CLIP_INDEXES.map(() => null));
  const [current, setCurrent] = useState(0);
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [level, setLevel] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<EnrollError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const recordButtonRef = useRef<HTMLButtonElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopRef.current = null;
    setClips(CLIP_INDEXES.map(() => null));
    setCurrent(0);
    setRecording(false);
    setProgress(0);
    setLevel(0);
    setSubmitting(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Never leave the microphone open behind an unmounted dialog.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Recording disables the buttons and drops focus; hand it back to the next step.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = recording || submitting;
    if (wasBusy.current && !busy && open) {
      const done = clipsRef.current.every((clip) => clip !== null);
      (done ? submitButtonRef : recordButtonRef).current?.focus();
    }
    wasBusy.current = busy;
  }, [open, recording, submitting]);

  const record = useCallback(async () => {
    if (abortRef.current || recording || submitting) return;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const stopController = new AbortController();
    stopRef.current = stopController;
    const index = current;
    setRecording(true);
    setProgress(0);
    setLevel(0);
    try {
      const permission = await requestRendererMicrophonePermission();
      if (controller.signal.aborted) return;
      if (!permission.ok) {
        setError({ key: 'microphone' });
        return;
      }
      const clip = await recordSpeakerEnrollmentClip({
        deviceId: microphoneDeviceId ?? undefined,
        durationMs: VOICE_SPEAKER_ENROLLMENT_TARGET_CLIP_SEC * 1000,
        onLevel: (value) => {
          if (!controller.signal.aborted) setLevel(value);
        },
        onProgress: (value) => {
          if (!controller.signal.aborted) setProgress(value);
        },
        signal: controller.signal,
        stopSignal: stopController.signal,
      });
      if (controller.signal.aborted) return;
      const next = [...clipsRef.current];
      next[index] = clip;
      setClips(next);
      const nextEmpty = CLIP_INDEXES.find((candidate) => !next[candidate]);
      if (nextEmpty !== undefined) setCurrent(nextEmpty);
    } catch (recordError) {
      if (controller.signal.aborted || recordError instanceof SpeakerEnrollmentAbortedError) return;
      log.warn('enrollment recording failed:', recordError instanceof Error ? recordError.message : String(recordError));
      setError({ key: recordError instanceof SpeakerEnrollmentNoAudioError ? 'noAudio' : 'microphone' });
    } finally {
      if (abortRef.current === controller && !controller.signal.aborted) {
        abortRef.current = null;
        stopRef.current = null;
        setRecording(false);
        setLevel(0);
      }
    }
  }, [current, microphoneDeviceId, recording, submitting]);

  const submit = useCallback(async () => {
    const ready = clips.every((clip): clip is ArrayBuffer => clip !== null);
    if (!ready || submitting || recording) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electronAPI.voiceInput.speakerFilter.enroll(clips as ArrayBuffer[]);
      if (result.ok) {
        onEnrolled(result.status);
        toast.success(t('settings.voiceInput.speakerFilter.enroll.done'));
        onOpenChange(false);
        return;
      }
      setError({ key: result.reason, clipIndex: result.clipIndex });
      if (result.clipIndex !== undefined) {
        const redo = result.clipIndex;
        setClips((previous) => previous.map((clip, index) => (index === redo ? null : clip)));
        setCurrent(redo);
      }
    } catch (enrollError) {
      log.warn('enrollment failed:', enrollError instanceof Error ? enrollError.message : String(enrollError));
      setError({ key: 'failed' });
    } finally {
      setSubmitting(false);
    }
  }, [clips, onEnrolled, onOpenChange, recording, submitting, t]);

  const allRecorded = clips.every((clip) => clip !== null);
  const errorText = error
    ? t(`settings.voiceInput.speakerFilter.enroll.errors.${error.key}`, {
        index: (error.clipIndex ?? 0) + 1,
      })
    : null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Saving cannot be interrupted; closing mid-recording just discards it.
        if (!next && submitting) return;
        if (!next) abortRef.current?.abort();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="modal-scrim fixed inset-0 z-50"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          // Land on the primary action, not on the first passage chip.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            recordButtonRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2',
            'flex flex-col gap-4 p-5 outline-none',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <div className="flex flex-col gap-1.5">
            <Dialog.Title className="text-18 font-semibold leading-[1.35] text-[var(--settings-section-title)]">
              {t('settings.voiceInput.speakerFilter.enroll.title')}
            </Dialog.Title>
            <Dialog.Description className="text-13 leading-[1.5] text-[var(--settings-section-sublabel)]">
              {t('settings.voiceInput.speakerFilter.enroll.description', {
                clips: VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT,
                seconds: VOICE_SPEAKER_ENROLLMENT_TARGET_CLIP_SEC,
              })}
            </Dialog.Description>
          </div>

          <div
            role="group"
            aria-label={t('settings.voiceInput.speakerFilter.enroll.stepsAriaLabel')}
            className="flex items-center gap-2"
          >
            {CLIP_INDEXES.map((index) => {
              const recorded = clips[index] !== null;
              const selected = index === current;
              return (
                <button
                  key={index}
                  type="button"
                  aria-current={selected ? 'step' : undefined}
                  disabled={recording || submitting}
                  onClick={() => {
                    setCurrent(index);
                    setError(null);
                  }}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full border px-3 text-12 font-medium transition-colors',
                    'disabled:cursor-default disabled:opacity-60',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                    selected
                      ? 'border-[var(--settings-section-title)] text-[var(--settings-section-title)]'
                      : 'border-[var(--settings-theme-card-border)] text-[var(--settings-section-sublabel)] hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                  )}
                >
                  {recorded ? <Check size={12} aria-hidden /> : null}
                  {t('settings.voiceInput.speakerFilter.enroll.step', {
                    current: index + 1,
                    total: VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT,
                  })}
                </button>
              );
            })}
          </div>

          <p
            className={cn(
              'rounded-xl border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4 py-3',
              'text-15 leading-[1.6] text-[var(--settings-section-title)]',
            )}
          >
            {t(`settings.voiceInput.speakerFilter.enroll.passages.p${current + 1}`, { lng: passageLanguage })}
          </p>

          <div className="flex min-h-8 items-center gap-3">
            <Button
              ref={recordButtonRef}
              variant="secondary"
              size="md"
              type="button"
              disabled={submitting || (recording && progress === 0)}
              onClick={() => {
                if (recording) stopRef.current?.abort();
                else void record();
              }}
            >
              {recording ? <Square size={14} /> : <Mic size={14} />}
              {t(
                recording
                  ? 'settings.voiceInput.speakerFilter.enroll.stop'
                  : clips[current]
                    ? 'settings.voiceInput.speakerFilter.enroll.rerecord'
                    : 'settings.voiceInput.speakerFilter.enroll.record',
              )}
            </Button>
            <p
              aria-live="polite"
              className="min-w-0 text-12 leading-[1.4] text-[var(--settings-section-sublabel)]"
            >
              {recording
                ? t('settings.voiceInput.speakerFilter.enroll.recording', {
                    seconds: Math.max(
                      0,
                      Math.ceil(VOICE_SPEAKER_ENROLLMENT_TARGET_CLIP_SEC * (1 - progress)),
                    ),
                  })
                : clips[current]
                  ? t('settings.voiceInput.speakerFilter.enroll.recorded')
                  : null}
            </p>
            {recording ? (
              <div
                aria-hidden
                className="ml-auto h-1 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--settings-theme-card-border)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--settings-section-title)] transition-[width] duration-75"
                  style={{ width: `${Math.round(Math.min(1, level * 3) * 100)}%` }}
                />
              </div>
            ) : null}
          </div>

          {errorText ? (
            <p role="alert" className="text-12 leading-[1.4] text-[var(--error-fg)]">
              {errorText}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary" size="lg" type="button" disabled={submitting}>
                {t('settings.voiceInput.speakerFilter.enroll.cancel')}
              </Button>
            </Dialog.Close>
            <Button
              ref={submitButtonRef}
              variant="cta"
              size="lg"
              type="button"
              loading={submitting}
              disabled={!allRecorded || recording}
              onClick={() => {
                void submit();
              }}
            >
              {t('settings.voiceInput.speakerFilter.enroll.submit')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
