/**
 * Dictation for the question card's free-text answer.
 *
 * Reuses the same microphone session, start guards, and main-process voice
 * controller as the composer. The composer hook inserts into a TipTap editor;
 * this one inserts into the answer string, because the card's field is a
 * textarea and the composer is unmounted while the card is showing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FailedVoiceAudioAccumulator,
  FAILED_VOICE_AUDIO_TTL_MS,
  isRetainedFailedVoiceAudioExpired,
  shouldRetainFailedVoiceAudio,
  type RetainedFailedVoiceAudio,
  type VoiceInputErrorCode,
  type VoiceInputRendererEvent,
  type VoiceInputState,
} from '@cindy/voice-input-core';

import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import {
  recordVoiceInputHistory,
  updateVoiceInputHistoryEntry,
} from '@/hooks/useVoiceInputHistory';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { getVoiceInputErrorMessageKey, VOICE_INPUT_ERROR_CODE_KEYS } from '@/voice-input/overlayErrors';
import { buildBaseVoiceInputRefinementContext } from '@/voice-input/refinementContextBuilder';
import {
  MAX_REFINEMENT_SIDE_CONTEXT_CHARS,
  takeContextHead,
  takeContextTail,
  VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
} from '@/voice-input/refinementContext';
import { resolveVoiceInputStartGuards } from '@/voice-input/startGuards';
import { startVoiceInputCaptureSession } from '@/voice-input/captureSession';
import { streamRetainedAudioToMain } from '@/voice-input/failedAudioReplay';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import {
  createStartCueEchoTracker,
  createStartCueGate,
  playVoiceInputEndCue,
  playVoiceInputStartCue,
  prepareVoiceInputCues,
  type StartCueEchoTracker,
  type StartCueGate,
} from '@/voice-input/startCue';
import {
  isVoiceInputEventScopeActive,
  dispatchVoiceInputEvent,
} from '@/voice-input/eventScope';
import { useSpeakerFilterNotice } from '@/voice-input/useSpeakerFilterNotice';
import type { RecordingSamplesRef } from '@/voice-input/ComposerRecordingBars';
import type { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { useTranslation } from 'react-i18next';

import { replaceUneditedSpan, spliceText, type TextRange } from './askUserDictation';

const log = createLogger('ask-user-dictation');

export type AskUserDictationTarget = {
  getText: () => string;
  setText: (value: string) => void;
  getSelection: () => TextRange;
  focus: () => void;
};

export type UseAskUserDictationOptions = {
  onPermissionRequired?: (error: string) => void | Promise<void>;
};

type Anchor = { text: string; range: TextRange };
type SubmittedSpan = {
  range: TextRange;
  text: string;
  rawText: string;
  beforeSpanText: string;
  historyId: string | null;
};

type AskUserUndoState = {
  stage: 'refined' | 'raw';
  range: TextRange;
  beforeSpanText: string;
  rawText: string;
  refinedText: string;
  historyId: string | null;
};

function supportsSystemAudioMute(): boolean {
  const platform = window.electronAPI?.platform;
  return platform === 'darwin' || platform === 'win32';
}

export function useAskUserDictation(
  target: AskUserDictationTarget,
  options?: UseAskUserDictationOptions,
): {
  state: VoiceInputState;
  captureReady: boolean;
  isBusy: boolean;
  liveText: string | null;
  lastError: string | null;
  canRetryRecognition: boolean;
  /** The voiceprint filter just muted someone else's speech in this run. */
  speakerFiltered: boolean;
  canUndoRefinement: boolean;
  undoRefinement: () => boolean;
  handleUndoKeyDown: (event: KeyboardEvent) => boolean;
  samplesRef: RecordingSamplesRef;
  start: () => boolean;
  retryRecognition: () => boolean;
  stop: () => Promise<boolean>;
  cancel: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceInputState>('idle');
  const [captureReady, setCaptureReady] = useState(false);
  const [liveText, setLiveText] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [canRetryRecognition, setCanRetryRecognition] = useState(false);
  const {
    visible: speakerFiltered,
    show: showSpeakerFiltered,
    clear: clearSpeakerFiltered,
  } = useSpeakerFilterNotice();
  const stateRef = useRef<VoiceInputState>('idle');
  const targetRef = useRef(target);
  const optionsRef = useRef(options);
  const attemptRef = useRef(0);
  const runIdRef = useRef<string | null>(null);
  const engineRef = useRef<WebMicAudioEngine | null>(null);
  const startCueGateRef = useRef<StartCueGate | null>(null);
  const startCueEchoTrackerRef = useRef<StartCueEchoTracker>(createStartCueEchoTracker());
  const anchorRef = useRef<Anchor | null>(null);
  const submittedRef = useRef<SubmittedSpan | null>(null);
  const undoStateRef = useRef<AskUserUndoState | null>(null);
  const [canUndoRefinement, setCanUndoRefinement] = useState(false);
  const stopInFlightRef = useRef<Promise<boolean> | null>(null);
  const completionRef = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);
  const draftTextRef = useRef<string | null>(null);
  const startReadyRef = useRef<Promise<void>>(Promise.resolve());
  const mutedRef = useRef(false);
  const pendingMuteRef = useRef<Promise<void> | null>(null);
  const samplesRef = useRef<RecordingSamplesRef['current']>(null);
  const audioAccumulatorRef = useRef(new FailedVoiceAudioAccumulator());
  const retainedAudioRef = useRef<RetainedFailedVoiceAudio | null>(null);
  const retainedAudioTimerRef = useRef<number | null>(null);
  const retryingRef = useRef(false);
  targetRef.current = target;
  optionsRef.current = options;

  const clearRetainedAudio = useCallback(() => {
    if (retainedAudioTimerRef.current !== null) {
      window.clearTimeout(retainedAudioTimerRef.current);
      retainedAudioTimerRef.current = null;
    }
    retainedAudioRef.current = null;
    retryingRef.current = false;
    setCanRetryRecognition(false);
  }, []);

  const retainFailedAudioIfEligible = useCallback((flags?: {
    cancelled?: boolean;
    permissionDenied?: boolean;
    captureFailed?: boolean;
  }) => {
    if (retryingRef.current) {
      retryingRef.current = false;
      if (retainedAudioRef.current && !isRetainedFailedVoiceAudioExpired(retainedAudioRef.current)) {
        setCanRetryRecognition(true);
        return;
      }
      clearRetainedAudio();
      return;
    }
    const attemptKey = `ask-${attemptRef.current}`;
    if (
      !flags?.cancelled &&
      !flags?.permissionDenied &&
      !flags?.captureFailed &&
      retainedAudioRef.current?.id === attemptKey &&
      !isRetainedFailedVoiceAudioExpired(retainedAudioRef.current)
    ) {
      setCanRetryRecognition(true);
      return;
    }
    const eligible = shouldRetainFailedVoiceAudio({
      hasSound: audioAccumulatorRef.current.hasSound,
      transcriptLanded: submittedRef.current !== null,
      cancelled: Boolean(flags?.cancelled),
      permissionDenied: flags?.permissionDenied,
      captureFailed: flags?.captureFailed,
    });
    const snapshot = eligible
      ? audioAccumulatorRef.current.snapshot(attemptKey)
      : null;
    audioAccumulatorRef.current.clear();
    if (!snapshot) {
      clearRetainedAudio();
      return;
    }
    if (retainedAudioTimerRef.current !== null) {
      window.clearTimeout(retainedAudioTimerRef.current);
    }
    retainedAudioRef.current = snapshot;
    setCanRetryRecognition(true);
    retainedAudioTimerRef.current = window.setTimeout(() => {
      retainedAudioTimerRef.current = null;
      retainedAudioRef.current = null;
      setCanRetryRecognition(false);
    }, FAILED_VOICE_AUDIO_TTL_MS);
  }, [clearRetainedAudio]);

  const setVoiceState = useCallback((next: VoiceInputState) => {
    if (next === 'error' && !submittedRef.current && draftTextRef.current !== null) {
      targetRef.current.setText(draftTextRef.current);
      draftTextRef.current = null;
    }
    stateRef.current = next;
    setState(next);
    if (next === 'done' || next === 'error' || next === 'idle') {
      completionRef.current?.resolve(next === 'done');
    }
  }, []);

  const formatError = useCallback((message: string, code?: VoiceInputErrorCode) => {
    if (code) return t(VOICE_INPUT_ERROR_CODE_KEYS[code]);
    const key = getVoiceInputErrorMessageKey(message);
    return key ? t(key) : message;
  }, [t]);

  const reportError = useCallback((message: string) => {
    setLastError(message);
    toast.error(message);
  }, []);

  const restoreMute = useCallback(async () => {
    // The mute IPC is fire-and-forget at start. Waiting for it here keeps a
    // fast failure from skipping the restore and leaving the system muted.
    const pendingMute = pendingMuteRef.current;
    if (pendingMute) await pendingMute;
    if (!mutedRef.current || !supportsSystemAudioMute()) return;
    mutedRef.current = false;
    try {
      await window.electronAPI.voiceInput.restoreSystemAudio();
    } catch (error) {
      log.warn('restore system audio failed', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const stopEngine = useCallback(async () => {
    // The attempt is ending: nothing is left for the start cue to wait for.
    startCueGateRef.current?.abandon();
    startCueEchoTrackerRef.current.reset();
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.drainBufferedAudio();
    } catch (error) {
      log.warn('drain microphone failed', error instanceof Error ? error.message : String(error));
    } finally {
      // Retain ownership while draining the final PCM, then revoke it before
      // stop waits on getUserMedia so a late capture cannot reopen this take.
      if (engineRef.current === engine) engineRef.current = null;
      await engine.stop().catch((error) => {
        log.warn('stop microphone failed', error instanceof Error ? error.message : String(error));
      });
    }
    try {
      await window.electronAPI.voiceInput.drainAudioQueue?.();
    } catch (error) {
      log.warn('drain audio queue failed', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const fail = useCallback(async (message: string, flags?: { captureFailed?: boolean; permissionDenied?: boolean }) => {
    attemptRef.current += 1;
    const runId = runIdRef.current;
    runIdRef.current = null;
    anchorRef.current = null;
    setLiveText(null);
    await stopEngine();
    retainFailedAudioIfEligible(flags);
    setVoiceState('error');
    reportError(message);
    await restoreMute();
    try {
      if (runId) await window.electronAPI.voiceInput.cancel({ runId });
    } catch {
      /* The run may never have started. */
    }
  }, [reportError, restoreMute, retainFailedAudioIfEligible, setVoiceState, stopEngine]);

  useEffect(() => {
    const subscribe = window.electronAPI?.voiceInput?.onEvent;
    if (!subscribe) return;
    let subscribed = true;
    const unsubscribe = subscribe((event: VoiceInputRendererEvent) => {
      const attempt = attemptRef.current;
      dispatchVoiceInputEvent(
        event,
        () => subscribed ? runIdRef.current : null,
        startReadyRef.current.then(() => (
          attemptRef.current === attempt && runIdRef.current
            ? { ok: true as const, runId: runIdRef.current }
            : { ok: false as const }
        )),
        handleEvent,
      );
    });
    function handleEvent(event: VoiceInputRendererEvent): void {
      if (event.type === 'draft') {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const value = spliceText(anchor.text, anchor.range, event.text).value;
        draftTextRef.current = value;
        setLiveText(value);
        return;
      }
      if (event.type === 'submitted') {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const beforeSpanText = anchor.text.slice(anchor.range.start, anchor.range.end);
        const rawText = event.segment.basedOnText ?? event.text;
        const next = spliceText(anchor.text, anchor.range, event.text);
        const historyId = recordVoiceInputHistory(event.text);
        submittedRef.current = {
          range: next.range,
          text: event.text,
          rawText,
          beforeSpanText,
          historyId,
        };
        if (rawText !== event.text) {
          undoStateRef.current = {
            stage: 'refined',
            range: next.range,
            beforeSpanText,
            rawText,
            refinedText: event.text,
            historyId,
          };
          setCanUndoRefinement(true);
        } else {
          undoStateRef.current = null;
          setCanUndoRefinement(false);
        }
        anchorRef.current = { text: next.value, range: next.range };
        targetRef.current.setText(next.value);
        setLiveText(next.value);
        audioAccumulatorRef.current.clear();
        clearRetainedAudio();
        return;
      }
      if (event.type === 'refinement-preview') {
        const submitted = submittedRef.current;
        if (!submitted) return;
        const preview = spliceText(targetRef.current.getText(), submitted.range, event.text);
        setLiveText(preview.value);
        return;
      }
      if (event.type === 'refined') {
        const submitted = submittedRef.current;
        if (!submitted) return;
        const basedOn = event.segment.basedOnText ?? submitted.rawText ?? submitted.text;
        const next = replaceUneditedSpan(
          targetRef.current.getText(),
          submitted.range,
          [submitted.text, basedOn],
          event.text,
        );
        setLiveText(null);
        if (!next) return;
        submittedRef.current = { ...submitted, range: next.range, text: event.text };
        if (basedOn !== event.text) {
          undoStateRef.current = {
            stage: 'refined',
            range: next.range,
            beforeSpanText: submitted.beforeSpanText,
            rawText: basedOn,
            refinedText: event.text,
            historyId: submitted.historyId,
          };
          setCanUndoRefinement(true);
        }
        targetRef.current.setText(next.value);
        if (submitted.historyId) updateVoiceInputHistoryEntry(submitted.historyId, event.text);
        return;
      }
      if (event.type === 'state') {
        if (event.state === 'listening' && stopInFlightRef.current) return;
        setVoiceState(event.state);
        if (event.state === 'done' || event.state === 'error') {
          anchorRef.current = null;
          setLiveText(null);
          if (event.state === 'error') {
            // The controller has given up before the closing `error` event
            // arrives, so release the microphone now. Keep runIdRef so that
            // error event still passes the ownership check below.
            void stopEngine();
            void restoreMute();
            return;
          }
          runIdRef.current = null;
        }
        return;
      }
      if (event.type === 'speaker-filtered') {
        showSpeakerFiltered();
        return;
      }
      if (event.type === 'error') {
        const kept = event.transcriptKept === true && submittedRef.current !== null;
        const message = formatError(event.message, event.code);
        retainFailedAudioIfEligible();
        reportError(kept ? t('voiceInputOverlay.transcriptKept', { message }) : message);
        setVoiceState('error');
        setLiveText(null);
        runIdRef.current = null;
        void stopEngine();
        void restoreMute();
      }
    }
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [clearRetainedAudio, formatError, reportError, restoreMute, retainFailedAudioIfEligible, setVoiceState, showSpeakerFiltered, stopEngine, t]);

  const start = useCallback((): boolean => {
    const api = window.electronAPI?.voiceInput;
    if (!api?.start) return false;
    const current = stateRef.current;
    if (
      stopInFlightRef.current
      || current === 'listening'
      || current === 'submitting'
      || current === 'refining'
    ) return false;

    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    const selection = targetRef.current.getSelection();
    anchorRef.current = { text: targetRef.current.getText(), range: selection };
    submittedRef.current = null;
    undoStateRef.current = null;
    setCanUndoRefinement(false);
    draftTextRef.current = null;
    let resolveCompletion!: (ok: boolean) => void;
    const completion = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    completionRef.current = { promise: completion, resolve: resolveCompletion };
    runIdRef.current = null;
    audioAccumulatorRef.current.clear();
    clearRetainedAudio();
    setLastError(null);
    clearSpeakerFiltered();
    setCaptureReady(false);
    setLiveText(null);
    setVoiceState('listening');
    let resolveStartReady: () => void = () => undefined;
    startReadyRef.current = new Promise<void>((resolve) => {
      resolveStartReady = resolve;
    });

    void (async () => {
      try {
      const settings = getVoiceInputSettings();
      // The start cue and system mute both touch the speakers; hold them until the
      // microphone is open so capture does not queue behind that (see createStartCueGate).
      const cueGate = createStartCueGate();
      startCueGateRef.current = cueGate;
      const cueEchoTracker = createStartCueEchoTracker();
      startCueEchoTrackerRef.current = cueEchoTracker;
      // Like the composer, retain opening words while readiness is checked.
      const capturePromise = startVoiceInputCaptureSession({
        label: 'ask-user',
        workletUrl: getVoiceInputWorkletUrl(),
        deviceId: settings.microphoneDeviceId ?? undefined,
        fastActivationEnabled: settings.fastActivationEnabled,
        getRunId: () => runIdRef.current,
        setEngine: (engine) => { engineRef.current = engine; },
        isCurrentEngine: (engine) => attemptRef.current === attempt && engineRef.current === engine,
        onCaptureReady: () => {
          cueGate.release();
          if (attemptRef.current === attempt && stateRef.current === 'listening') setCaptureReady(true);
        },
        onPcmCaptured: (pcm) => audioAccumulatorRef.current.append(pcm),
        isInStartCueEchoWindow: () => cueEchoTracker.isInEchoWindow(),
        onSamples: (pcm) => samplesRef.current?.(pcm),
        appendAudioChunk: (chunk) => { api.appendAudio(chunk); },
        onInterrupted: (message) => { if (attemptRef.current === attempt) void fail(message, { captureFailed: true }); },
        onStateChange: () => undefined,
        getFallbackMessage: () => t('settings.voiceInput.microphone.errors.fallbackToAuto'),
        onFallback: (message) => toast.warning(message),
        formatStartError: (error) => error instanceof Error ? error.message : String(error),
      });
      if (settings.playInteractionSound) prepareVoiceInputCues();
      const feedback: Promise<unknown> = cueGate.released.then((play) => {
        if (!play || !settings.playInteractionSound) return;
        if (attemptRef.current !== attempt || stateRef.current !== 'listening') return;
        cueEchoTracker.markCueStarted();
        return playVoiceInputStartCue().finally(() => {
          cueEchoTracker.markCueEnded();
        });
      });
      // A capture that never becomes ready has nothing to wait for; do not
      // leave system mute waiting for the cap.
      void capturePromise.then((capture) => { if (!capture.ok) cueGate.abandon(); });
      if (settings.muteSystemAudio && supportsSystemAudioMute()) {
        const muteRequest = feedback.catch(() => undefined).then(async () => {
          if (attemptRef.current !== attempt || stateRef.current !== 'listening') return;
          const result = await api.muteSystemAudio();
          if (result.ok) mutedRef.current = true;
        }).catch(() => undefined).finally(() => {
          if (pendingMuteRef.current === muteRequest) pendingMuteRef.current = null;
        });
        pendingMuteRef.current = muteRequest;
      } else {
        void feedback.catch(() => undefined);
      }

      let guards: Awaited<ReturnType<typeof resolveVoiceInputStartGuards>>;
      try {
        guards = await resolveVoiceInputStartGuards();
      } catch (error) {
        if (attemptRef.current !== attempt) return;
        await fail(error instanceof Error ? error.message : String(error));
        return;
      }
      if (attemptRef.current !== attempt) return;
      if (!guards.ok) {
        const message = guards.permission.ok
          ? (guards.readiness.error ?? t('settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing'))
          : guards.permission.error;
        setVoiceState('error');
        anchorRef.current = null;
        await stopEngine();
        if (!guards.permission.ok) {
          await optionsRef.current?.onPermissionRequired?.(guards.permission.error);
        } else {
          reportError(message);
        }
        await restoreMute();
        return;
      }

      // Start cloud ASR session in parallel with microphone/AudioWorklet init
      // (matching useVoiceInput) instead of blocking api.start() behind capturePromise.
      const anchor = anchorRef.current;
      const text = anchor?.text ?? '';
      const range = anchor?.range ?? { start: text.length, end: text.length };
      const baseContext = buildBaseVoiceInputRefinementContext({ settings });
      const startPromise: Promise<{ ok: true; runId: string } | { ok: false; error: string }> = Promise.resolve()
        .then(() => api.start({
          sourceLanguage: settings.language,
          refinementEnabled: settings.refinementEnabled,
          refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
          refinementContext: settings.refinementEnabled
            ? {
                ...baseContext,
                selectionBefore: takeContextTail(text.slice(0, range.start), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
                selectedText: takeContextHead(text.slice(range.start, range.end), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
                selectionAfter: takeContextHead(text.slice(range.end), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
              }
            : undefined,
        }))
        .catch((error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));

      const capture = await capturePromise;
      if (attemptRef.current !== attempt) {
        void startPromise.then((res) => { if (res.ok) void api.cancel({ runId: res.runId }); });
        return;
      }
      if (!capture.ok) {
        void startPromise.then((res) => { if (res.ok) void api.cancel({ runId: res.runId }); });
        if (capture.cancelled) {
          setVoiceState('idle');
          anchorRef.current = null;
          await restoreMute();
          return;
        }
        if (capture.permissionDenied) {
          setVoiceState('error');
          anchorRef.current = null;
          audioAccumulatorRef.current.clear();
          clearRetainedAudio();
          await optionsRef.current?.onPermissionRequired?.(capture.error);
          await restoreMute();
          return;
        }
        await fail(capture.error, { captureFailed: true });
        return;
      }

      const started = await startPromise;
      if (attemptRef.current !== attempt) {
        if (started.ok) void api.cancel({ runId: started.runId });
        return;
      }
      if (!started.ok) {
        await fail(formatError(started.error));
        return;
      }
      runIdRef.current = started.runId;
      capture.drainPendingChunks();
      } catch (error) {
        if (attemptRef.current === attempt) await fail(formatError(error instanceof Error ? error.message : String(error)));
      } finally {
        resolveStartReady();
      }
    })();
    return true;
  }, [clearRetainedAudio, clearSpeakerFiltered, fail, formatError, reportError, restoreMute, setVoiceState, stopEngine, t]);

  const retryRecognition = useCallback((): boolean => {
    const api = window.electronAPI?.voiceInput;
    const retained = retainedAudioRef.current;
    if (!api?.start || !retained || isRetainedFailedVoiceAudioExpired(retained)) {
      clearRetainedAudio();
      return false;
    }
    const current = stateRef.current;
    if (
      stopInFlightRef.current
      || current === 'listening'
      || current === 'submitting'
      || current === 'refining'
    ) return false;

    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    const selection = targetRef.current.getSelection();
    anchorRef.current = { text: targetRef.current.getText(), range: selection };
    submittedRef.current = null;
    draftTextRef.current = null;
    retryingRef.current = true;
    let resolveCompletion!: (ok: boolean) => void;
    const completion = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    completionRef.current = { promise: completion, resolve: resolveCompletion };
    runIdRef.current = null;
    setLastError(null);
    clearSpeakerFiltered();
    setCaptureReady(false);
    setLiveText(null);
    setVoiceState('submitting');
    let resolveStartReady: () => void = () => undefined;
    startReadyRef.current = new Promise<void>((resolve) => {
      resolveStartReady = resolve;
    });

    void (async () => {
      try {
        const settings = getVoiceInputSettings();
        const anchor = anchorRef.current;
        const text = anchor?.text ?? '';
        const range = anchor?.range ?? { start: text.length, end: text.length };
        const baseContext = buildBaseVoiceInputRefinementContext({ settings });
        let started: { ok: true; runId: string } | { ok: false; error: string };
        try {
          started = await api.start({
            sourceLanguage: settings.language,
            refinementEnabled: settings.refinementEnabled,
            refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
            refinementContext: settings.refinementEnabled
              ? {
                  ...baseContext,
                  selectionBefore: takeContextTail(text.slice(0, range.start), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
                  selectedText: takeContextHead(text.slice(range.start, range.end), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
                  selectionAfter: takeContextHead(text.slice(range.end), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
                }
              : undefined,
          });
        } catch (error) {
          started = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (attemptRef.current !== attempt) {
          if (started.ok) void api.cancel({ runId: started.runId });
          return;
        }
        if (!started.ok) {
          await fail(formatError(started.error));
          return;
        }
        runIdRef.current = started.runId;
        resolveStartReady();
        const streamed = await streamRetainedAudioToMain(retained, () => attemptRef.current === attempt);
        if (!streamed || attemptRef.current !== attempt) return;
        const stopResult = await api.stop();
        if (attemptRef.current !== attempt) return;
        if (!stopResult.ok) {
          await fail(formatError(stopResult.error));
        }
      } catch (error) {
        if (attemptRef.current === attempt) await fail(formatError(error instanceof Error ? error.message : String(error)));
      } finally {
        resolveStartReady();
      }
    })();
    return true;
  }, [clearRetainedAudio, clearSpeakerFiltered, fail, formatError, setVoiceState]);

  const stop = useCallback(async () => {
    if (stopInFlightRef.current) return stopInFlightRef.current;
    const attempt = attemptRef.current;
    if (!isVoiceInputEventScopeActive(stateRef.current)) return stateRef.current === 'done';
    setVoiceState('submitting');
    const stopping = (async () => {
      try {
        const completion = completionRef.current;
        // Capture may already be live while the service is connecting. Stop it
        // before awaiting startup so post-press speech is not included.
        await stopEngine();
        // Cancellation/unmount settles completion even if startup IPC has not
        // returned. Release the submitter now; startup still cancels a late run.
        await (completion ? Promise.race([startReadyRef.current, completion.promise]) : startReadyRef.current);
        if (attemptRef.current !== attempt) return false;
        const settings = getVoiceInputSettings();
        if (settings.playInteractionSound) playVoiceInputEndCue();
        // Also release an engine whose startup finished after the first stop.
        await stopEngine();
        if (runIdRef.current) {
          if (stateRef.current === 'listening') setVoiceState('submitting');
          const result = await window.electronAPI.voiceInput.stop();
          if (attemptRef.current !== attempt) return false;
          if (!result.ok) {
            await fail(formatError(result.error));
            return false;
          }
        }
        // IPC acknowledgement and final transcript events are separate. Only
        // the terminal event proves that setText has received the final text.
        return completion ? await completion.promise : false;
      } catch (error) {
        if (attemptRef.current === attempt) await fail(formatError(error instanceof Error ? error.message : String(error)));
        return false;
      } finally {
        if (attemptRef.current === attempt) {
          await restoreMute();
          targetRef.current.focus();
        }
      }
    })();
    const finishing = stopping.finally(() => {
      if (stopInFlightRef.current === finishing) stopInFlightRef.current = null;
    });
    stopInFlightRef.current = finishing;
    return finishing;
  }, [fail, formatError, restoreMute, setVoiceState, stopEngine]);

  const cancel = useCallback(async () => {
    const attempt = ++attemptRef.current;
    const runId = runIdRef.current;
    runIdRef.current = null;
    anchorRef.current = null;
    draftTextRef.current = null;
    audioAccumulatorRef.current.clear();
    clearRetainedAudio();
    completionRef.current?.resolve(false);
    setLiveText(null);
    // Retain committed text, discard only the unsubmitted live preview.
    setVoiceState('submitting');
    try {
      await stopEngine();
    } finally {
      await restoreMute();
      if (runId) await window.electronAPI.voiceInput.cancel({ runId }).catch(() => undefined);
      if (attemptRef.current === attempt) {
        // Only the stopping promise releases its lock: main's old stop cleanup
        // must finish before another recording can become active.
        setVoiceState('idle');
        targetRef.current.focus();
      }
    }
  }, [restoreMute, setVoiceState, stopEngine]);

  useEffect(() => () => {
    attemptRef.current += 1;
    stateRef.current = 'idle';
    anchorRef.current = null;
    audioAccumulatorRef.current.clear();
    clearRetainedAudio();
    completionRef.current?.resolve(false);
    const runId = runIdRef.current;
    runIdRef.current = null;
    void stopEngine();
    void restoreMute();
    if (runId) void window.electronAPI?.voiceInput?.cancel?.({ runId });
  }, [clearRetainedAudio, restoreMute, stopEngine]);

  const undoRefinement = useCallback((): boolean => {
    const current = undoStateRef.current;
    if (!current || current.stage !== 'refined') return false;
    const replaced = replaceUneditedSpan(
      targetRef.current.getText(),
      current.range,
      [current.refinedText],
      current.rawText,
    );
    if (!replaced) {
      undoStateRef.current = null;
      setCanUndoRefinement(false);
      return false;
    }
    undoStateRef.current = { ...current, stage: 'raw', range: replaced.range };
    if (submittedRef.current) {
      submittedRef.current = { ...submittedRef.current, range: replaced.range, text: current.rawText };
    }
    targetRef.current.setText(replaced.value);
    if (current.historyId) updateVoiceInputHistoryEntry(current.historyId, current.rawText);
    setCanUndoRefinement(false);
    return true;
  }, []);

  const handleUndoKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (
      event.isComposing
      || event.altKey
      || event.shiftKey
      || !(event.metaKey || event.ctrlKey)
      || event.key.toLowerCase() !== 'z'
    ) {
      return false;
    }
    const current = undoStateRef.current;
    if (!current) return false;
    if (current.stage === 'refined') return undoRefinement();
    const replaced = replaceUneditedSpan(
      targetRef.current.getText(),
      current.range,
      [current.rawText],
      current.beforeSpanText,
    );
    undoStateRef.current = null;
    if (!replaced) return false;
    targetRef.current.setText(replaced.value);
    return true;
  }, [undoRefinement]);

  return {
    state,
    captureReady,
    isBusy: state === 'listening' || state === 'submitting' || state === 'refining',
    liveText,
    lastError,
    canRetryRecognition,
    speakerFiltered,
    canUndoRefinement,
    undoRefinement,
    handleUndoKeyDown,
    samplesRef,
    start,
    retryRecognition,
    stop,
    cancel,
  };
}
