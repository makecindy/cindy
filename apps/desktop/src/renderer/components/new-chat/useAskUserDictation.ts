/**
 * Dictation for the question card's free-text answer.
 *
 * Reuses the same microphone session, start guards, and main-process voice
 * controller as the composer. The composer hook inserts into a TipTap editor;
 * this one inserts into the answer string, because the card's field is a
 * textarea and the composer is unmounted while the card is showing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceInputErrorCode, VoiceInputRendererEvent, VoiceInputState } from '@cindy/voice-input-core';

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
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import { playVoiceInputEndCue, playVoiceInputStartCue, prepareVoiceInputCues } from '@/voice-input/startCue';
import {
  isVoiceInputEventScopeActive,
  shouldHandleVoiceInputEvent,
} from '@/voice-input/eventScope';
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
type SubmittedSpan = { range: TextRange; text: string; historyId: string | null };

function supportsSystemAudioMute(): boolean {
  const platform = window.electronAPI?.platform;
  return platform === 'darwin' || platform === 'win32';
}

export function useAskUserDictation(
  target: AskUserDictationTarget,
  options?: UseAskUserDictationOptions,
): {
  state: VoiceInputState;
  isBusy: boolean;
  liveText: string | null;
  lastError: string | null;
  start: () => boolean;
  stop: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceInputState>('idle');
  const [liveText, setLiveText] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const stateRef = useRef<VoiceInputState>('idle');
  const targetRef = useRef(target);
  const optionsRef = useRef(options);
  const attemptRef = useRef(0);
  const runIdRef = useRef<string | null>(null);
  const engineRef = useRef<WebMicAudioEngine | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const submittedRef = useRef<SubmittedSpan | null>(null);
  const stopInFlightRef = useRef<Promise<void> | null>(null);
  const startReadyRef = useRef<Promise<void>>(Promise.resolve());
  const mutedRef = useRef(false);
  const pendingMuteRef = useRef<Promise<void> | null>(null);
  targetRef.current = target;
  optionsRef.current = options;

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setState(next);
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
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.drainBufferedAudio();
      await engine.stop();
    } finally {
      if (engineRef.current === engine) engineRef.current = null;
    }
    try {
      await window.electronAPI.voiceInput.drainAudioQueue?.();
    } catch (error) {
      log.warn('drain audio queue failed', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const fail = useCallback(async (message: string) => {
    attemptRef.current += 1;
    runIdRef.current = null;
    anchorRef.current = null;
    setLiveText(null);
    setVoiceState('error');
    reportError(message);
    await stopEngine();
    await restoreMute();
    try {
      await window.electronAPI.voiceInput.cancel();
    } catch {
      /* The run may never have started. */
    }
  }, [reportError, restoreMute, setVoiceState, stopEngine]);

  useEffect(() => {
    const subscribe = window.electronAPI?.voiceInput?.onEvent;
    if (!subscribe) return;
    return subscribe((event: VoiceInputRendererEvent) => {
      if (!shouldHandleVoiceInputEvent(
        runIdRef.current,
        event.runId,
        isVoiceInputEventScopeActive(stateRef.current),
      )) return;
      if (event.type === 'draft') {
        const anchor = anchorRef.current;
        if (!anchor) return;
        setLiveText(spliceText(anchor.text, anchor.range, event.text).value);
        return;
      }
      if (event.type === 'submitted') {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const next = spliceText(anchor.text, anchor.range, event.text);
        submittedRef.current = {
          range: next.range,
          text: event.text,
          historyId: recordVoiceInputHistory(event.text),
        };
        anchorRef.current = { text: next.value, range: next.range };
        targetRef.current.setText(next.value);
        setLiveText(next.value);
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
        const basedOn = event.segment.basedOnText ?? submitted.text;
        const next = replaceUneditedSpan(
          targetRef.current.getText(),
          submitted.range,
          [submitted.text, basedOn],
          event.text,
        );
        setLiveText(null);
        if (!next) return;
        submittedRef.current = { ...submitted, range: next.range, text: event.text };
        targetRef.current.setText(next.value);
        if (submitted.historyId) updateVoiceInputHistoryEntry(submitted.historyId, event.text);
        return;
      }
      if (event.type === 'state') {
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
      if (event.type === 'error') {
        const kept = event.transcriptKept === true && submittedRef.current !== null;
        const message = formatError(event.message, event.code);
        reportError(kept ? t('voiceInputOverlay.transcriptKept', { message }) : message);
        setVoiceState('error');
        setLiveText(null);
        runIdRef.current = null;
        void stopEngine();
        void restoreMute();
      }
    });
  }, [formatError, reportError, restoreMute, setVoiceState, stopEngine, t]);

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
    runIdRef.current = null;
    setLastError(null);
    setLiveText(null);
    setVoiceState('listening');
    let resolveStartReady: () => void = () => undefined;
    startReadyRef.current = new Promise<void>((resolve) => {
      resolveStartReady = resolve;
    });

    void (async () => {
      try {
      const settings = getVoiceInputSettings();
      if (settings.playInteractionSound) {
        prepareVoiceInputCues();
        void playVoiceInputStartCue();
      }
      if (settings.muteSystemAudio && supportsSystemAudioMute()) {
        const muteRequest = api.muteSystemAudio().then((result) => {
          if (result.ok) mutedRef.current = true;
        }).catch(() => undefined).finally(() => {
          if (pendingMuteRef.current === muteRequest) pendingMuteRef.current = null;
        });
        pendingMuteRef.current = muteRequest;
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
        if (!guards.permission.ok) {
          await optionsRef.current?.onPermissionRequired?.(guards.permission.error);
        } else {
          reportError(message);
        }
        await restoreMute();
        return;
      }

      const capture = await startVoiceInputCaptureSession({
        label: 'ask-user',
        workletUrl: getVoiceInputWorkletUrl(),
        deviceId: settings.microphoneDeviceId ?? undefined,
        fastActivationEnabled: settings.fastActivationEnabled,
        getRunId: () => runIdRef.current,
        setEngine: (engine) => {
          engineRef.current = engine;
        },
        isCurrentEngine: (engine) => engineRef.current === engine,
        appendAudioChunk: (chunk) => {
          window.electronAPI.voiceInput.appendAudio(chunk);
        },
        onInterrupted: (message) => {
          if (attemptRef.current === attempt) void fail(message);
        },
        onStateChange: () => undefined,
        getFallbackMessage: () => t('settings.voiceInput.microphone.errors.fallbackToAuto'),
        onFallback: (message) => toast.warning(message),
        formatStartError: (error) => (error instanceof Error ? error.message : String(error)),
      });
      if (attemptRef.current !== attempt) return;
      if (!capture.ok) {
        if (capture.cancelled) {
          setVoiceState('idle');
          anchorRef.current = null;
          await restoreMute();
          return;
        }
        if (capture.permissionDenied) {
          setVoiceState('error');
          anchorRef.current = null;
          await optionsRef.current?.onPermissionRequired?.(capture.error);
          await restoreMute();
          return;
        }
        await fail(capture.error);
        return;
      }

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
      capture.drainPendingChunks();
      } finally {
        resolveStartReady();
      }
    })();
    return true;
  }, [fail, formatError, reportError, restoreMute, setVoiceState, t]);

  const stop = useCallback(async () => {
    if (stopInFlightRef.current) return stopInFlightRef.current;
    const stopping = (async () => {
      await startReadyRef.current;
      const settings = getVoiceInputSettings();
      if (settings.playInteractionSound) playVoiceInputEndCue();
      await stopEngine();
      if (!runIdRef.current) {
        await restoreMute();
        targetRef.current.focus();
        return;
      }
      try {
        const result = await window.electronAPI.voiceInput.stop();
        if (!result.ok) reportError(formatError(result.error));
      } catch (error) {
        reportError(formatError(error instanceof Error ? error.message : String(error)));
      } finally {
        await restoreMute();
      }
      targetRef.current.focus();
    })();
    stopInFlightRef.current = stopping.finally(() => {
      stopInFlightRef.current = null;
    });
    return stopInFlightRef.current;
  }, [formatError, reportError, restoreMute, stopEngine]);

  useEffect(() => () => {
    attemptRef.current += 1;
    const runId = runIdRef.current;
    runIdRef.current = null;
    void stopEngine();
    void restoreMute();
    if (runId) void window.electronAPI?.voiceInput?.cancel?.({ runId });
  }, [restoreMute, stopEngine]);

  return {
    state,
    isBusy: state === 'listening' || state === 'submitting' || state === 'refining',
    liveText,
    lastError,
    start,
    stop,
  };
}
