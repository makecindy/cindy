import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { useTranslation } from 'react-i18next';
import type {
  DictationRefinementContext,
  VoiceInputDraftSource,
  VoiceInputErrorCode,
  VoiceInputRendererEvent,
  VoiceInputState,
} from '@cindy/voice-input-core';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import {
  isCodexSessionExpiredError,
  useCodexSessionExpiredPrompt,
} from '@/hooks/useCodexSessionExpiredPrompt';
import {
  recordVoiceInputHistory,
  updateVoiceInputHistoryEntry,
} from '@/hooks/useVoiceInputHistory';
import {
  adviseAndRecordVoiceInputDictionaryLearning,
  useVoiceInputSettings,
  type VoiceInputDictionaryLearningEvidence,
} from '@/hooks/useVoiceInputSettings';
import {
  recordVoiceInputRefinementUsage,
  recordVoiceInputUsage,
  type VoiceInputUsageOutcome,
} from '@/hooks/useVoiceInputUsageStats';
import {
  VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
  buildReplyToMessageFromChatMessages,
  MAX_REFINEMENT_SIDE_CONTEXT_CHARS,
  takeContextHead,
  takeContextTail,
  truncateContextText,
  type VoiceInputChatMessage,
} from './refinementContext';
import {
  WebMicAudioEngine,
  disposeKeepAliveVoiceInputMicrophone,
  isMicrophoneDeviceUnavailableError,
  isSelectedMicrophoneUnavailableError,
  prewarmVoiceInputBenchmarkFixture,
  prewarmVoiceInputMicrophoneWithAutomaticFallback,
  type PcmChunk,
} from './WebMicAudioEngine';
import { prewarmVoiceInputAudio } from './audioContextPool';
import { createVoiceInputAudioProfile } from './audioProfile';
import { startVoiceInputCaptureSession } from './captureSession';
import {
  buildBaseVoiceInputRefinementContext,
  resolveBrowserVoiceInputLanguage,
} from './refinementContextBuilder';
import { resolveVoiceInputStartGuards } from './startGuards';
import { getVoiceInputWorkletUrl } from './workletUrl';
import { buildRefinementPreviewText } from './refinementPreviewText';
import { isVoiceInputEventScopeActive, shouldHandleVoiceInputEvent } from './eventScope';
import {
  clampEditorTextRangeToDoc,
  mapEditorTextRange,
  resolveInsertedTextRange,
  type EditorTextRange,
} from './editorRangeMapping';
import { isVoiceInputServiceConnectionError, VOICE_INPUT_ERROR_CODE_KEYS } from './overlayErrors';
import {
  VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
} from '../../shared/voiceInputDictionaryLearning';

const log = createLogger('voice-input');
const workletUrl = getVoiceInputWorkletUrl();

type VisibleTextChangePayload = {
  runId: string;
  visibleDraft?: string;
  submittedText?: string;
  refinedText?: string;
  segmentIds: string[];
  reason: string;
  source?: VoiceInputDraftSource;
};

type SubmittedTextRange = {
  segmentId: string;
  start: number;
  end: number;
  submittedText: string;
  historyEntryId: string | null;
};

export type { EditorTextRange } from './editorRangeMapping';

type DictionaryLearningWatch = {
  segmentId: string;
  rawTranscriptText?: string;
  baselineText: string;
  start: number;
  end: number;
  createdAt: number;
  lastActivityAt: number;
  pendingEvidence?: VoiceInputDictionaryLearningEvidence;
  pendingAdviceTimer?: number;
};

const MAX_DICTIONARY_LEARNING_WATCHES = 8;
// Dictionary learning should capture immediate corrections to the text we just
// inserted, not arbitrary rewrites minutes later. Keep the in-app editor watch
// aligned with the external-overlay tracking window.
const DICTIONARY_LEARNING_TRACK_TIMEOUT_MS = VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS;
const DICTIONARY_LEARNING_CONTEXT_CHARS = 600;
// Match Typeless' strategy: after the inserted text is edited, keep resetting a
// single bounded timer while edit activity continues. Only the final editor
// snapshot after the quiet window is sent to the advisor.
const STOP_WAIT_RAW_TIMEOUT_MS = 1_000;
// Renderer-only failsafe. Refinement itself uses main-side stream-idle timeout;
// this large cap only prevents a broken IPC/state transition from hanging Send
// forever, and should not fire during normal long streaming refinement.
const STOP_WAIT_REFINEMENT_FAILSAFE_MS = 90_000;
const START_READY_STOP_TIMEOUT_MS = 10_000;
const INLINE_ERROR_AUTO_DISMISS_MS = 8_000;

export type UseVoiceInputResult = {
  state: VoiceInputState;
  draftText: string;
  draftSource: VoiceInputDraftSource | null;
  draftRange: EditorTextRange | null;
  lastError: string | null;
  isListening: boolean;
  isBusy: boolean;
  start: () => Promise<void>;
  stop: (options?: VoiceInputStopOptions) => Promise<void>;
  cancel: () => Promise<void>;
};

export type VoiceInputStopOptions = {
  onReadyForEndCue?: () => void;
  waitForRefinement?: boolean;
};

type StartVoiceInputResult = { ok: true; runId: string } | { ok: false; error: string; authErrorReason?: string };
type StartReadyState = {
  attemptId: number;
  promise: Promise<StartVoiceInputResult>;
  resolve: (result: StartVoiceInputResult) => void;
};
type StopCompletionWaiter = {
  resolve: () => void;
  waitForRefinement: boolean;
};

export type UseVoiceInputOptions = {
  onMicrophonePermissionRequired?: (error: string) => void | Promise<void>;
};

/**
 * useVoiceInput wires ChatInput to the main-process dictation controller.
 *
 * Partial ASR is displayed as ghost draft text so user typing is not overwritten.
 * On Stop, main submits the best ASR text and this hook inserts it at the
 * current editor caret.
 */
export function useVoiceInput(
  editor: Editor | null,
  disabled?: boolean,
  chatMessages?: VoiceInputChatMessage[],
  options?: UseVoiceInputOptions,
): UseVoiceInputResult {
  const [state, setState] = useState<VoiceInputState>('idle');
  const [draftText, setDraftText] = useState('');
  const [draftSource, setDraftSource] = useState<VoiceInputDraftSource | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const { t } = useTranslation();
  const { settings: voiceInputSettings } = useVoiceInputSettings();
  const promptCodexSessionExpired = useCodexSessionExpiredPrompt();
  const stateRef = useRef<VoiceInputState>('idle');
  const engineRef = useRef<WebMicAudioEngine | null>(null);
  const runIdRef = useRef<string | null>(null);
  const systemAudioMutedRef = useRef(false);
  // The mute IPC takes 50-150ms (osascript on macOS). Recording start fires it
  // and forgets, so a fast stop may race with mute completion. Tracking the
  // in-flight promise lets restoreSystemAudioForRecording await it before
  // checking the muted ref, preventing leaked mute state.
  const pendingSystemAudioMutePromiseRef = useRef<Promise<void> | null>(null);
  const systemAudioMuteGateOpenRef = useRef(true);
  const systemAudioMuteGateDropLoggedRef = useRef(false);
  const stopCompletionWaitersRef = useRef<StopCompletionWaiter[]>([]);
  const sentAudioMsRef = useRef(0);
  const terminalOutcomeRef = useRef<VoiceInputUsageOutcome>('success');
  const startAttemptIdRef = useRef(0);
  const startReadyRef = useRef<StartReadyState | null>(null);
  const ownedRunIdRef = useRef<string | null>(null);
  // Whether this run's transcript actually reached the editor. The main-process
  // onSubmitted bridge is fire-and-forget — it emits the event and synthesizes a
  // range, so the controller's transcriptKept flag only means "the bridge took
  // it", not "the composer has it". If the editor was gone (route/session
  // change), insertSubmittedText() returns null and only this side knows.
  const transcriptLandedRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const stopInFlightPromiseRef = useRef<Promise<void> | null>(null);
  const inlineErrorDismissTimerRef = useRef<number | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const shouldRestoreEditorFocusRef = useRef(false);
  const insertionRangeRef = useRef<EditorTextRange | null>(null);
  const draftDisplayRangeRef = useRef<EditorTextRange | null>(null);
  const submittedRangesRef = useRef(new Map<string, SubmittedTextRange>());
  const dictionaryLearningWatchesRef = useRef(new Map<string, DictionaryLearningWatch>());
  const applyingVoiceTextRef = useRef(false);
  const editorRef = useRef<Editor | null>(editor);
  const disabledRef = useRef(Boolean(disabled));
  editorRef.current = editor;
  disabledRef.current = Boolean(disabled);

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    if (next === 'error') terminalOutcomeRef.current = 'failed';
    setState(next);
  }, []);

  const isActiveStartAttempt = useCallback((attemptId: number) => (
    startAttemptIdRef.current === attemptId
    && (stateRef.current === 'listening' || stateRef.current === 'submitting')
  ), []);

  const invalidateStartAttempt = useCallback(() => {
    startAttemptIdRef.current += 1;
  }, []);

  const createStartReadyState = useCallback((attemptId: number) => {
    let resolveStartReady!: (result: StartVoiceInputResult) => void;
    const promise = new Promise<StartVoiceInputResult>((resolve) => {
      resolveStartReady = resolve;
    });
    const startReady: StartReadyState = {
      attemptId,
      promise,
      resolve: resolveStartReady,
    };
    startReadyRef.current = startReady;
    return startReady;
  }, []);

  const resolveStartReadyState = useCallback((attemptId: number, result: StartVoiceInputResult) => {
    const startReady = startReadyRef.current;
    if (startReady?.attemptId !== attemptId) return;
    startReady.resolve(result);
    startReadyRef.current = null;
  }, []);

  const waitForStartReadyWhileStopping = useCallback((startReady: StartReadyState): Promise<StartVoiceInputResult> => (
    new Promise((resolve) => {
      let settled = false;
      function finish(result: StartVoiceInputResult): void {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      }
      const timer = window.setTimeout(() => {
        const result: StartVoiceInputResult = {
          ok: false,
          error: 'Voice input did not finish starting in time.',
        };
        log.warn('voice input start readiness timed out while stopping', {
          attemptId: startReady.attemptId,
          timeoutMs: START_READY_STOP_TIMEOUT_MS,
        });
        if (startReadyRef.current === startReady) {
          startReadyRef.current = null;
        }
        startReady.resolve(result);
        finish(result);
      }, START_READY_STOP_TIMEOUT_MS);
      void startReady.promise.then(finish);
    })
  ), []);

  const resolveStopCompletion = useCallback((mode: 'raw' | 'all' = 'all') => {
    const waiters = stopCompletionWaitersRef.current;
    if (waiters.length === 0) return;

    const remaining: StopCompletionWaiter[] = [];
    for (const waiter of waiters) {
      if (mode === 'raw' && waiter.waitForRefinement) {
        remaining.push(waiter);
      } else {
        waiter.resolve();
      }
    }
    stopCompletionWaitersRef.current = remaining;
  }, []);

  const stopEngine = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) await engine.stop();
  }, []);

  const drainQueuedAudioToMain = useCallback(async () => {
    const drainAudioQueue = window.electronAPI.voiceInput.drainAudioQueue;
    if (typeof drainAudioQueue !== 'function') {
      log.warn('voice input audio drain queue unavailable');
      return;
    }
    try {
      await drainAudioQueue();
    } catch (error) {
      log.warn('voice input audio drain queue failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const drainAndStopEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    // Normal submission must preserve the last sub-chunk of microphone audio.
    // AudioWorklet and keep-alive sessions buffer samples internally; draining
    // before provider finalization keeps the user's final words from being
    // dropped when the shortcut/button is released.
    try {
      await engine.drainBufferedAudio();
      await engine.stop();
    } finally {
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    }
    // appendAudio is fire-and-forget IPC for hot-path latency. This no-op invoke
    // is the stop-time barrier: when it returns, main has processed the audio
    // sends emitted by drainBufferedAudio(), regardless of the selected ASR.
    // The barrier itself must be best-effort: dev HMR can temporarily leave
    // renderer/main out of sync, but stop must still reach the provider.
    await drainQueuedAudioToMain();
  }, [drainQueuedAudioToMain]);

  const restoreEditorFocusAfterVoiceInput = useCallback(() => {
    if (!shouldRestoreEditorFocusRef.current) return;
    shouldRestoreEditorFocusRef.current = false;

    // ChatInput restores editor.editable from voiceInput.isBusy in a React
    // effect. Focus one tick later so we do not focus a temporarily read-only
    // editor and leave keyboard input feeling stuck after dictation ends.
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        const current = editorRef.current;
        if (!current || current.isDestroyed || disabledRef.current) return;
        if (!current.isEditable) {
          current.setEditable(true, false);
        }
        current.commands.focus();
      }, 0);
    });
  }, []);

  const clearInlineErrorDismissTimer = useCallback(() => {
    if (inlineErrorDismissTimerRef.current === null) return;
    window.clearTimeout(inlineErrorDismissTimerRef.current);
    inlineErrorDismissTimerRef.current = null;
  }, []);

  const dismissInlineError = useCallback(() => {
    clearInlineErrorDismissTimer();
    lastErrorRef.current = null;
    setLastError(null);
  }, [clearInlineErrorDismissTimer]);

  const reportVoiceInputError = useCallback((message: string) => {
    clearInlineErrorDismissTimer();
    lastErrorRef.current = message;
    setLastError(message);
    inlineErrorDismissTimerRef.current = window.setTimeout(() => {
      inlineErrorDismissTimerRef.current = null;
      setLastError(null);
    }, INLINE_ERROR_AUTO_DISMISS_MS);
  }, [clearInlineErrorDismissTimer]);

  const formatVoiceInputStartError = useCallback((message: string): string => {
    return isVoiceInputServiceConnectionError(message)
      ? t('voiceInputOverlay.asrServiceUnavailable')
      : message;
  }, [t]);

  const formatVoiceInputError = useCallback((
    message: string,
    code?: VoiceInputErrorCode,
    transcriptKept?: boolean,
  ): string => {
    // Coded failures are the controller's own; their `message` is an English
    // debug string, so the localized sentence has to come from the code.
    // Uncoded ones come from a provider — run them through the same connection
    // mapping the start path uses, so one transport failure reads the same on
    // both paths and raw ECONNRESET/"fetch failed" strings stay out of the UI.
    // Anything that is not a transport string (auth, quota, protocol) survives
    // verbatim, since that message is its only description.
    const cause = code ? t(VOICE_INPUT_ERROR_CODE_KEYS[code]) : formatVoiceInputStartError(message);
    // Retention is appended to the cause, never substituted for it: the user
    // still needs to know whether this was a dropped socket or an expired
    // credential, and they also need to know their words are in the composer.
    return transcriptKept ? t('voiceInputOverlay.transcriptKept', { message: cause }) : cause;
  }, [formatVoiceInputStartError, t]);

  const appendAudioChunk = useCallback((chunk: PcmChunk) => {
    sentAudioMsRef.current += chunk.trace.durationMs;
    window.electronAPI.voiceInput.appendAudio(chunk);
  }, []);

  const canAcceptAudioChunk = useCallback(() => {
    if (systemAudioMuteGateOpenRef.current) return true;
    if (!systemAudioMuteGateDropLoggedRef.current) {
      systemAudioMuteGateDropLoggedRef.current = true;
      log.debug('dropping voice input pcm until system audio mute completes');
    }
    return false;
  }, []);

  const commitUsageStats = useCallback(() => {
    const audioMs = sentAudioMsRef.current;
    sentAudioMsRef.current = 0;
    recordVoiceInputUsage(audioMs, terminalOutcomeRef.current);
  }, []);

  const muteSystemAudioForRecording = useCallback((): Promise<void> => {
    if (!supportsSystemAudioMute()) {
      systemAudioMuteGateOpenRef.current = true;
      return Promise.resolve();
    }
    if (systemAudioMutedRef.current) {
      systemAudioMuteGateOpenRef.current = true;
      return pendingSystemAudioMutePromiseRef.current ?? Promise.resolve();
    }
    if (pendingSystemAudioMutePromiseRef.current) {
      return pendingSystemAudioMutePromiseRef.current;
    }
    const mutePromise = window.electronAPI.voiceInput
      .muteSystemAudio()
      .then((result) => {
        if (result.ok) {
          systemAudioMutedRef.current = true;
        } else {
          log.warn('system audio mute failed:', result.error);
        }
      })
      .catch((error) => {
        log.warn('system audio mute failed:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        systemAudioMuteGateOpenRef.current = true;
        if (pendingSystemAudioMutePromiseRef.current === mutePromise) {
          pendingSystemAudioMutePromiseRef.current = null;
        }
      });
    pendingSystemAudioMutePromiseRef.current = mutePromise;
    return mutePromise;
  }, []);

  const restoreSystemAudioForRecording = useCallback(async () => {
    systemAudioMuteGateOpenRef.current = true;
    if (!supportsSystemAudioMute()) return;
    // Await any in-flight mute so we never skip a restore for a mute that
    // hadn't yet flipped systemAudioMutedRef when restore began.
    const pendingMute = pendingSystemAudioMutePromiseRef.current;
    if (pendingMute) await pendingMute;
    if (!systemAudioMutedRef.current) return;
    systemAudioMutedRef.current = false;
    try {
      const result = await window.electronAPI.voiceInput.restoreSystemAudio();
      if (!result.ok) {
        log.warn('system audio restore failed:', result.error);
      }
    } catch (error) {
      log.warn('system audio restore failed:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const failActiveRecording = useCallback(async (message: string) => {
    if (stateRef.current !== 'listening') return;
    log.warn('microphone capture interrupted:', message);
    invalidateStartAttempt();
    const runId = runIdRef.current;
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    resolveStopCompletion();
    setDraftText('');
    setDraftSource(null);
    draftDisplayRangeRef.current = null;
    insertionRangeRef.current = null;
    submittedRangesRef.current.clear();
    setVoiceState('error');
    reportVoiceInputError(message);
    restoreEditorFocusAfterVoiceInput();

    await stopEngine();
    try {
      await window.electronAPI.voiceInput.cancel(runId ? { runId } : undefined);
    } finally {
      await restoreSystemAudioForRecording();
      commitUsageStats();
    }
  }, [
    commitUsageStats,
    invalidateStartAttempt,
    reportVoiceInputError,
    resolveStopCompletion,
    restoreSystemAudioForRecording,
    restoreEditorFocusAfterVoiceInput,
    setVoiceState,
    stopEngine,
  ]);

  const readEditorSnapshot = useCallback(() => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) {
      return {
        inputValue: '',
        selectionStart: 0,
        selectionEnd: 0,
      };
    }
    return {
      inputValue: current.state.doc.textContent,
      selectionStart: current.state.selection.from,
      selectionEnd: current.state.selection.to,
    };
  }, []);

  const readEditorSelectionRange = useCallback((): EditorTextRange | null => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return null;
    return {
      from: current.state.selection.from,
      to: current.state.selection.to,
    };
  }, []);

  // 钳制到「能承载 inline 内容」的位置,而不是只钳到 doc.content.size:后者本身就是
  // 一个 block 边界,在那里 insertText 会另起一个段落,上屏文字前凭空多一个空行。
  const clampEditorTextRange = useCallback(
    (range: EditorTextRange, doc: PMNode): EditorTextRange => clampEditorTextRangeToDoc(range, doc),
    [],
  );

  const clearDictionaryLearningWatchTimer = useCallback((watch: DictionaryLearningWatch | undefined) => {
    if (watch?.pendingAdviceTimer !== undefined) {
      window.clearTimeout(watch.pendingAdviceTimer);
    }
  }, []);

  const publishDictionaryLearningEvidence = useCallback((
    evidence: VoiceInputDictionaryLearningEvidence,
    triggerReason: string,
  ) => {
    void adviseAndRecordVoiceInputDictionaryLearning(evidence);
    log.debug('voice input dictionary learning evidence finalized', {
      triggerReason,
      rawTranscriptChars: evidence.rawTranscriptText?.length ?? 0,
      beforeChars: evidence.beforeText.length,
      afterChars: evidence.afterText.length,
      trackTimeoutMs: DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
    });
  }, []);

  const finalizeDictionaryLearningWatch = useCallback((
    segmentId: string,
    triggerReason: string,
  ): boolean => {
    const watch = dictionaryLearningWatchesRef.current.get(segmentId);
    if (!watch?.pendingEvidence) return false;
    clearDictionaryLearningWatchTimer(watch);
    dictionaryLearningWatchesRef.current.delete(segmentId);
    publishDictionaryLearningEvidence(watch.pendingEvidence, triggerReason);
    return true;
  }, [clearDictionaryLearningWatchTimer, publishDictionaryLearningEvidence]);

  const clearDictionaryLearningWatches = useCallback(() => {
    dictionaryLearningWatchesRef.current.forEach((watch) => {
      if (watch.pendingEvidence) {
        publishDictionaryLearningEvidence(watch.pendingEvidence, 'watch_disposed');
      }
      clearDictionaryLearningWatchTimer(watch);
    });
    dictionaryLearningWatchesRef.current.clear();
  }, [clearDictionaryLearningWatchTimer, publishDictionaryLearningEvidence]);

  const upsertDictionaryLearningWatch = useCallback((watch: DictionaryLearningWatch) => {
    const watches = dictionaryLearningWatchesRef.current;
    clearDictionaryLearningWatchTimer(watches.get(watch.segmentId));
    watches.set(watch.segmentId, watch);
    if (watches.size <= MAX_DICTIONARY_LEARNING_WATCHES) return;
    const oldest = Array.from(watches.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) {
      clearDictionaryLearningWatchTimer(oldest);
      watches.delete(oldest.segmentId);
    }
  }, [clearDictionaryLearningWatchTimer]);

  const scheduleDictionaryLearningAdvice = useCallback((
    segmentId: string,
    evidence: VoiceInputDictionaryLearningEvidence,
  ) => {
    const watch = dictionaryLearningWatchesRef.current.get(segmentId);
    if (!watch) return;
    clearDictionaryLearningWatchTimer(watch);
    const timer = window.setTimeout(() => {
      const currentWatch = dictionaryLearningWatchesRef.current.get(segmentId);
      if (!currentWatch || currentWatch.pendingAdviceTimer !== timer) return;
      const current = editorRef.current;
      if (!current || current.isDestroyed) {
        dictionaryLearningWatchesRef.current.set(segmentId, {
          ...currentWatch,
          pendingAdviceTimer: undefined,
        });
        return;
      }
      const { doc } = current.state;
      const range = clampEditorTextRange(
        { from: currentWatch.start, to: currentWatch.end },
        doc,
      );
      const afterText = doc.textBetween(range.from, range.to, '\n', '\n');
      if (!afterText || afterText === currentWatch.baselineText) {
        dictionaryLearningWatchesRef.current.delete(segmentId);
        return;
      }
      const latestEvidence: VoiceInputDictionaryLearningEvidence = {
        source: evidence.source,
        rawTranscriptText: currentWatch.rawTranscriptText,
        beforeText: currentWatch.baselineText,
        afterText,
        context: {
          uiLanguage: navigator.language,
          sourceLanguage: resolveBrowserVoiceInputLanguage(voiceInputSettings.language),
          selectionBefore: doc.textBetween(
            Math.max(0, range.from - DICTIONARY_LEARNING_CONTEXT_CHARS),
            range.from,
            '\n',
            '\n',
          ),
          selectionAfter: doc.textBetween(
            range.to,
            Math.min(doc.content.size, range.to + DICTIONARY_LEARNING_CONTEXT_CHARS),
            '\n',
            '\n',
          ),
        },
      };
      dictionaryLearningWatchesRef.current.delete(segmentId);
      publishDictionaryLearningEvidence(latestEvidence, 'track_timeout');
    }, DICTIONARY_LEARNING_TRACK_TIMEOUT_MS);
    dictionaryLearningWatchesRef.current.set(segmentId, {
      ...watch,
      pendingEvidence: evidence,
      pendingAdviceTimer: timer,
    });
  }, [
    clampEditorTextRange,
    clearDictionaryLearningWatchTimer,
    publishDictionaryLearningEvidence,
    voiceInputSettings.language,
  ]);

  const pruneDictionaryLearningWatches = useCallback((now: number) => {
    dictionaryLearningWatchesRef.current.forEach((watch, segmentId) => {
      if (
        watch.pendingAdviceTimer === undefined &&
        now - watch.lastActivityAt > DICTIONARY_LEARNING_TRACK_TIMEOUT_MS
      ) {
        clearDictionaryLearningWatchTimer(watch);
        dictionaryLearningWatchesRef.current.delete(segmentId);
      }
    });
  }, [clearDictionaryLearningWatchTimer]);

  const inspectDictionaryLearningTransaction = useCallback((transaction: Transaction) => {
    if (applyingVoiceTextRef.current || !transaction.docChanged) return;
    const current = editorRef.current;
    if (!current || current.isDestroyed) return;
    const now = Date.now();
    pruneDictionaryLearningWatches(now);
    const evidences = Array.from(dictionaryLearningWatchesRef.current.values())
      .flatMap((watch) => {
        const start = transaction.mapping.map(watch.start, -1);
        const end = transaction.mapping.map(watch.end, -1);
        const range = clampEditorTextRange({ from: start, to: end }, transaction.doc);
        const currentText = transaction.doc.textBetween(range.from, range.to, '\n', '\n');
        if (!currentText) {
          finalizeDictionaryLearningWatch(watch.segmentId, 'clear_input_box');
          return [];
        }
        if (currentText === watch.baselineText) {
          clearDictionaryLearningWatchTimer(watch);
          dictionaryLearningWatchesRef.current.set(watch.segmentId, {
            ...watch,
            start: range.from,
            end: range.to,
            pendingAdviceTimer: undefined,
          });
          return [];
        }

        const evidence = {
          source: 'in_app' as const,
          rawTranscriptText: watch.rawTranscriptText,
          beforeText: watch.baselineText,
          afterText: currentText,
          context: {
            uiLanguage: navigator.language,
            sourceLanguage: resolveBrowserVoiceInputLanguage(voiceInputSettings.language),
            selectionBefore: transaction.doc.textBetween(
              Math.max(0, range.from - DICTIONARY_LEARNING_CONTEXT_CHARS),
              range.from,
              '\n',
              '\n',
            ),
            selectionAfter: transaction.doc.textBetween(
              range.to,
              Math.min(transaction.doc.content.size, range.to + DICTIONARY_LEARNING_CONTEXT_CHARS),
              '\n',
              '\n',
            ),
          },
        };
        dictionaryLearningWatchesRef.current.set(watch.segmentId, {
          ...watch,
          // rawTranscriptText 保持初始 ASR 文本不动: advisor 系统 prompt 允许它作为
          // alias 证据补充, 这是个只读历史事实, 不应该被用户的后续编辑覆盖。
          start: range.from,
          end: range.to,
          lastActivityAt: now,
        });
        return [{ segmentId: watch.segmentId, evidence }];
      });
    if (evidences.length > 0) {
      evidences.forEach(({ segmentId, evidence }) => {
        scheduleDictionaryLearningAdvice(segmentId, evidence);
      });
      log.debug('voice input dictionary learning evidence detected', {
        count: evidences.length,
        rawTranscriptChars: evidences.map(({ evidence }) => evidence.rawTranscriptText?.length ?? 0),
        beforeChars: evidences.map(({ evidence }) => evidence.beforeText.length),
        afterChars: evidences.map(({ evidence }) => evidence.afterText.length),
      });
    }
  }, [
    clampEditorTextRange,
    clearDictionaryLearningWatchTimer,
    finalizeDictionaryLearningWatch,
    pruneDictionaryLearningWatches,
    scheduleDictionaryLearningAdvice,
    voiceInputSettings.language,
  ]);

  const buildRefinementContext = useCallback((): DictationRefinementContext => {
    const current = editorRef.current;
    const baseContext = buildBaseVoiceInputRefinementContext({
      settings: voiceInputSettings,
    });
    const replyToMessage = buildReplyToMessageFromChatMessages(chatMessages);
    if (!current || current.isDestroyed) {
      return {
        ...baseContext,
        replyToMessage,
      };
    }

    const { doc, selection } = current.state;
    const range = clampEditorTextRange(
      insertionRangeRef.current ?? { from: selection.from, to: selection.to },
      doc,
    );
    return {
      ...baseContext,
      // DictationRefiner.getContext re-imposes cache-friendly ordering when
      // serializing the request body.
      selectionBefore: takeContextTail(doc.textBetween(0, range.from, '\n', '\n'), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
      selectedText: truncateContextText(doc.textBetween(range.from, range.to, '\n', '\n'), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
      selectionAfter: takeContextHead(doc.textBetween(range.to, doc.content.size, '\n', '\n'), MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
      replyToMessage,
    };
  }, [
    chatMessages,
    clampEditorTextRange,
    voiceInputSettings,
  ]);

  const formatMicrophoneStartError = useCallback((error: unknown): string => {
    if (isMicrophoneDeviceUnavailableError(error)) {
      return t(
        isSelectedMicrophoneUnavailableError(error)
          ? 'settings.voiceInput.microphone.errors.selectedUnavailable'
          : 'settings.voiceInput.microphone.errors.deviceUnavailable',
      );
    }
    return error instanceof Error ? error.message : String(error);
  }, [t, voiceInputSettings.microphoneDeviceId]);

  const formatMicrophoneFallbackMessage = useCallback((): string => (
    t('settings.voiceInput.microphone.errors.fallbackToAuto')
  ), [t]);

  const recordVisibleTextChanged = useCallback((payload: VisibleTextChangePayload) => {
    log.debug('visible_text_changed', {
      at: Date.now(),
      ...payload,
      ...readEditorSnapshot(),
    });
  }, [readEditorSnapshot]);

  const insertSubmittedText = useCallback((text: string): { start: number; end: number } | null => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return null;
    current.commands.focus();
    const { state, dispatch } = current.view;
    const range = insertionRangeRef.current
      ? clampEditorTextRange(insertionRangeRef.current, state.doc)
      : { from: state.selection.from, to: state.selection.to };
    insertionRangeRef.current = null;
    applyingVoiceTextRef.current = true;
    try {
      const transaction = state.tr.insertText(text, range.from, range.to);
      // 上屏范围必须从事务推导,不能用插入前的 from:替换区间可以合法地从 block
      // 边界开始(全选后听写就是 0..content.size),ProseMirror 会把 inline 文本
      // fit 进段落,字形实际落在边界之后。用旧 from 记录会让润色回填、润色预览与
      // 词典学习 watch 整体错位(润色会因读到截断文本而被丢弃)。
      const inserted = resolveInsertedTextRange(transaction, range.from, text.length);
      dispatch(transaction);
      return inserted;
    } finally {
      applyingVoiceTextRef.current = false;
    }
  }, [clampEditorTextRange]);

  const applyRefinedText = useCallback((event: Extract<VoiceInputRendererEvent, { type: 'refined' }>): boolean => {
    const segmentId = event.range.segmentIds[0];
    const range = segmentId ? submittedRangesRef.current.get(segmentId) : undefined;
    const current = editorRef.current;
    if (!segmentId) {
      log.debug('refinement skipped: missing segment id', {
        runId: event.runId,
        refinedText: event.text,
      });
      return false;
    }
    if (!range) {
      log.debug('refinement skipped: submitted range missing', {
        runId: event.runId,
        segmentId,
        refinedText: event.text,
      });
      return false;
    }
    if (!current || current.isDestroyed) {
      log.debug('refinement skipped: editor unavailable', {
        runId: event.runId,
        segmentId,
        refinedText: event.text,
      });
      return false;
    }

    const { state, dispatch } = current.view;
    if (range.end > state.doc.content.size) {
      log.debug('refinement skipped: submitted range out of bounds', {
        runId: event.runId,
        segmentId,
        range,
        docSize: state.doc.content.size,
        refinedText: event.text,
      });
      return false;
    }

    // The composer is intentionally non-editable while voice input is busy.
    // This guard is for stale async refinement results after cancellation,
    // route/session changes, draft restore, or other programmatic editor updates.
    const currentText = state.doc.textBetween(range.start, range.end, '');
    const basedOnText = event.segment.basedOnText ?? range.submittedText;
    if (currentText !== range.submittedText && currentText !== basedOnText) {
      log.debug('refinement skipped: submitted range changed', {
        segmentId,
        currentText,
        expectedText: range.submittedText,
        refinedText: event.text,
      });
      return false;
    }

    applyingVoiceTextRef.current = true;
    try {
      dispatch(state.tr.insertText(event.text, range.start, range.end));
    } finally {
      applyingVoiceTextRef.current = false;
    }
    submittedRangesRef.current.set(segmentId, {
      ...range,
      end: range.start + event.text.length,
      submittedText: event.text,
    });
    upsertDictionaryLearningWatch({
      segmentId,
      rawTranscriptText: basedOnText,
      baselineText: event.text,
      start: range.start,
      end: range.start + event.text.length,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    if (range.historyEntryId) {
      updateVoiceInputHistoryEntry(range.historyEntryId, event.text);
    }
    return true;
  }, [upsertDictionaryLearningWatch]);

  useEffect(() => {
    return window.electronAPI.voiceInput.onEvent((event) => {
      if (!shouldHandleVoiceInputEvent(
        ownedRunIdRef.current,
        event.runId,
        isVoiceInputEventScopeActive(stateRef.current),
      )) return;
      switch (event.type) {
        case 'auth-required':
          promptCodexSessionExpired(event.reason);
          break;
        case 'state':
          if (event.outcome) terminalOutcomeRef.current = event.outcome;
          setVoiceState(event.state);
          if (event.state === 'refining') {
            resolveStopCompletion('raw');
          }
          if (event.state === 'done' || event.state === 'error') {
            commitUsageStats();
            setDraftText('');
            setDraftSource(null);
            draftDisplayRangeRef.current = null;
            insertionRangeRef.current = null;
            if (event.state === 'done') {
              runIdRef.current = null;
              ownedRunIdRef.current = null;
            }
            resolveStopCompletion();
            restoreEditorFocusAfterVoiceInput();
          }
          break;
        case 'draft':
          draftDisplayRangeRef.current = insertionRangeRef.current;
          setDraftText(event.text);
          setDraftSource(event.source);
          recordVisibleTextChanged({
            runId: event.runId,
            visibleDraft: event.text,
            segmentIds: [event.segment.id],
            reason: event.source === 'stable' ? 'asr_stable' : 'asr_partial',
            source: event.source,
          });
          break;
        case 'submitted':
          {
            const range = insertSubmittedText(event.text);
            transcriptLandedRef.current = Boolean(range);
            if (range) {
              const historyEntryId = recordVoiceInputHistory(event.text);
              submittedRangesRef.current.set(event.segment.id, {
                segmentId: event.segment.id,
                start: range.start,
                end: range.end,
                submittedText: event.text,
                historyEntryId,
              });
              upsertDictionaryLearningWatch({
                segmentId: event.segment.id,
                rawTranscriptText: event.text,
                baselineText: event.text,
                start: range.start,
                end: range.end,
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
              });
              recordVisibleTextChanged({
                runId: event.runId,
                submittedText: event.text,
                segmentIds: [event.segment.id],
                reason: 'submitted',
              });
            }
          }
          setDraftText('');
          draftDisplayRangeRef.current = null;
          setDraftSource(null);
          break;
        case 'refinement-preview':
          // Refinement streams AFTER stop(), which nulls runIdRef. So unlike
          // listening-phase events, the preview must NOT require a live
          // runIdRef — that strict guard silently dropped every preview frame
          // (refine streaming was invisible in-app). Stale runs are already
          // filtered by the top-level guard above, and the submitted-range
          // lookup keyed by segmentId binds the preview to its target text,
          // exactly like the 'refined' / 'submitted' paths.
          {
            const segmentId = event.range.segmentIds[0];
            const range = segmentId ? submittedRangesRef.current.get(segmentId) : undefined;
            const current = editorRef.current;
            if (range && current && !current.isDestroyed) {
              const currentDoc = current.state.doc;
              if (range.start <= currentDoc.content.size) {
                const baseText = event.segment.basedOnText ?? range.submittedText;
                draftDisplayRangeRef.current = clampEditorTextRange(
                  { from: range.start, to: range.end },
                  currentDoc,
                );
                setDraftText(buildRefinementPreviewText(baseText, event.text));
                setDraftSource('refinement');
              }
            }
          }
          break;
        case 'refined':
          if (applyRefinedText(event)) {
            recordVisibleTextChanged({
              runId: event.runId,
              refinedText: event.text,
              segmentIds: event.range.segmentIds,
              reason: 'refined',
            });
          }
          setDraftText('');
          draftDisplayRangeRef.current = null;
          setDraftSource(null);
          break;
        case 'error': {
          log.warn('voice input error:', event.message);
          terminalOutcomeRef.current = 'failed';
          // Only this side knows whether the text really made it into the
          // editor: the main-process bridge answers onSubmitted synchronously
          // with a synthesized range, so transcriptKept alone would promise
          // retention even when insertSubmittedText() found no live editor.
          const transcriptKept = event.transcriptKept === true && transcriptLandedRef.current;
          const formattedMessage = formatVoiceInputError(event.message, event.code, transcriptKept);
          promptCodexSessionExpired(formattedMessage);
          commitUsageStats();
          void (async () => {
            await stopEngine();
            await restoreSystemAudioForRecording();
          })();
          setDraftText('');
          setDraftSource(null);
          draftDisplayRangeRef.current = null;
          insertionRangeRef.current = null;
          setVoiceState('error');
          runIdRef.current = null;
          ownedRunIdRef.current = null;
          resolveStopCompletion();
          reportVoiceInputError(formattedMessage);
          restoreEditorFocusAfterVoiceInput();
          break;
        }
        case 'usage':
          recordVoiceInputRefinementUsage(event.refinement);
          break;
        case 'timeline':
          if (
            event.event.type === 'refine_rejected' &&
            isCodexSessionExpiredError(event.event.reason)
          ) {
            promptCodexSessionExpired(event.event.reason);
          }
          break;
      }
    });
  }, [applyRefinedText, clampEditorTextRange, commitUsageStats, formatVoiceInputError, insertSubmittedText, promptCodexSessionExpired, recordVisibleTextChanged, reportVoiceInputError, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioForRecording, setVoiceState, stopEngine, upsertDictionaryLearningWatch]);

  useEffect(() => {
    return () => {
      resolveStopCompletion();
      commitUsageStats();
      clearDictionaryLearningWatches();
      void stopEngine();
      void restoreSystemAudioForRecording();
      void window.electronAPI.voiceInput.cancel();
      clearInlineErrorDismissTimer();
    };
  }, [
    clearDictionaryLearningWatches,
    clearInlineErrorDismissTimer,
    commitUsageStats,
    resolveStopCompletion,
    restoreSystemAudioForRecording,
    stopEngine,
  ]);

  useEffect(() => {
    if (!editor) return;
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      inspectDictionaryLearningTransaction(transaction);
      // The insertion point is captured from the selection when dictation
      // starts, and the composer is read-only while it runs — but programmatic
      // writes (draft restore, quote insertion, …) bypass that and shift every
      // offset after them. A stale offset is worst exactly where it is used
      // last: the salvage path replaces that range after a failure, which would
      // eat whatever text now occupies it. Ride along on ProseMirror's mapping.
      if (!transaction.docChanged || applyingVoiceTextRef.current) return;
      insertionRangeRef.current = mapEditorTextRange(insertionRangeRef.current, transaction);
      draftDisplayRangeRef.current = mapEditorTextRange(draftDisplayRangeRef.current, transaction);
    };
    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
    };
  }, [editor, inspectDictionaryLearningTransaction]);

  // Mount-time prewarm: pull provider auth into main's hot cache, and create
  // the shared AudioContext + load the PCM worklet module. Both calls are
  // idempotent and throttled internally — running on every ChatInput mount
  // is cheap. Errors are swallowed; prewarm must never disrupt the UI.
  useEffect(() => {
    if (disabledRef.current) return;
    void window.electronAPI.voiceInput.prewarm({
      sourceLanguage: voiceInputSettings.language,
      refinementEnabled: voiceInputSettings.refinementEnabled,
    }).catch(() => undefined);
    void prewarmVoiceInputAudio(workletUrl).catch(() => undefined);
    if (import.meta.env.DEV) void prewarmVoiceInputBenchmarkFixture().catch(() => undefined);
  }, [voiceInputSettings.language, voiceInputSettings.refinementEnabled]);

  // Microphone keep-alive is deliberately a separate effect: unlike the prewarm
  // above it opens a real capture device and turns on the OS privacy indicator,
  // so it must not re-run for settings unrelated to the microphone. Language and
  // refinement changes used to re-assert keep-alive intent here, which kept the
  // device warm for reasons the user never asked for.
  useEffect(() => {
    if (disabledRef.current) return;
    if (!voiceInputSettings.fastActivationEnabled) {
      void disposeKeepAliveVoiceInputMicrophone('setting_disabled').catch(() => undefined);
      return;
    }
    const permission = window.electronAPI.voiceInput.getMicrophonePermissionCached();
    if (!permission.ok) return;
    void prewarmVoiceInputMicrophoneWithAutomaticFallback(
      {
        workletUrl,
        deviceId: voiceInputSettings.microphoneDeviceId ?? undefined,
        ...createVoiceInputAudioProfile(true),
      },
      () => {
        log.warn('fast activation selected microphone unavailable, prewarming automatic microphone');
      },
    ).catch((error) => {
      log.warn('fast activation microphone prewarm failed', {
        error: error instanceof Error ? error.message : String(error),
        workletUrl,
        hasDeviceId: Boolean(voiceInputSettings.microphoneDeviceId),
      });
    });
  }, [
    voiceInputSettings.fastActivationEnabled,
    voiceInputSettings.microphoneDeviceId,
  ]);

  const start = useCallback(async () => {
    const currentState = stateRef.current;
    if (
      disabled ||
      !editorRef.current ||
      stopInFlightRef.current ||
      currentState === 'listening' ||
      currentState === 'submitting' ||
      currentState === 'refining'
    ) {
      return;
    }
    dismissInlineError();
    shouldRestoreEditorFocusRef.current = true;
    insertionRangeRef.current = readEditorSelectionRange();
    draftDisplayRangeRef.current = insertionRangeRef.current;
    setDraftText('');
    setDraftSource(null);
    setVoiceState('listening');
    const attemptId = startAttemptIdRef.current + 1;
    startAttemptIdRef.current = attemptId;
    createStartReadyState(attemptId);
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    submittedRangesRef.current.clear();
    sentAudioMsRef.current = 0;
    terminalOutcomeRef.current = 'success';
    systemAudioMuteGateOpenRef.current = true;
    systemAudioMuteGateDropLoggedRef.current = false;
    if (voiceInputSettings.muteSystemAudio && supportsSystemAudioMute()) {
      systemAudioMuteGateOpenRef.current = false;
      void muteSystemAudioForRecording();
    }
    const bootstrapStartedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - bootstrapStartedAt);

    // Critical-path parallelization (mirrors VoiceInputOverlay.startRecording):
    //
    // 1. Permission + provider-readiness use main's positive cache when
    //    available. Missing/negative cache falls back to the existing async
    //    checks. Main still verifies readiness inside voice-input:start, so a
    //    stale positive cache cannot bypass auth; it only avoids blocking
    //    getUserMedia on two IPC round trips.
    // 2. After both gates, getUserMedia/worklet setup and the main-side
    //    WebSocket dial run concurrently — the network round-trip overlaps
    //    the OS microphone handshake instead of waiting for it.
    // 3. PCM chunks emitted before `runId` is known are buffered and drained
    //    the moment the start IPC resolves.
    // 4. System-audio mute starts before the gates. While it is pending,
    //    microphone PCM is gated so system audio playing during the mute delay
    //    cannot enter ASR.
    const guards = await resolveVoiceInputStartGuards();
    log.debug('voice input start guards checked', {
      ok: guards.ok,
      failed: guards.ok ? undefined : guards.failed,
      permissionSource: guards.permissionSource,
      readinessSource: guards.readinessSource,
      elapsedMs: elapsedMs(),
    });
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      await restoreSystemAudioForRecording();
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    if (!guards.permission.ok) {
      resolveStartReadyState(attemptId, { ok: false, error: guards.permission.error });
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      setVoiceState('error');
      if (options?.onMicrophonePermissionRequired) {
        void options.onMicrophonePermissionRequired(guards.permission.error);
      } else {
        reportVoiceInputError(guards.permission.error);
      }
      await restoreSystemAudioForRecording();
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    if (!guards.readiness.ok) {
      let readinessError = guards.readiness.error ?? 'Voice input is not configured.';
      switch (guards.readiness.failureReason) {
        case 'custom-asr-config-missing':
          readinessError = t('settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing');
          break;
        case 'custom-asr-key-missing':
          readinessError = t('settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing');
          break;
        case 'codex-realtime-unsupported':
          readinessError = t('settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported');
          break;
      }
      const authErrorReason = guards.readiness.authErrorReason;
      if (guards.readiness.auth === 'codex' && authErrorReason && isCodexSessionExpiredError(authErrorReason)) {
        promptCodexSessionExpired(authErrorReason);
      }
      resolveStartReadyState(attemptId, { ok: false, error: readinessError });
      insertionRangeRef.current = null;
      setVoiceState('error');
      reportVoiceInputError(readinessError);
      await restoreSystemAudioForRecording();
      restoreEditorFocusAfterVoiceInput();
      return;
    }

    const startPayload = {
      sourceLanguage: voiceInputSettings.language,
      refinementEnabled: voiceInputSettings.refinementEnabled,
      refinementContext: voiceInputSettings.refinementEnabled ? buildRefinementContext() : undefined,
      refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
    };
    const startResultPromise: Promise<StartVoiceInputResult> = window.electronAPI.voiceInput
      .start(startPayload)
      .catch((startError) => ({
        ok: false as const,
        error: startError instanceof Error ? startError.message : String(startError),
      }));

    const captureStart = await startVoiceInputCaptureSession({
      label: '',
      workletUrl,
      deviceId: voiceInputSettings.microphoneDeviceId ?? undefined,
      fastActivationEnabled: voiceInputSettings.fastActivationEnabled,
      getRunId: () => runIdRef.current,
      setEngine: (engine) => {
        engineRef.current = engine;
      },
      isCurrentEngine: (engine) => startAttemptIdRef.current === attemptId && engineRef.current === engine,
      canAcceptAudioChunk,
      appendAudioChunk,
      onInterrupted: (message) => {
        void failActiveRecording(message);
      },
      onStateChange: (event, details) => {
        log.debug('microphone engine', event, details);
      },
      getFallbackMessage: formatMicrophoneFallbackMessage,
      onFallback: (message) => {
        toast.warning(message);
      },
      formatStartError: formatMicrophoneStartError,
      elapsedMs,
    });
    if (!captureStart.ok) {
      // 电源释放(锁屏/挂起)取消了启动:静默回收,不显示错误态 —— 用户是主动
      // 离开,内部的 disposed 消息不该出现在界面上。
      if (captureStart.cancelled) {
        log.debug('microphone start cancelled by power release');
        resolveStartReadyState(attemptId, { ok: false, error: captureStart.error });
        invalidateStartAttempt();
        void startResultPromise.then((result) => {
          if (result.ok) {
            void window.electronAPI.voiceInput.cancel({ runId: result.runId });
          }
        });
        await restoreSystemAudioForRecording();
        setVoiceState('idle');
        restoreEditorFocusAfterVoiceInput();
        return;
      }
      log.warn('microphone start failed:', captureStart.error);
      resolveStartReadyState(attemptId, { ok: false, error: captureStart.error });
      invalidateStartAttempt();
      // The start IPC may still resolve successfully — cancel that run so we
      // do not leave a controller dangling in main.
      void startResultPromise.then((result) => {
        if (result.ok) {
          void window.electronAPI.voiceInput.cancel({ runId: result.runId });
        }
      });
      await restoreSystemAudioForRecording();
      setDraftText('');
      setDraftSource(null);
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      setVoiceState('error');
      reportVoiceInputError(captureStart.error);
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      void startResultPromise.then((result) => {
        if (result.ok) {
          void window.electronAPI.voiceInput.cancel({ runId: result.runId });
        }
      });
      await stopEngine();
      await restoreSystemAudioForRecording();
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      restoreEditorFocusAfterVoiceInput();
      return;
    }

    const result = await startResultPromise;
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: result.ok ? 'Voice input start was cancelled.' : result.error });
      await stopEngine();
      await restoreSystemAudioForRecording();
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      if (result.ok) {
        await window.electronAPI.voiceInput.cancel({ runId: result.runId });
      }
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    if (!result.ok) {
      resolveStartReadyState(attemptId, result);
      await stopEngine();
      await restoreSystemAudioForRecording();
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      setVoiceState('error');
      promptCodexSessionExpired(result.authErrorReason ?? result.error);
      reportVoiceInputError(formatVoiceInputStartError(result.error));
      restoreEditorFocusAfterVoiceInput();
      return;
    }

    runIdRef.current = result.runId;
    ownedRunIdRef.current = result.runId;
    transcriptLandedRef.current = false;
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      await stopEngine();
      await window.electronAPI.voiceInput.cancel({ runId: result.runId });
      await restoreSystemAudioForRecording();
      setDraftText('');
      setDraftSource(null);
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      runIdRef.current = null;
      ownedRunIdRef.current = null;
      setVoiceState('done');
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    captureStart.drainPendingChunks();
    resolveStartReadyState(attemptId, result);
  }, [
    appendAudioChunk,
    buildRefinementContext,
    canAcceptAudioChunk,
    createStartReadyState,
    disabled,
    failActiveRecording,
    formatVoiceInputStartError,
    formatMicrophoneFallbackMessage,
    formatMicrophoneStartError,
    invalidateStartAttempt,
    isActiveStartAttempt,
    muteSystemAudioForRecording,
    promptCodexSessionExpired,
    readEditorSelectionRange,
    resolveStartReadyState,
    restoreEditorFocusAfterVoiceInput,
    restoreSystemAudioForRecording,
    setVoiceState,
    stopEngine,
    t,
    voiceInputSettings.language,
    voiceInputSettings.microphoneDeviceId,
    voiceInputSettings.fastActivationEnabled,
    voiceInputSettings.muteSystemAudio,
    voiceInputSettings.refinementEnabled,
    options,
  ]);

  const notifyReadyForEndCue = useCallback((options?: VoiceInputStopOptions) => {
    try {
      options?.onReadyForEndCue?.();
    } catch (error) {
      log.warn('voice input end cue callback failed:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const restoreSystemAudioAndNotifyEndCue = useCallback((options?: VoiceInputStopOptions) => {
    return restoreSystemAudioForRecording().finally(() => {
      notifyReadyForEndCue(options);
    });
  }, [notifyReadyForEndCue, restoreSystemAudioForRecording]);

  const waitForBusyCompletion = useCallback((waitForRefinement: boolean) => {
    if (
      stateRef.current !== 'listening' &&
      stateRef.current !== 'submitting' &&
      stateRef.current !== 'refining'
    ) {
      return Promise.resolve();
    }
    const waiter: StopCompletionWaiter = {
      resolve: () => {},
      waitForRefinement,
    };
    const stopCompletion = new Promise<void>((resolve) => {
      waiter.resolve = resolve;
      stopCompletionWaitersRef.current = [...stopCompletionWaitersRef.current, waiter];
    });
    return Promise.race([
      stopCompletion,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, waitForRefinement
          ? STOP_WAIT_REFINEMENT_FAILSAFE_MS
          : STOP_WAIT_RAW_TIMEOUT_MS);
      }),
    ]).finally(() => {
      stopCompletionWaitersRef.current = stopCompletionWaitersRef.current.filter((item) => item !== waiter);
    });
  }, []);

  const stop = useCallback(async (options?: VoiceInputStopOptions) => {
    const currentState = stateRef.current;
    if (currentState === 'submitting' || currentState === 'refining') {
      await waitForBusyCompletion(Boolean(options?.waitForRefinement));
      if (stateRef.current === 'error') {
        throw new Error(lastErrorRef.current ?? 'Voice input failed.');
      }
      commitUsageStats();
      return;
    }
    if (currentState !== 'listening') return;
    let runId = runIdRef.current;
    let restorePromise: Promise<void> | null = null;
    setVoiceState('submitting');
    if (!runId) {
      const startReady = startReadyRef.current;
      await drainAndStopEngine();
      restorePromise = restoreSystemAudioAndNotifyEndCue(options);
      if (startReady) {
        const startResult = await waitForStartReadyWhileStopping(startReady);
        if (!startResult.ok) {
          invalidateStartAttempt();
          await restorePromise;
          commitUsageStats();
          setDraftText('');
          setDraftSource(null);
          draftDisplayRangeRef.current = null;
          insertionRangeRef.current = null;
          submittedRangesRef.current.clear();
          ownedRunIdRef.current = null;
          resolveStopCompletion();
          setVoiceState('error');
          promptCodexSessionExpired(startResult.authErrorReason ?? startResult.error);
          reportVoiceInputError(formatVoiceInputStartError(startResult.error));
          restoreEditorFocusAfterVoiceInput();
          throw new Error(startResult.error);
        }
        runId = startResult.runId;
        await drainAndStopEngine();
        await drainQueuedAudioToMain();
      } else {
        invalidateStartAttempt();
        try {
          await window.electronAPI.voiceInput.cancel();
        } finally {
          await restorePromise;
        }
        commitUsageStats();
        setDraftText('');
        setDraftSource(null);
        draftDisplayRangeRef.current = null;
        insertionRangeRef.current = null;
        submittedRangesRef.current.clear();
        ownedRunIdRef.current = null;
        resolveStopCompletion();
        setVoiceState('done');
        restoreEditorFocusAfterVoiceInput();
        return;
      }
    } else {
      await drainAndStopEngine();
    }
    runIdRef.current = null;
    restorePromise ??= restoreSystemAudioAndNotifyEndCue(options);

    const waitForRefinement = Boolean(options?.waitForRefinement);
    const busyCompletion = waitForBusyCompletion(waitForRefinement);
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await window.electronAPI.voiceInput.stop();
    } finally {
      await restorePromise;
    }
    if (!result.ok) {
      resolveStopCompletion();
      setVoiceState('error');
      commitUsageStats();
      reportVoiceInputError(result.error);
      restoreEditorFocusAfterVoiceInput();
      throw new Error(result.error);
    }
    await busyCompletion;
    const stateAfterStop = stateRef.current as VoiceInputState;
    if (stateAfterStop === 'error') {
      throw new Error(lastErrorRef.current ?? 'Voice input failed.');
    }
    commitUsageStats();
    if (stateAfterStop === 'submitting') {
      setDraftText('');
      setDraftSource(null);
      insertionRangeRef.current = null;
      submittedRangesRef.current.clear();
      runIdRef.current = null;
      ownedRunIdRef.current = null;
      setVoiceState('done');
      restoreEditorFocusAfterVoiceInput();
    }
  }, [commitUsageStats, dismissInlineError, drainAndStopEngine, drainQueuedAudioToMain, formatVoiceInputStartError, invalidateStartAttempt, reportVoiceInputError, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioAndNotifyEndCue, setVoiceState, waitForBusyCompletion, waitForStartReadyWhileStopping]);

  const stopWithGate = useCallback(async (options?: VoiceInputStopOptions) => {
    if (stopInFlightPromiseRef.current) return stopInFlightPromiseRef.current;
    stopInFlightRef.current = true;
    const stopPromise = stop(options).finally(() => {
      stopInFlightRef.current = false;
      stopInFlightPromiseRef.current = null;
    });
    stopInFlightPromiseRef.current = stopPromise;
    return stopPromise;
  }, [stop]);

  const cancel = useCallback(async () => {
    const runId = runIdRef.current;
    invalidateStartAttempt();
    resolveStopCompletion();
    await stopEngine();
    try {
      await window.electronAPI.voiceInput.cancel(runId ? { runId } : undefined);
    } finally {
      await restoreSystemAudioForRecording();
    }
    commitUsageStats();
    setDraftText('');
    setDraftSource(null);
    draftDisplayRangeRef.current = null;
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    insertionRangeRef.current = null;
    submittedRangesRef.current.clear();
    setVoiceState('done');
    restoreEditorFocusAfterVoiceInput();
  }, [commitUsageStats, invalidateStartAttempt, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioForRecording, setVoiceState, stopEngine]);

  useEffect(() => {
    const editorUnavailable = !editor || editor.isDestroyed || disabled;
    if (!editorUnavailable) return;
    const currentState = stateRef.current;
    if (
      currentState !== 'listening' &&
      currentState !== 'submitting' &&
      currentState !== 'refining'
    ) {
      return;
    }
    log.debug('voice input cancelled because editor became unavailable', {
      state: currentState,
      disabled: Boolean(disabled),
      hasEditor: Boolean(editor),
      editorDestroyed: Boolean(editor?.isDestroyed),
    });
    void cancel();
  }, [cancel, disabled, editor]);

  return {
    state,
    draftText,
    draftSource,
    draftRange: draftDisplayRangeRef.current ?? insertionRangeRef.current,
    lastError,
    isListening: state === 'listening',
    isBusy: state === 'listening' || state === 'submitting' || state === 'refining',
    start,
    stop: stopWithGate,
    cancel,
  };
}

function supportsSystemAudioMute(): boolean {
  return window.electronAPI.platform === 'darwin' || window.electronAPI.platform === 'win32';
}
