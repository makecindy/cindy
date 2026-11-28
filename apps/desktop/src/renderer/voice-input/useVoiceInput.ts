import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { closeHistory, undo as pmUndo } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { useTranslation } from 'react-i18next';
import type {
  DictationRefinementContext,
  RetainedFailedVoiceAudio,
  VoiceInputDraftSource,
  VoiceInputErrorCode,
  VoiceInputRendererEvent,
  VoiceInputState,
} from '@cindy/voice-input-core';
import {
  MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS,
  FailedVoiceAudioAccumulator,
  FAILED_VOICE_AUDIO_TTL_MS,
  isRetainedFailedVoiceAudioExpired,
  shouldRetainFailedVoiceAudio,
  takeRefinementContextHead,
  takeRefinementContextTail,
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
  buildEditorSelectionContext,
  selectedTextForVoiceContext,
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
import { streamRetainedAudioToMain } from './failedAudioReplay';
import {
  buildBaseVoiceInputRefinementContext,
  resolveBrowserVoiceInputLanguage,
} from './refinementContextBuilder';
import {
  createStartCueEchoTracker,
  createStartCueGate,
  type StartCueEchoTracker,
  type StartCueGate,
} from './startCue';
import { resolveVoiceInputStartGuards } from './startGuards';
import { createVoiceInputStartupTimeline, type VoiceInputStartupTimeline } from './startupTimeline';
import { getVoiceInputWorkletUrl } from './workletUrl';
import { buildRefinementPreviewText } from './refinementPreviewText';
import { useSpeakerFilterNotice } from './useSpeakerFilterNotice';
import { clearVoiceInputDraftInTransaction } from '@/components/new-chat/VoiceInputDraftDecoration';
import { dispatchVoiceInputEvent } from './eventScope';
import {
  clampEditorTextRangeToDoc,
  mapEditorTextRange,
  resolveInsertedTextRange,
  type EditorTextRange,
} from './editorRangeMapping';
import { mapTextTargetWatchRange } from './textTargetDictionaryWatch';
import { getVoiceInputErrorMessageKey, VOICE_INPUT_ERROR_CODE_KEYS } from './overlayErrors';
import {
  hasArmedDetachedVoiceDraft,
  settleArmedDetachedVoiceDraft,
} from '@/components/new-chat/composerSendOwnership';
import {
  VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
} from '../../shared/voiceInputDictionaryLearning';

const log = createLogger('voice-input');

function getVoiceInputBridge() {
  try {
    return typeof window !== 'undefined' ? (window.electronAPI?.voiceInput ?? null) : null;
  } catch {
    return null;
  }
}

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
  rawTranscriptText?: string;
  beforeSpanText?: string;
  historyEntryId: string | null;
};

type PreRefinedUndoEntry = {
  segmentId: string;
  start: number;
  end: number;
  rawText: string;
  refinedText: string;
  beforeSpanText: string;
  historyEntryId: string | null;
};

type FieldUndoState = {
  stage: 'refined' | 'raw';
  segmentId: string;
  start: number;
  end: number;
  beforeSpanText: string;
  rawText: string;
  refinedText: string;
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
  /** Last full input value observed for controlled plain-text (`textTarget`) watches. */
  lastFullText?: string;
  touchedTrailingEdge?: boolean;
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
const INLINE_RETRYABLE_ERROR_AUTO_DISMISS_MS = 60_000;

// Only the latest recording may issue a delayed mute. Restoration always carries
// that recording's ID so main can release an old lease while preserving its successor.
let systemAudioMuteOwner: string | null = null;

export type VoiceInputRefinementSnapshot = {
  basedOnText: string;
  refinedText: string;
};

export type VoiceInputMode = 'dictation' | 'rewrite';

export type UseVoiceInputResult = {
  state: VoiceInputState;
  activeMode: VoiceInputMode;
  draftText: string;
  draftSource: VoiceInputDraftSource | null;
  draftRange: EditorTextRange | null;
  lastError: string | null;
  /** Whether locally retained voiced audio from the last failed take can be re-recognized. */
  canRetryRecognition: boolean;
  isListening: boolean;
  isCaptureReady: boolean;
  isBusy: boolean;
  /** The voiceprint filter just muted someone else's speech in this run. */
  speakerFiltered: boolean;
  /** True when the latest dictation refinement can be reverted back to raw ASR text. */
  canUndoRefinement: boolean;
  /** Reverts the latest refined dictation span back to raw ASR text. */
  undoRefinement: () => boolean;
  /** Handles Cmd/Ctrl+Z for pre-refined pause dictations and controlled plain-text targets. */
  handleUndoKeyDown: (event: KeyboardEvent) => boolean;
  getLastSubmittedText: () => string;
  getLastRefinement: () => VoiceInputRefinementSnapshot | null;
  /** 同步读取当前状态，不经过 React 渲染。长按手势靠它判断是否占用了录音。 */
  getState: () => VoiceInputState;
  /** 仅预热音频处理与服务连接，不打开麦克风。 */
  prepare: () => void;
  /** 同步 claim 录音后立刻返回是否占用；启动流程（授权确认、采集、连接）在后台继续。 */
  start: (options?: VoiceInputStartOptions) => boolean;
  /** Replay the locally retained failed audio through ASR + refinement without reopening the mic. */
  retryRecognition: () => boolean;
  clearRetainedFailedAudio: () => void;
  stop: (options?: VoiceInputStopOptions) => Promise<void>;
  cancel: () => Promise<void>;
  /** Notify controlled `textTarget` dictionary watches after a user edit. */
  inspectTextTargetValue: (nextText: string) => void;
  /** Flush pending dictionary-learning edits (e.g. before switching drafts) and clear watches. */
  flushDictionaryLearningWatches: () => void;
  /** Drop active dictionary-learning watches without publishing (e.g. on account switch). */
  discardDictionaryLearningWatches: () => void;
};

export type VoiceInputStartOptions = {
  startedAt?: number;
  mode?: VoiceInputMode;
  beforeStart?: () => boolean | Promise<boolean>;
  /** Audible start feedback. Runs once the microphone is open, or after a short cap. */
  onStartFeedback?: () => void | Promise<void>;
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
  onSamples?: (pcm: ArrayBuffer) => void;
  /** Plain-text composers use string offsets instead of ProseMirror positions. */
  textTarget?: VoiceInputTextTarget;
  onMicrophonePermissionRequired?: (error: string) => void | Promise<void>;
  /** When false, keep refining in the background but do not write the live editor. */
  shouldApplyToEditor?: () => boolean;
  getDraftStorageKey?: () => string | undefined;
};

export type VoiceInputTextTarget = {
  getText: () => string;
  getSelection: () => EditorTextRange;
  replace: (range: EditorTextRange, text: string) => { start: number; end: number } | null;
  focus: () => void;
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
  const [activeMode, setActiveMode] = useState<VoiceInputMode>('dictation');
  const [captureReady, setCaptureReady] = useState(false);
  const startupTimelineRef = useRef<VoiceInputStartupTimeline | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftSource, setDraftSource] = useState<VoiceInputDraftSource | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [canRetryRecognition, setCanRetryRecognition] = useState(false);
  const activeModeRef = useRef<VoiceInputMode>('dictation');
  const rewriteTargetRef = useRef<{ start: number; end: number; originalText: string } | null>(null);
  const rewriteAppliedRef = useRef(false);
  const {
    visible: speakerFiltered,
    show: showSpeakerFiltered,
    clear: clearSpeakerFiltered,
  } = useSpeakerFilterNotice();
  const { t } = useTranslation();
  const { settings: voiceInputSettings } = useVoiceInputSettings();
  const promptCodexSessionExpired = useCodexSessionExpiredPrompt();
  const stateRef = useRef<VoiceInputState>('idle');
  const engineRef = useRef<WebMicAudioEngine | null>(null);
  const startCueGateRef = useRef<StartCueGate | null>(null);
  const startCueEchoTrackerRef = useRef<StartCueEchoTracker>(createStartCueEchoTracker());
  const runIdRef = useRef<string | null>(null);
  const systemAudioMutedRef = useRef(false);
  const systemAudioMuteOwnerRef = useRef<string | null>(null);
  const recordingIdRef = useRef<string>('');
  // The mute IPC takes 50-150ms (osascript on macOS). Recording start fires it
  // and forgets, so a fast stop may race with mute completion. Tracking the
  // in-flight promise lets restoreSystemAudioForRecording await it before
  // checking the muted ref, preventing leaked mute state.
  const pendingSystemAudioMutePromiseRef = useRef<Promise<void> | null>(null);
  const stopCompletionWaitersRef = useRef<StopCompletionWaiter[]>([]);
  const sentAudioMsRef = useRef(0);
  const hasRecordingContentRef = useRef(false);
  const hasCaptureSoundRef = useRef<(() => boolean) | null>(null);
  const terminalOutcomeRef = useRef<VoiceInputUsageOutcome>('success');
  const startAttemptIdRef = useRef(0);
  const startReadyRef = useRef<StartReadyState | null>(null);
  const ownedRunIdRef = useRef<string | null>(null);
  const eventAdmissionRevokedRef = useRef(false);
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
  const audioAccumulatorRef = useRef(new FailedVoiceAudioAccumulator());
  const retainedFailedAudioRef = useRef<RetainedFailedVoiceAudio | null>(null);
  const retainedAudioExpireTimerRef = useRef<number | null>(null);
  const retryingAudioRef = useRef(false);
  const shouldRestoreEditorFocusRef = useRef(false);
  const insertionRangeRef = useRef<EditorTextRange | null>(null);
  const draftDisplayRangeRef = useRef<EditorTextRange | null>(null);
  const submittedRangesRef = useRef(new Map<string, SubmittedTextRange>());
  const dictionaryLearningWatchesRef = useRef(new Map<string, DictionaryLearningWatch>());
  const preRefinedUndoRef = useRef<PreRefinedUndoEntry | null>(null);
  const fieldUndoStateRef = useRef<FieldUndoState | null>(null);
  const [canUndoRefinement, setCanUndoRefinement] = useState(false);
  const applyingVoiceTextRef = useRef(false);
  const editorRef = useRef<Editor | null>(editor);
  const disabledRef = useRef(Boolean(disabled));
  const optionsRef = useRef(options);
  const lastRefinementRef = useRef<VoiceInputRefinementSnapshot | null>(null);
  const lastSubmittedTextRef = useRef('');
  const stopWithGateRef = useRef<((options?: VoiceInputStopOptions) => Promise<void>) | null>(
    null,
  );
  editorRef.current = editor;
  disabledRef.current = Boolean(disabled);
  optionsRef.current = options;

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    if (next !== 'listening') setCaptureReady(false);
    if (next === 'error') terminalOutcomeRef.current = 'failed';
    setState(next);
  }, []);

  const getState = useCallback(() => stateRef.current, []);

  const isActiveStartAttempt = useCallback((attemptId: number) => (
    startAttemptIdRef.current === attemptId
    && (stateRef.current === 'listening' || stateRef.current === 'submitting')
  ), []);

  const invalidateStartAttempt = useCallback(() => {
    startAttemptIdRef.current += 1;
    startReadyRef.current?.resolve({ ok: false, error: 'Voice input start was cancelled.' });
    startReadyRef.current = null;
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
    // The attempt is ending: nothing is left for the start cue to wait for.
    startCueGateRef.current?.abandon();
    startCueEchoTrackerRef.current.reset();
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
    startCueGateRef.current?.abandon();
    startCueEchoTrackerRef.current.reset();
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
        if (optionsRef.current?.shouldApplyToEditor?.() === false || disabledRef.current) return;
        if (optionsRef.current?.textTarget) {
          optionsRef.current.textTarget.focus();
          return;
        }
        const current = editorRef.current;
        if (!current || current.isDestroyed || disabledRef.current) return;
        if (!current.isEditable) {
          current.setEditable(true, false);
        }
        current.commands.focus();
      }, 0);
    });
  }, []);

  const clearRetainedFailedAudio = useCallback(() => {
    if (retainedAudioExpireTimerRef.current !== null) {
      window.clearTimeout(retainedAudioExpireTimerRef.current);
      retainedAudioExpireTimerRef.current = null;
    }
    retainedFailedAudioRef.current = null;
    retryingAudioRef.current = false;
    setCanRetryRecognition(false);
  }, []);

  const retainFailedAudioIfEligible = useCallback((flags?: {
    cancelled?: boolean;
    permissionDenied?: boolean;
    captureFailed?: boolean;
  }): boolean => {
    if (retryingAudioRef.current) {
      retryingAudioRef.current = false;
      if (retainedFailedAudioRef.current && !isRetainedFailedVoiceAudioExpired(retainedFailedAudioRef.current)) {
        setCanRetryRecognition(true);
        return true;
      }
      clearRetainedFailedAudio();
      return false;
    }
    const recordingId = recordingIdRef.current;
    if (
      !flags?.cancelled &&
      !flags?.permissionDenied &&
      !flags?.captureFailed &&
      recordingId &&
      retainedFailedAudioRef.current?.id === recordingId &&
      !isRetainedFailedVoiceAudioExpired(retainedFailedAudioRef.current)
    ) {
      setCanRetryRecognition(true);
      return true;
    }
    const eligible = shouldRetainFailedVoiceAudio({
      hasSound: audioAccumulatorRef.current.hasSound,
      transcriptLanded: transcriptLandedRef.current,
      cancelled: Boolean(flags?.cancelled),
      permissionDenied: flags?.permissionDenied,
      captureFailed: flags?.captureFailed,
    });
    const snapshot = eligible
      ? audioAccumulatorRef.current.snapshot(recordingId || `voice-${Date.now()}`)
      : null;
    audioAccumulatorRef.current.clear();
    if (!snapshot) {
      clearRetainedFailedAudio();
      return false;
    }
    if (retainedAudioExpireTimerRef.current !== null) {
      window.clearTimeout(retainedAudioExpireTimerRef.current);
    }
    retainedFailedAudioRef.current = snapshot;
    setCanRetryRecognition(true);
    retainedAudioExpireTimerRef.current = window.setTimeout(() => {
      retainedAudioExpireTimerRef.current = null;
      retainedFailedAudioRef.current = null;
      setCanRetryRecognition(false);
    }, FAILED_VOICE_AUDIO_TTL_MS);
    return true;
  }, [clearRetainedFailedAudio]);

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
    const dismissDelayMs = retainedFailedAudioRef.current
      ? INLINE_RETRYABLE_ERROR_AUTO_DISMISS_MS
      : INLINE_ERROR_AUTO_DISMISS_MS;
    inlineErrorDismissTimerRef.current = window.setTimeout(() => {
      inlineErrorDismissTimerRef.current = null;
      setLastError(null);
    }, dismissDelayMs);
  }, [clearInlineErrorDismissTimer]);

  const formatVoiceInputStartError = useCallback((message: string): string => {
    const key = getVoiceInputErrorMessageKey(message);
    return key ? t(key) : message;
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


  const commitUsageStats = useCallback(() => {
    const audioMs = sentAudioMsRef.current;
    sentAudioMsRef.current = 0;
    recordVoiceInputUsage(audioMs, terminalOutcomeRef.current);
  }, []);

  const muteSystemAudioForRecording = useCallback((feedback: Promise<void>): Promise<void> => {
    if (!supportsSystemAudioMute()) {
      return Promise.resolve();
    }
    const owner = recordingIdRef.current;
    systemAudioMuteOwner = owner;
    systemAudioMuteOwnerRef.current = owner;
    systemAudioMutedRef.current = false;
    const mutePromise = feedback.catch(() => undefined)
      .then(() => systemAudioMuteOwner === owner
        ? window.electronAPI.voiceInput.muteSystemAudio({ recordingId: owner })
        : null)
      .then((result) => {
        if (!result || systemAudioMuteOwnerRef.current !== owner || systemAudioMuteOwner !== owner) return;
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
        if (pendingSystemAudioMutePromiseRef.current === mutePromise) {
          pendingSystemAudioMutePromiseRef.current = null;
        }
      });
    pendingSystemAudioMutePromiseRef.current = mutePromise;
    return mutePromise;
  }, []);

  const restoreSystemAudioForRecording = useCallback(async (expectedOwner = systemAudioMuteOwnerRef.current) => {
    if (!supportsSystemAudioMute()) return;
    const owner = expectedOwner;
    if (!owner) return;
    // Await any in-flight mute so we never skip a restore for a mute that
    // hadn't yet flipped systemAudioMutedRef when restore began.
    const pendingMute = pendingSystemAudioMutePromiseRef.current;
    if (pendingMute) await pendingMute;
    if (systemAudioMuteOwnerRef.current === owner) {
      systemAudioMuteOwnerRef.current = null;
      systemAudioMutedRef.current = false;
    }
    if (systemAudioMuteOwner === owner) systemAudioMuteOwner = null;
    try {
      const result = await window.electronAPI.voiceInput.restoreSystemAudio({ recordingId: owner });
      if (!result.ok) {
        log.warn('system audio restore failed:', result.error);
      }
    } catch (error) {
      log.warn('system audio restore failed:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const failActiveRecording = useCallback(async (message: string, flags?: { captureFailed?: boolean }) => {
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
    await stopEngine();
    retainFailedAudioIfEligible(flags);
    setVoiceState('error');
    reportVoiceInputError(message);
    restoreEditorFocusAfterVoiceInput();

    try {
      if (runId) await window.electronAPI.voiceInput.cancel({ runId });
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
    retainFailedAudioIfEligible,
    setVoiceState,
    stopEngine,
  ]);

  const readEditorSnapshot = useCallback(() => {
    const target = optionsRef.current?.textTarget;
    if (target) {
      const range = target.getSelection();
      return { inputValue: target.getText(), selectionStart: range.from, selectionEnd: range.to };
    }
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
    if (optionsRef.current?.textTarget) return optionsRef.current.textTarget.getSelection();
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
    if (!watch) return false;
    // Clearing the tracked text ends its lifetime even without a correction.
    clearDictionaryLearningWatchTimer(watch);
    dictionaryLearningWatchesRef.current.delete(segmentId);
    if (!watch.pendingEvidence) return false;
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

  const discardDictionaryLearningWatches = useCallback(() => {
    dictionaryLearningWatchesRef.current.forEach((watch) => {
      clearDictionaryLearningWatchTimer(watch);
    });
    dictionaryLearningWatchesRef.current.clear();
  }, [clearDictionaryLearningWatchTimer]);

  const upsertDictionaryLearningWatch = useCallback((watch: DictionaryLearningWatch) => {
    const target = optionsRef.current?.textTarget;
    const normalizedWatch: DictionaryLearningWatch = target
      ? {
          ...watch,
          lastFullText: watch.lastFullText ?? target.getText(),
        }
      : watch;
    const watches = dictionaryLearningWatchesRef.current;
    clearDictionaryLearningWatchTimer(watches.get(normalizedWatch.segmentId));
    watches.set(normalizedWatch.segmentId, normalizedWatch);
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
      const target = optionsRef.current?.textTarget;
      if (target) {
        const fullText = target.getText();
        const start = Math.max(0, Math.min(currentWatch.start, fullText.length));
        const end = Math.max(start, Math.min(currentWatch.end, fullText.length));
        const afterText = fullText.slice(start, end);
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
            selectionBefore: fullText.slice(Math.max(0, start - DICTIONARY_LEARNING_CONTEXT_CHARS), start),
            selectionAfter: fullText.slice(end, Math.min(fullText.length, end + DICTIONARY_LEARNING_CONTEXT_CHARS)),
          },
        };
        dictionaryLearningWatchesRef.current.delete(segmentId);
        publishDictionaryLearningEvidence(latestEvidence, 'track_timeout');
        return;
      }
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
    const activePreRefined = preRefinedUndoRef.current;
    if (activePreRefined) {
      // A later edit becomes the top history step. Leave its normal undo alone.
      preRefinedUndoRef.current = null;
      setCanUndoRefinement(false);
    }
    const evidences = Array.from(dictionaryLearningWatchesRef.current.values())
      .flatMap((watch) => {
        const start = transaction.mapping.map(watch.start, -1);
        const end = transaction.mapping.map(watch.end, -1);
        const range = clampEditorTextRange({ from: start, to: end }, transaction.doc);
        const currentText = transaction.doc.textBetween(range.from, range.to, '\n', '\n');
        if (!currentText) {
          finalizeDictionaryLearningWatch(watch.segmentId, 'clear_input_box');
          setCanUndoRefinement(false);
          return [];
        }
        // User undid refinement back to raw ASR text (e.g. Cmd/Ctrl+Z). Never
        // learn refined -> raw ASR filler/casing regressions as dictionary
        // edits; keep the watch alive with raw ASR as the new baseline so a
        // subsequent manual fix on the raw text still learns cleanly.
        if (
          watch.rawTranscriptText
          && watch.rawTranscriptText !== watch.baselineText
          && currentText === watch.rawTranscriptText
        ) {
          clearDictionaryLearningWatchTimer(watch);
          dictionaryLearningWatchesRef.current.set(watch.segmentId, {
            ...watch,
            baselineText: watch.rawTranscriptText,
            start: range.from,
            end: range.to,
            lastActivityAt: now,
            pendingAdviceTimer: undefined,
            pendingEvidence: undefined,
          });
          const submitted = submittedRangesRef.current.get(watch.segmentId);
          if (submitted) {
            submittedRangesRef.current.set(watch.segmentId, {
              ...submitted,
              start: range.from,
              end: range.to,
              submittedText: watch.rawTranscriptText,
            });
            if (submitted.historyEntryId) {
              updateVoiceInputHistoryEntry(submitted.historyEntryId, watch.rawTranscriptText);
            }
          }
          preRefinedUndoRef.current = null;
          setCanUndoRefinement(false);
          return [];
        }
        if (currentText === watch.baselineText) {
          clearDictionaryLearningWatchTimer(watch);
          dictionaryLearningWatchesRef.current.set(watch.segmentId, {
            ...watch,
            start: range.from,
            end: range.to,
            pendingAdviceTimer: undefined,
            // A later clear/unmount must not publish a correction the user undid.
            pendingEvidence: undefined,
          });
          return [];
        }
        setCanUndoRefinement(false);

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

  const inspectTextTargetValue = useCallback((nextFullText: string) => {
    if (applyingVoiceTextRef.current || !optionsRef.current?.textTarget) return;
    if (dictionaryLearningWatchesRef.current.size === 0) return;
    const now = Date.now();
    pruneDictionaryLearningWatches(now);
    const evidences: Array<{ segmentId: string; evidence: VoiceInputDictionaryLearningEvidence }> = [];
    for (const watch of Array.from(dictionaryLearningWatchesRef.current.values())) {
      const prevFullText = watch.lastFullText ?? '';
      if (prevFullText === nextFullText) continue;
      const mapped = mapTextTargetWatchRange(prevFullText, nextFullText, {
        start: watch.start,
        end: watch.end,
        touchedTrailingEdge: watch.touchedTrailingEdge,
      });
      if (mapped.status === 'cleared') {
        finalizeDictionaryLearningWatch(watch.segmentId, 'clear_input_box');
        continue;
      }
      if (mapped.status === 'lost') {
        finalizeDictionaryLearningWatch(watch.segmentId, 'range_lost');
        continue;
      }
      if (mapped.status === 'unchanged') {
        dictionaryLearningWatchesRef.current.set(watch.segmentId, {
          ...watch,
          start: mapped.start,
          end: mapped.end,
          touchedTrailingEdge: mapped.touchedTrailingEdge,
          lastFullText: nextFullText,
        });
        continue;
      }
      if (mapped.text === watch.baselineText) {
        clearDictionaryLearningWatchTimer(watch);
        dictionaryLearningWatchesRef.current.set(watch.segmentId, {
          ...watch,
          start: mapped.start,
          end: mapped.end,
          touchedTrailingEdge: mapped.touchedTrailingEdge,
          lastFullText: nextFullText,
          pendingAdviceTimer: undefined,
          pendingEvidence: undefined,
        });
        continue;
      }
      const evidence: VoiceInputDictionaryLearningEvidence = {
        source: 'in_app',
        rawTranscriptText: watch.rawTranscriptText,
        beforeText: watch.baselineText,
        afterText: mapped.text,
        context: {
          uiLanguage: navigator.language,
          sourceLanguage: resolveBrowserVoiceInputLanguage(voiceInputSettings.language),
          selectionBefore: nextFullText.slice(
            Math.max(0, mapped.start - DICTIONARY_LEARNING_CONTEXT_CHARS),
            mapped.start,
          ),
          selectionAfter: nextFullText.slice(
            mapped.end,
            Math.min(nextFullText.length, mapped.end + DICTIONARY_LEARNING_CONTEXT_CHARS),
          ),
        },
      };
      dictionaryLearningWatchesRef.current.set(watch.segmentId, {
        ...watch,
        start: mapped.start,
        end: mapped.end,
        touchedTrailingEdge: mapped.touchedTrailingEdge,
        lastFullText: nextFullText,
        lastActivityAt: now,
      });
      evidences.push({ segmentId: watch.segmentId, evidence });
    }
    if (evidences.length > 0) {
      evidences.forEach(({ segmentId, evidence }) => {
        scheduleDictionaryLearningAdvice(segmentId, evidence);
      });
      log.debug('voice input textTarget dictionary learning evidence detected', {
        count: evidences.length,
        rawTranscriptChars: evidences.map(({ evidence }) => evidence.rawTranscriptText?.length ?? 0),
        beforeChars: evidences.map(({ evidence }) => evidence.beforeText.length),
        afterChars: evidences.map(({ evidence }) => evidence.afterText.length),
      });
    }
  }, [
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
    const target = optionsRef.current?.textTarget;
    if (target) {
      const text = target.getText();
      const range = insertionRangeRef.current ?? target.getSelection();
      return {
        ...baseContext,
        selectionBefore: takeRefinementContextTail(text.slice(0, range.from)),
        selectedText: selectedTextForVoiceContext(text.slice(range.from, range.to), activeModeRef.current),
        selectionAfter: takeRefinementContextHead(text.slice(range.to)),
        replyToMessage,
      };
    }
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
      ...buildEditorSelectionContext(doc, range, activeModeRef.current),
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

  const insertSubmittedText = useCallback((
    text: string,
  ): { start: number; end: number; beforeSpanText?: string } | null => {
    if (optionsRef.current?.shouldApplyToEditor?.() === false) return null;
    const target = optionsRef.current?.textTarget;
    if (target) {
      const range = insertionRangeRef.current ?? target.getSelection();
      insertionRangeRef.current = null;
      const beforeSpanText = target.getText().slice(range.from, range.to);
      applyingVoiceTextRef.current = true;
      try {
        const inserted = target.replace(range, text);
        return inserted ? { ...inserted, beforeSpanText } : null;
      } finally {
        applyingVoiceTextRef.current = false;
      }
    }
    const current = editorRef.current;
    if (!current || current.isDestroyed) return null;
    current.commands.focus();
    const { state, dispatch } = current.view;
    const range = insertionRangeRef.current
      ? clampEditorTextRange(insertionRangeRef.current, state.doc)
      : { from: state.selection.from, to: state.selection.to };
    const beforeSpanText = state.doc.textBetween(range.from, range.to, '\n', '\n');
    insertionRangeRef.current = null;
    applyingVoiceTextRef.current = true;
    try {
      // Close the previous ProseMirror history group so raw dictation lands as
      // its own undo step, distinct from both prior typing and later refinement.
      const transaction = closeHistory(state.tr.insertText(text, range.from, range.to));
      // 上屏范围必须从事务推导,不能用插入前的 from:替换区间可以合法地从 block
      // 边界开始(全选后听写就是 0..content.size),ProseMirror 会把 inline 文本
      // fit 进段落,字形实际落在边界之后。用旧 from 记录会让润色回填、润色预览与
      // 词典学习 watch 整体错位(润色会因读到截断文本而被丢弃)。
      const inserted = resolveInsertedTextRange(transaction, range.from, text.length);
      dispatch(clearVoiceInputDraftInTransaction(transaction));
      return { ...inserted, beforeSpanText };
    } finally {
      applyingVoiceTextRef.current = false;
    }
  }, [clampEditorTextRange]);

  const applyRefinedText = useCallback((event: Extract<VoiceInputRendererEvent, { type: 'refined' }>): boolean => {
    if (optionsRef.current?.shouldApplyToEditor?.() === false) return false;
    const segmentId = event.range.segmentIds[0];
    const range = segmentId ? submittedRangesRef.current.get(segmentId) : undefined;
    const target = optionsRef.current?.textTarget;
    if (target) {
      if (!segmentId || !range) return false;
      const text = target.getText();
      const basedOnText = event.segment.basedOnText ?? range.rawTranscriptText ?? range.submittedText;
      if (range.end > text.length || ![range.submittedText, basedOnText].includes(text.slice(range.start, range.end))) return false;
      applyingVoiceTextRef.current = true;
      let replaced: { start: number; end: number } | null = null;
      try {
        replaced = target.replace({ from: range.start, to: range.end }, event.text);
      } finally {
        applyingVoiceTextRef.current = false;
      }
      if (!replaced) return false;
      submittedRangesRef.current.set(segmentId, { ...range, ...replaced, submittedText: event.text });
      if (basedOnText && basedOnText !== event.text) {
        fieldUndoStateRef.current = {
          stage: 'refined',
          segmentId,
          start: replaced.start,
          end: replaced.end,
          beforeSpanText: range.beforeSpanText ?? '',
          rawText: basedOnText,
          refinedText: event.text,
          historyEntryId: range.historyEntryId,
        };
        setCanUndoRefinement(true);
      }
      upsertDictionaryLearningWatch({
        segmentId,
        rawTranscriptText: basedOnText,
        baselineText: event.text,
        start: replaced.start,
        end: replaced.end,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        lastFullText: target.getText(),
      });
      if (range.historyEntryId) updateVoiceInputHistoryEntry(range.historyEntryId, event.text, basedOnText);
      return true;
    }
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
    const basedOnText = event.segment.basedOnText ?? range.rawTranscriptText ?? range.submittedText;
    if (currentText !== range.submittedText && currentText !== basedOnText) {
      log.debug('refinement skipped: submitted range changed', {
        segmentId,
        currentText,
        expectedText: range.submittedText,
        refinedText: event.text,
      });
      return false;
    }

    const isDistinctReplacement = currentText !== event.text;
    applyingVoiceTextRef.current = true;
    try {
      // Split raw insertion and refinement replacement into separate ProseMirror
      // history groups so the first Cmd/Ctrl+Z reverts back to raw ASR text and
      // the second Cmd/Ctrl+Z removes the dictation.
      const tr = isDistinctReplacement
        ? closeHistory(state.tr.insertText(event.text, range.start, range.end))
        : state.tr.insertText(event.text, range.start, range.end);
      dispatch(clearVoiceInputDraftInTransaction(tr));
      if (isDistinctReplacement) {
        // Close the refinement group immediately so subsequent typing within
        // ProseMirror's 500ms newGroupDelay does not merge into it.
        dispatch(closeHistory(current.view.state.tr));
      }
    } finally {
      applyingVoiceTextRef.current = false;
    }
    const nextEnd = range.start + event.text.length;
    submittedRangesRef.current.set(segmentId, {
      ...range,
      end: nextEnd,
      submittedText: event.text,
    });
    if (activeModeRef.current === 'rewrite') {
      rewriteAppliedRef.current = true;
      preRefinedUndoRef.current = null;
      setCanUndoRefinement(false);
    } else {
      if (isDistinctReplacement) {
        preRefinedUndoRef.current = null;
        setCanUndoRefinement(Boolean(basedOnText && basedOnText !== event.text));
      } else if (basedOnText && basedOnText !== event.text) {
        preRefinedUndoRef.current = {
          segmentId,
          start: range.start,
          end: nextEnd,
          rawText: basedOnText,
          refinedText: event.text,
          beforeSpanText: range.beforeSpanText ?? '',
          historyEntryId: range.historyEntryId,
        };
        setCanUndoRefinement(true);
      }
      upsertDictionaryLearningWatch({
        segmentId,
        rawTranscriptText: basedOnText,
        baselineText: event.text,
        start: range.start,
        end: nextEnd,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
    }
    if (range.historyEntryId) {
      updateVoiceInputHistoryEntry(range.historyEntryId, event.text, basedOnText);
    }
    return true;
  }, [upsertDictionaryLearningWatch]);

  const undoRefinement = useCallback((): boolean => {
    const target = optionsRef.current?.textTarget;
    if (target) {
      const undoState = fieldUndoStateRef.current;
      if (!undoState || undoState.stage !== 'refined') return false;
      const text = target.getText();
      if (undoState.end > text.length || text.slice(undoState.start, undoState.end) !== undoState.refinedText) {
        fieldUndoStateRef.current = null;
        setCanUndoRefinement(false);
        return false;
      }
      applyingVoiceTextRef.current = true;
      let replaced: { start: number; end: number } | null = null;
      try {
        replaced = target.replace({ from: undoState.start, to: undoState.end }, undoState.rawText);
      } finally {
        applyingVoiceTextRef.current = false;
      }
      if (!replaced) return false;
      const existingWatch = dictionaryLearningWatchesRef.current.get(undoState.segmentId);
      if (existingWatch) {
        clearDictionaryLearningWatchTimer(existingWatch);
        dictionaryLearningWatchesRef.current.set(undoState.segmentId, {
          ...existingWatch,
          baselineText: undoState.rawText,
          start: replaced.start,
          end: replaced.end,
          lastFullText: target.getText(),
          lastActivityAt: Date.now(),
          pendingAdviceTimer: undefined,
          pendingEvidence: undefined,
        });
      }
      fieldUndoStateRef.current = {
        ...undoState,
        stage: 'raw',
        start: replaced.start,
        end: replaced.end,
      };
      const existingRange = submittedRangesRef.current.get(undoState.segmentId);
      if (existingRange) {
        submittedRangesRef.current.set(undoState.segmentId, {
          ...existingRange,
          start: replaced.start,
          end: replaced.end,
          submittedText: undoState.rawText,
        });
      }
      if (undoState.historyEntryId) {
        updateVoiceInputHistoryEntry(undoState.historyEntryId, undoState.rawText);
      }
      setCanUndoRefinement(false);
      return true;
    }

    const current = editorRef.current;
    if (!current || current.isDestroyed) return false;

    const preRefined = preRefinedUndoRef.current;
    if (preRefined) {
      const { state, dispatch } = current.view;
      if (preRefined.end > state.doc.content.size) {
        preRefinedUndoRef.current = null;
        setCanUndoRefinement(false);
        return false;
      }
      const span = state.doc.textBetween(preRefined.start, preRefined.end, '\n', '\n');
      if (span !== preRefined.refinedText) {
        preRefinedUndoRef.current = null;
        setCanUndoRefinement(false);
        return false;
      }
      const expectedAfterUndo = state.doc.textBetween(0, preRefined.start, '\n', '\n')
        + preRefined.beforeSpanText
        + state.doc.textBetween(preRefined.end, state.doc.content.size, '\n', '\n');
      applyingVoiceTextRef.current = true;
      let nextStart = preRefined.start;
      let nextEnd = preRefined.start + preRefined.rawText.length;
      try {
        // Pop the pre-refined insertion group first when ProseMirror history is
        // mounted, then insert raw ASR as a fresh group so a second Cmd/Ctrl+Z
        // cleanly removes the dictation instead of toggling back to refined.
        const didPop = pmUndo(current.view.state, dispatch);
        const afterUndoState = current.view.state;
        const poppedText = afterUndoState.doc.textBetween(0, afterUndoState.doc.content.size, '\n', '\n');
        if (didPop && poppedText === expectedAfterUndo) {
          const insertPos = clampEditorTextRange(
            { from: afterUndoState.selection.from, to: afterUndoState.selection.to },
            afterUndoState.doc,
          );
          const rawTr = closeHistory(afterUndoState.tr.insertText(preRefined.rawText, insertPos.from, insertPos.to));
          const inserted = resolveInsertedTextRange(rawTr, insertPos.from, preRefined.rawText.length);
          dispatch(rawTr);
          dispatch(closeHistory(current.view.state.tr));
          nextStart = inserted.start;
          nextEnd = inserted.end;
        } else if (!didPop) {
          const replaceTr = closeHistory(
            current.view.state.tr.insertText(preRefined.rawText, preRefined.start, preRefined.end),
          );
          const inserted = resolveInsertedTextRange(replaceTr, preRefined.start, preRefined.rawText.length);
          dispatch(replaceTr);
          dispatch(closeHistory(current.view.state.tr));
          nextStart = inserted.start;
          nextEnd = inserted.end;
        } else {
          // History changed unexpectedly. It already undid one step; never
          // apply the stale dictation range to a different document.
          preRefinedUndoRef.current = null;
          setCanUndoRefinement(false);
          return true;
        }
      } finally {
        applyingVoiceTextRef.current = false;
      }
      const existingWatch = dictionaryLearningWatchesRef.current.get(preRefined.segmentId);
      if (existingWatch) {
        clearDictionaryLearningWatchTimer(existingWatch);
        dictionaryLearningWatchesRef.current.set(preRefined.segmentId, {
          ...existingWatch,
          baselineText: preRefined.rawText,
          start: nextStart,
          end: nextEnd,
          lastActivityAt: Date.now(),
          pendingAdviceTimer: undefined,
          pendingEvidence: undefined,
        });
      }
      const existingRange = submittedRangesRef.current.get(preRefined.segmentId);
      if (existingRange) {
        submittedRangesRef.current.set(preRefined.segmentId, {
          ...existingRange,
          start: nextStart,
          end: nextEnd,
          submittedText: preRefined.rawText,
        });
      }
      if (preRefined.historyEntryId) {
        updateVoiceInputHistoryEntry(preRefined.historyEntryId, preRefined.rawText);
      }
      preRefinedUndoRef.current = null;
      setCanUndoRefinement(false);
      return true;
    }

    // Post-stop refinement already sits in its own ProseMirror history group;
    // native undo restores raw ASR and inspectDictionaryLearningTransaction
    // resets the dictionary watch baseline cleanly.
    const latestRefined = Array.from(submittedRangesRef.current.values())
      .reverse()
      .find((entry) => entry.rawTranscriptText && entry.rawTranscriptText !== entry.submittedText);
    if (!latestRefined) return false;
    if (pmUndo(current.view.state, current.view.dispatch)) {
      return true;
    }
    return false;
  }, [clampEditorTextRange, clearDictionaryLearningWatchTimer]);

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
    const target = optionsRef.current?.textTarget;
    if (target) {
      const undoState = fieldUndoStateRef.current;
      if (!undoState) return false;
      if (undoState.stage === 'refined') {
        const handled = undoRefinement();
        if (handled) event.preventDefault?.();
        return handled;
      }
      const text = target.getText();
      if (undoState.end > text.length || text.slice(undoState.start, undoState.end) !== undoState.rawText) {
        fieldUndoStateRef.current = null;
        return false;
      }
      const replaced = target.replace({ from: undoState.start, to: undoState.end }, undoState.beforeSpanText);
      fieldUndoStateRef.current = null;
      if (replaced) {
        event.preventDefault?.();
        return true;
      }
      return false;
    }
    if (!preRefinedUndoRef.current) return false;
    const handled = undoRefinement();
    if (handled) event.preventDefault?.();
    return handled;
  }, [undoRefinement]);

  useEffect(() => {
    let subscribed = true;
    const unsubscribe = getVoiceInputBridge()?.onEvent((event) => {
      if (eventAdmissionRevokedRef.current) return;
      dispatchVoiceInputEvent(
        event,
        () => subscribed && !eventAdmissionRevokedRef.current ? ownedRunIdRef.current : null,
        startReadyRef.current?.promise,
        handleEvent,
      );
    });
    function handleEvent(event: VoiceInputRendererEvent): void {
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
            if (
              event.state === 'done' &&
              activeModeRef.current === 'rewrite' &&
              !rewriteAppliedRef.current &&
              hasRecordingContentRef.current &&
              terminalOutcomeRef.current !== 'cancelled' &&
              terminalOutcomeRef.current !== 'no_speech'
            ) {
              toast.warning(t('newChat.chatInput.voiceInput.rewriteFailed'));
            }
            activeModeRef.current = 'dictation';
            setActiveMode('dictation');
            rewriteTargetRef.current = null;
            rewriteAppliedRef.current = false;
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
          if (event.text.trim()) hasRecordingContentRef.current = true;
          if (event.text.trim()) startupTimelineRef.current?.mark('first_transcript');
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
          if (event.text.trim()) hasRecordingContentRef.current = true;
          if (event.text.trim()) startupTimelineRef.current?.mark('first_transcript');
          if (activeModeRef.current === 'rewrite') {
            // Explicit voice rewrite mode: never overwrite the selected text with the
            // spoken instruction. Keep the original selection intact until the rewritten
            // result arrives on `refined`, so failures or cancellation never destroy text.
            lastSubmittedTextRef.current = event.text;
            const rewriteTarget = rewriteTargetRef.current;
            if (rewriteTarget) {
              submittedRangesRef.current.set(event.segment.id, {
                segmentId: event.segment.id,
                start: rewriteTarget.start,
                end: rewriteTarget.end,
                submittedText: rewriteTarget.originalText,
                rawTranscriptText: event.text,
                historyEntryId: null,
              });
            }
            setDraftText(event.text);
            setDraftSource('stable');
            break;
          }
          {
            lastSubmittedTextRef.current = event.text;
            const range = insertSubmittedText(event.text);
            transcriptLandedRef.current = Boolean(range);
            if (range) {
              audioAccumulatorRef.current.clear();
              clearRetainedFailedAudio();
              const rawTranscriptText = event.segment.basedOnText ?? event.text;
              const historyEntryId = recordVoiceInputHistory(event.text);
              submittedRangesRef.current.set(event.segment.id, {
                segmentId: event.segment.id,
                start: range.start,
                end: range.end,
                submittedText: event.text,
                rawTranscriptText,
                beforeSpanText: range.beforeSpanText,
                historyEntryId,
              });
              if (rawTranscriptText !== event.text) {
                if (optionsRef.current?.textTarget) {
                  fieldUndoStateRef.current = {
                    stage: 'refined',
                    segmentId: event.segment.id,
                    start: range.start,
                    end: range.end,
                    beforeSpanText: range.beforeSpanText ?? '',
                    rawText: rawTranscriptText,
                    refinedText: event.text,
                    historyEntryId,
                  };
                } else {
                  preRefinedUndoRef.current = {
                    segmentId: event.segment.id,
                    start: range.start,
                    end: range.end,
                    rawText: rawTranscriptText,
                    refinedText: event.text,
                    beforeSpanText: range.beforeSpanText ?? '',
                    historyEntryId,
                  };
                }
                setCanUndoRefinement(true);
              } else {
                preRefinedUndoRef.current = null;
                fieldUndoStateRef.current = null;
                setCanUndoRefinement(false);
              }
              upsertDictionaryLearningWatch({
                segmentId: event.segment.id,
                rawTranscriptText,
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
            if (optionsRef.current?.shouldApplyToEditor?.() === false) break;
            const segmentId = event.range.segmentIds[0];
            const range = segmentId ? submittedRangesRef.current.get(segmentId) : undefined;
            const target = optionsRef.current?.textTarget;
            if (range && target) {
              if (target.getText().slice(range.start, range.end) !== range.submittedText) break;
              draftDisplayRangeRef.current = { from: range.start, to: range.end };
              setDraftText(buildRefinementPreviewText(event.segment.basedOnText ?? range.submittedText, event.text));
              setDraftSource('refinement');
              break;
            }
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
          {
            const segmentId = event.range.segmentIds[0];
            const range = segmentId ? submittedRangesRef.current.get(segmentId) : undefined;
            lastRefinementRef.current = {
              basedOnText: event.segment.basedOnText ?? range?.rawTranscriptText ?? range?.submittedText ?? '',
              refinedText: event.text,
            };
          }
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
          // Dispose the failed main-process run before dropping its ID. This
          // releases inline shortcut routing even if the composer stays mounted;
          // a scoped cancel cannot stop a newer run from another composer.
          const failedRunId = ownedRunIdRef.current ?? runIdRef.current;
          runIdRef.current = null;
          ownedRunIdRef.current = null;
          if (failedRunId) {
            void window.electronAPI.voiceInput.cancel({ runId: failedRunId }).catch((error) => {
              log.warn('failed voice input cleanup:', error instanceof Error ? error.message : String(error));
            });
          }
          retainFailedAudioIfEligible();
          resolveStopCompletion();
          reportVoiceInputError(formattedMessage);
          restoreEditorFocusAfterVoiceInput();
          break;
        }
        case 'usage':
          recordVoiceInputRefinementUsage(event.refinement);
          break;
        case 'speaker-filtered':
          showSpeakerFiltered();
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
    }
    const stopListening = () => {
      subscribed = false;
      unsubscribe?.();
    };
    return () => {
      if (!optionsRef.current?.textTarget && hasArmedDetachedVoiceDraft(optionsRef.current?.getDraftStorageKey?.())) {
        const timeoutId = window.setTimeout(stopListening, STOP_WAIT_REFINEMENT_FAILSAFE_MS);
        const intervalId = window.setInterval(() => {
          if (hasArmedDetachedVoiceDraft(optionsRef.current?.getDraftStorageKey?.())) return;
          window.clearInterval(intervalId);
          window.clearTimeout(timeoutId);
          stopListening();
        }, 100);
        return;
      }
      stopListening();
    };
  }, [applyRefinedText, clampEditorTextRange, clearRetainedFailedAudio, commitUsageStats, formatVoiceInputError, insertSubmittedText, promptCodexSessionExpired, recordVisibleTextChanged, reportVoiceInputError, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioForRecording, retainFailedAudioIfEligible, setVoiceState, showSpeakerFiltered, stopEngine, upsertDictionaryLearningWatch]);

  useEffect(() => {
    return () => {
      const draftKey = optionsRef.current?.getDraftStorageKey?.();
      if (!optionsRef.current?.textTarget && hasArmedDetachedVoiceDraft(draftKey)) {
        const stop = stopWithGateRef.current;
        void (stop ? stop({ waitForRefinement: true }) : Promise.resolve())
          .catch(() => undefined)
          .finally(() => {
            settleArmedDetachedVoiceDraft(
              lastRefinementRef.current?.refinedText.trim() || lastSubmittedTextRef.current.trim(),
            );
            commitUsageStats();
            clearDictionaryLearningWatches();
            void stopEngine();
            void restoreSystemAudioForRecording();
            clearInlineErrorDismissTimer();
          });
        return;
      }
      if (!optionsRef.current?.textTarget && hasArmedDetachedVoiceDraft()) {
        // Another ChatInput owns the in-flight persist; do not cancel or settle it.
        return;
      }
      resolveStopCompletion();
      invalidateStartAttempt();
      const ownedRunId = ownedRunIdRef.current ?? runIdRef.current;
      ownedRunIdRef.current = null;
      runIdRef.current = null;
      commitUsageStats();
      clearDictionaryLearningWatches();
      audioAccumulatorRef.current.clear();
      clearRetainedFailedAudio();
      void stopEngine();
      void restoreSystemAudioForRecording();
      // A main-group and a thread composer can coexist. Disposing an idle
      // composer must never cancel the other one's recording.
      if (ownedRunId) void window.electronAPI.voiceInput.cancel({ runId: ownedRunId });
      clearInlineErrorDismissTimer();
    };
  }, [
    clearDictionaryLearningWatches,
    clearInlineErrorDismissTimer,
    clearRetainedFailedAudio,
    invalidateStartAttempt,
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
    const bridge = getVoiceInputBridge();
    if (disabledRef.current || !bridge) return;
    void bridge.prewarm?.({
      sourceLanguage: voiceInputSettings.language,
      refinementEnabled: voiceInputSettings.refinementEnabled,
    })?.catch(() => undefined);
    void prewarmVoiceInputAudio(getVoiceInputWorkletUrl()).catch(() => undefined);
    if (import.meta.env.DEV) void prewarmVoiceInputBenchmarkFixture().catch(() => undefined);
  }, [voiceInputSettings.language, voiceInputSettings.refinementEnabled]);

  // Microphone keep-alive is deliberately a separate effect: unlike the prewarm
  // above it opens a real capture device and turns on the OS privacy indicator,
  // so it must not re-run for settings unrelated to the microphone. It only
  // opens the device while the user is inside the use window, so a remount
  // cannot relight the indicator on its own (see WebMicAudioEngine). Language
  // and refinement changes used to re-assert keep-alive intent here, which kept
  // the device warm for reasons the user never asked for.
  useEffect(() => {
    const bridge = getVoiceInputBridge();
    if (disabledRef.current || !bridge) return;
    if (!voiceInputSettings.fastActivationEnabled) {
      void disposeKeepAliveVoiceInputMicrophone('setting_disabled').catch(() => undefined);
      return;
    }
    const permission = bridge.getMicrophonePermissionCached?.();
    if (!permission?.ok) return;
    const workletUrl = getVoiceInputWorkletUrl();
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

  const prepare = useCallback(() => {
    const bridge = getVoiceInputBridge();
    if (disabledRef.current || !bridge || !editorRef.current || editorRef.current.isDestroyed) return;
    if (!['idle', 'done', 'error'].includes(stateRef.current)) return;
    // Every composer mouse-down reaches here, including ordinary clicks and
    // text selection. Opening even an authorized microphone can switch Bluetooth
    // headphones to call audio, so leave device capture to start() after the hold.
    void prewarmVoiceInputAudio(getVoiceInputWorkletUrl()).catch(() => undefined);
    void bridge.prewarm?.({
      sourceLanguage: voiceInputSettings.language,
      refinementEnabled: voiceInputSettings.refinementEnabled,
    })?.catch(() => undefined);
  }, [voiceInputSettings.language, voiceInputSettings.refinementEnabled]);

  const start = useCallback((startOptions?: VoiceInputStartOptions): boolean => {
    const currentState = stateRef.current;
    if (
      disabled ||
      !getVoiceInputBridge()?.start ||
      (!editorRef.current && !optionsRef.current?.textTarget) ||
      stopInFlightRef.current ||
      currentState === 'listening' ||
      currentState === 'submitting' ||
      currentState === 'refining'
    ) {
      return false;
    }
    const requestedMode: VoiceInputMode = startOptions?.mode === 'rewrite' ? 'rewrite' : 'dictation';
    const initialRange = readEditorSelectionRange();
    if (requestedMode === 'rewrite') {
      if (!initialRange || initialRange.to <= initialRange.from) return false;
      const target = optionsRef.current?.textTarget;
      let originalText = '';
      if (target) {
        originalText = target.getText().slice(initialRange.from, initialRange.to);
      } else {
        const current = editorRef.current;
        if (!current || current.isDestroyed) return false;
        const clamped = clampEditorTextRange(initialRange, current.state.doc);
        if (clamped.to <= clamped.from) return false;
        originalText = current.state.doc.textBetween(clamped.from, clamped.to, '');
        initialRange.from = clamped.from;
        initialRange.to = clamped.to;
      }
      if (!originalText.trim()) return false;
      if (originalText.replace(/\r\n?/g, '\n').length > MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS) {
        toast.warning(t('newChat.chatInput.voiceInput.rewriteFailed'));
        return false;
      }
      activeModeRef.current = 'rewrite';
      setActiveMode('rewrite');
      rewriteTargetRef.current = { start: initialRange.from, end: initialRange.to, originalText };
      rewriteAppliedRef.current = false;
    } else {
      activeModeRef.current = 'dictation';
      setActiveMode('dictation');
      rewriteTargetRef.current = null;
      rewriteAppliedRef.current = false;
    }
    const timeline = createVoiceInputStartupTimeline('inline', startOptions?.startedAt);
    startupTimelineRef.current = timeline;
    setCaptureReady(false);
    dismissInlineError();
    clearSpeakerFiltered();
    audioAccumulatorRef.current.clear();
    clearRetainedFailedAudio();
    shouldRestoreEditorFocusRef.current = true;
    insertionRangeRef.current = initialRange;
    draftDisplayRangeRef.current = initialRange;
    setDraftText('');
    setDraftSource(null);
    setVoiceState('listening');
    eventAdmissionRevokedRef.current = false;
    const recordingId = crypto.randomUUID();
    recordingIdRef.current = recordingId;
    const attemptId = startAttemptIdRef.current + 1;
    startAttemptIdRef.current = attemptId;
    createStartReadyState(attemptId);
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    submittedRangesRef.current.clear();
    preRefinedUndoRef.current = null;
    fieldUndoStateRef.current = null;
    setCanUndoRefinement(false);
    lastRefinementRef.current = null;
    lastSubmittedTextRef.current = '';
    transcriptLandedRef.current = false;
    hasRecordingContentRef.current = false;
    hasCaptureSoundRef.current = null;
    sentAudioMsRef.current = 0;
    terminalOutcomeRef.current = 'success';

    // 同步 claim 已经返回,启动流程在后台继续:本地采集与提示音先走,授权确认
    // （beforeStart）、服务可用性检查与云端连接随后;stop() 通过 start-ready 等待
    // 这段启动期,松手后立刻进入停止流程,不必等这里的异步步骤全部完成。
    void (async () => {
    const { elapsedMs } = timeline;

    // The start cue and system mute both touch the speakers. Hold them until the
    // microphone is open so capture does not queue behind that (see
    // createStartCueGate).
    const cueGate = createStartCueGate();
    startCueGateRef.current = cueGate;
    const cueEchoTracker = createStartCueEchoTracker();
    startCueEchoTrackerRef.current = cueEchoTracker;

    const capturePromise = startVoiceInputCaptureSession({
      label: '',
      workletUrl: getVoiceInputWorkletUrl(),
      deviceId: voiceInputSettings.microphoneDeviceId ?? undefined,
      fastActivationEnabled: voiceInputSettings.fastActivationEnabled,
      getRunId: () => runIdRef.current,
      setEngine: (engine) => {
        engineRef.current = engine;
      },
      isCurrentEngine: (engine) => startAttemptIdRef.current === attemptId && engineRef.current === engine,
      timeline,
      onCaptureReady: () => {
        cueGate.release();
        if (!isActiveStartAttempt(attemptId) || stateRef.current !== 'listening') return;
        setCaptureReady(true);
      },
      onPcmCaptured: (pcm) => audioAccumulatorRef.current.append(pcm),
      onSamples: optionsRef.current?.onSamples,
      onSoundDetected: () => { hasRecordingContentRef.current = true; },
      onSoundEvidenceAvailable: (hasSound) => { hasCaptureSoundRef.current = hasSound; },
      isInStartCueEchoWindow: () => cueEchoTracker.isInEchoWindow(),
      appendAudioChunk,
      onInterrupted: (message) => {
        if (isActiveStartAttempt(attemptId)) void failActiveRecording(message, { captureFailed: true });
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

    // Start capture first; feedback follows the open microphone (bounded by the
    // gate's cap) and never waits for service checks or the cloud. Only system
    // mute waits for playback to avoid cutting it off.
    const feedback = cueGate.released.then((play) => {
      const playCue = startOptions?.onStartFeedback;
      if (!play || !playCue || !isActiveStartAttempt(attemptId) || stateRef.current !== 'listening') return;
      timeline.mark('start_cue_released');
      cueEchoTracker.markCueStarted();
      return Promise.resolve(playCue()).finally(() => {
        cueEchoTracker.markCueEnded();
      });
    });
    // A capture that never becomes ready (denied, unavailable, cancelled) has no
    // cue to wait for; do not leave system mute waiting for the cap.
    void capturePromise.then((capture) => { if (!capture.ok) cueGate.abandon(); });
    if (voiceInputSettings.muteSystemAudio && supportsSystemAudioMute()) {
      void muteSystemAudioForRecording(feedback).then(() => timeline.mark('mute_finished'));
    } else {
      void feedback.catch(() => undefined);
    }

    // Local capture (and its permission request) starts before service checks.
    // A slow account/readiness dialog must not cost the user's opening words.
    let proceed = true;
    try {
      proceed = (await startOptions?.beforeStart?.()) !== false;
    } catch (error) {
      if (isActiveStartAttempt(attemptId)) {
        const message = error instanceof Error ? error.message : String(error);
        resolveStartReadyState(attemptId, { ok: false, error: message });
        await failActiveRecording(message);
      }
      return;
    }
    if (!isActiveStartAttempt(attemptId)) return;
    if (!proceed) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      invalidateStartAttempt();
      await stopEngine();
      await restoreSystemAudioForRecording();
      draftDisplayRangeRef.current = null;
      insertionRangeRef.current = null;
      setVoiceState('idle');
      restoreEditorFocusAfterVoiceInput();
      return;
    }
    let guards: Awaited<ReturnType<typeof resolveVoiceInputStartGuards>>;
    try {
      guards = await resolveVoiceInputStartGuards();
    } catch (error) {
      if (isActiveStartAttempt(attemptId)) {
        const message = error instanceof Error ? error.message : String(error);
        resolveStartReadyState(attemptId, { ok: false, error: message });
        await failActiveRecording(message);
      }
      return;
    }
    timeline.mark('checks_finished');
    log.info('voice input start guards checked', {
      ok: guards.ok,
      failed: guards.ok ? undefined : guards.failed,
      permissionSource: guards.permissionSource,
      readinessSource: guards.readinessSource,
      elapsedMs: elapsedMs(),
    });
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
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
      await stopEngine();
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
        case 'local-asr-model-missing':
          readinessError = t('settings.voiceInput.serviceSource.credentialError.localAsrModelMissing');
          break;
        case 'local-asr-unsupported':
          readinessError = t('settings.voiceInput.serviceSource.credentialError.localAsrUnsupported');
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
      await stopEngine();
      await restoreSystemAudioForRecording();
      restoreEditorFocusAfterVoiceInput();
      return;
    }

    const startPayload = {
      recordingId,
      mode: requestedMode,
      sourceLanguage: voiceInputSettings.language,
      refinementEnabled: requestedMode === 'rewrite' ? true : voiceInputSettings.refinementEnabled,
      refinementContext: requestedMode === 'rewrite' || voiceInputSettings.refinementEnabled
        ? buildRefinementContext()
        : undefined,
      refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
    };
    const startResultPromise: Promise<StartVoiceInputResult> = window.electronAPI.voiceInput
      .start(startPayload)
      .then((result) => {
        if (result.ok) timeline.mark('connection_ready');
        return result;
      })
      .catch((startError) => ({
        ok: false as const,
        error: startError instanceof Error ? startError.message : String(startError),
      }));

    const captureStart = await capturePromise;
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      void startResultPromise.then((result) => {
        if (result.ok) void window.electronAPI.voiceInput.cancel({ runId: result.runId });
      });
      return;
    }
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
      // Permission revoked after the start guard trusted a positive cache:
      // route to the same recovery prompt as a guard-time denial instead of
      // making the user retry before they see how to fix it.
      if (captureStart.permissionDenied && options?.onMicrophonePermissionRequired) {
        void options.onMicrophonePermissionRequired(captureStart.error);
      } else {
        reportVoiceInputError(captureStart.error);
      }
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
      // The cancelling attempt already stopped its own device. A late network
      // result must not touch a replacement attempt's microphone or UI.
      if (result.ok) await window.electronAPI.voiceInput.cancel({ runId: result.runId });
      return;
    }
    if (!result.ok) {
      resolveStartReadyState(attemptId, result);
      await stopEngine();
      await restoreSystemAudioForRecording();
      retainFailedAudioIfEligible();
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
    })().catch((error) => {
      log.warn('voice input start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }, [
    appendAudioChunk,
    buildRefinementContext,
    clampEditorTextRange,
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

  const cancel = useCallback(async () => {
    const runId = ownedRunIdRef.current ?? runIdRef.current;
    const audioOwner = systemAudioMuteOwnerRef.current;
    invalidateStartAttempt();
    // Revoke event admission before any device/IPC await. Main may still be
    // draining stop ahead of cancel in the lifecycle queue.
    ownedRunIdRef.current = null;
    runIdRef.current = null;
    eventAdmissionRevokedRef.current = true;
    setDraftText('');
    setDraftSource(null);
    audioAccumulatorRef.current.clear();
    clearRetainedFailedAudio();
    const cancelledAttempt = startAttemptIdRef.current;
    resolveStopCompletion();
    await stopEngine();
    try {
      // A pending start is invalidated above and cleaned by its late runId.
      // An unscoped cancel could instead target another composer's new run.
      if (runId) await window.electronAPI.voiceInput.cancel({ runId });
    } catch {
      // Main releases the run in finally even if the provider rejects stop.
      // Admission is already revoked; local completion must still unlock the editor.
      log.warn('voice input cancel failed after local cancellation');
    } finally {
      await restoreSystemAudioForRecording(audioOwner);
    }
    if (startAttemptIdRef.current !== cancelledAttempt) return;
    commitUsageStats();
    setDraftText('');
    setDraftSource(null);
    draftDisplayRangeRef.current = null;
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    insertionRangeRef.current = null;
    submittedRangesRef.current.clear();
    activeModeRef.current = 'dictation';
    setActiveMode('dictation');
    rewriteTargetRef.current = null;
    rewriteAppliedRef.current = false;
    setVoiceState('done');
    restoreEditorFocusAfterVoiceInput();
  }, [commitUsageStats, invalidateStartAttempt, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioForRecording, setVoiceState, stopEngine]);

  const stop = useCallback(async (options?: VoiceInputStopOptions) => {
    const attemptId = startAttemptIdRef.current;
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
    if (hasRecordingContentRef.current) setVoiceState('submitting');
    // Include the final worklet sub-chunk before deciding there was no sound.
    // A silent recording must not wait for a pending cloud start or final text.
    await drainAndStopEngine();
    if (hasCaptureSoundRef.current?.()) hasRecordingContentRef.current = true;
    // An error during drain still belongs to this stop and must reject Send.
    // Only cancellation/replacement makes its continuation stale.
    if (startAttemptIdRef.current !== attemptId) return;
    if (stateRef.current === 'error') {
      throw new Error(lastErrorRef.current ?? 'Voice input failed.');
    }
    if (stateRef.current !== 'listening' && stateRef.current !== 'submitting') return;
    if (!hasRecordingContentRef.current) {
      log.info('silent recording ended without ASR finalization');
      await cancel();
      notifyReadyForEndCue(options);
      return;
    }
    let runId = runIdRef.current;
    let restorePromise: Promise<void> | null = null;
    setVoiceState('submitting');
    if (!runId) {
      const startReady = startReadyRef.current;
      await drainAndStopEngine();
      restorePromise = restoreSystemAudioAndNotifyEndCue(options);
      if (startReady) {
        const startResult = await waitForStartReadyWhileStopping(startReady);
        // Readiness may have failed this same attempt while stop was waiting.
        // Only cancellation/replacement skips its existing failure handling.
        if (startAttemptIdRef.current !== attemptId) return;
        if (!startResult.ok) {
          invalidateStartAttempt();
          await restorePromise;
          retainFailedAudioIfEligible();
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
        await restorePromise;
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
    // The extra post-start drain can fail this attempt and clear its run ID.
    // Only a new generation makes Send stale; report its failure first.
    if (startAttemptIdRef.current !== attemptId) return;
    const stateAfterDrain = stateRef.current as VoiceInputState;
    if (stateAfterDrain === 'error') {
      throw new Error(lastErrorRef.current ?? 'Voice input failed.');
    }
    if (!isActiveStartAttempt(attemptId) || ownedRunIdRef.current !== runId) return;
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
    // Main may already have emitted refining/done/error before this reply.
    // Only cancellation/replacement makes it stale; current runs still need
    // their completion wait and failure checks below.
    if (startAttemptIdRef.current !== attemptId) return;
    if (!result.ok) {
      retainFailedAudioIfEligible();
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
  }, [cancel, notifyReadyForEndCue, clearSpeakerFiltered, commitUsageStats, dismissInlineError, drainAndStopEngine, drainQueuedAudioToMain, formatVoiceInputStartError, invalidateStartAttempt, isActiveStartAttempt, reportVoiceInputError, resolveStopCompletion, restoreEditorFocusAfterVoiceInput, restoreSystemAudioAndNotifyEndCue, setVoiceState, waitForBusyCompletion, waitForStartReadyWhileStopping]);

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
  stopWithGateRef.current = stopWithGate;

  useEffect(() => {
    const editorUnavailable = (!options?.textTarget && (!editor || editor.isDestroyed)) || disabled;
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
  }, [cancel, disabled, editor, options?.textTarget]);

  const retryRecognition = useCallback((): boolean => {
    const bridge = getVoiceInputBridge();
    const retained = retainedFailedAudioRef.current;
    if (!retained || isRetainedFailedVoiceAudioExpired(retained)) {
      clearRetainedFailedAudio();
      return false;
    }
    const currentState = stateRef.current;
    if (
      disabled ||
      !bridge?.start ||
      (!editorRef.current && !optionsRef.current?.textTarget) ||
      stopInFlightRef.current ||
      currentState === 'listening' ||
      currentState === 'submitting' ||
      currentState === 'refining'
    ) {
      return false;
    }
    dismissInlineError();
    clearSpeakerFiltered();
    shouldRestoreEditorFocusRef.current = true;
    insertionRangeRef.current = readEditorSelectionRange();
    draftDisplayRangeRef.current = insertionRangeRef.current;
    setDraftText('');
    setDraftSource(null);
    setVoiceState('submitting');
    eventAdmissionRevokedRef.current = false;
    retryingAudioRef.current = true;
    const recordingId = crypto.randomUUID();
    recordingIdRef.current = recordingId;
    const attemptId = startAttemptIdRef.current + 1;
    startAttemptIdRef.current = attemptId;
    createStartReadyState(attemptId);
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    submittedRangesRef.current.clear();
    lastRefinementRef.current = null;
    lastSubmittedTextRef.current = '';
    hasRecordingContentRef.current = true;
    sentAudioMsRef.current = retained.durationMs;
    transcriptLandedRef.current = false;
    terminalOutcomeRef.current = 'success';

    void (async () => {
      const startPayload = {
        recordingId,
        sourceLanguage: voiceInputSettings.language,
        refinementEnabled: voiceInputSettings.refinementEnabled,
        refinementContext: voiceInputSettings.refinementEnabled ? buildRefinementContext() : undefined,
        refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
      };
      let result: StartVoiceInputResult;
      try {
        result = await bridge.start(startPayload);
      } catch (startError) {
        result = {
          ok: false,
          error: startError instanceof Error ? startError.message : String(startError),
        };
      }
      if (!isActiveStartAttempt(attemptId)) {
        resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
        if (result.ok) await bridge.cancel({ runId: result.runId }).catch(() => undefined);
        return;
      }
      if (!result.ok) {
        resolveStartReadyState(attemptId, result);
        retainFailedAudioIfEligible();
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
      resolveStartReadyState(attemptId, result);
      const streamed = await streamRetainedAudioToMain(retained, () => isActiveStartAttempt(attemptId));
      if (!streamed || !isActiveStartAttempt(attemptId)) return;
      runIdRef.current = null;
      let stopResult: { ok: true } | { ok: false; error: string };
      try {
        stopResult = await bridge.stop();
      } catch (stopError) {
        stopResult = {
          ok: false,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        };
      }
      if (startAttemptIdRef.current !== attemptId) return;
      if (!stopResult.ok) {
        retainFailedAudioIfEligible();
        resolveStopCompletion();
        setVoiceState('error');
        commitUsageStats();
        reportVoiceInputError(formatVoiceInputStartError(stopResult.error));
        restoreEditorFocusAfterVoiceInput();
      }
    })().catch((error) => {
      log.warn('voice input retry failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }, [
    buildRefinementContext,
    clearRetainedFailedAudio,
    clearSpeakerFiltered,
    commitUsageStats,
    createStartReadyState,
    disabled,
    dismissInlineError,
    formatVoiceInputStartError,
    isActiveStartAttempt,
    promptCodexSessionExpired,
    readEditorSelectionRange,
    reportVoiceInputError,
    resolveStartReadyState,
    resolveStopCompletion,
    restoreEditorFocusAfterVoiceInput,
    retainFailedAudioIfEligible,
    setVoiceState,
    voiceInputSettings.language,
    voiceInputSettings.refinementEnabled,
  ]);

  return {
    state,
    activeMode,
    draftText,
    draftSource,
    draftRange: draftDisplayRangeRef.current ?? insertionRangeRef.current,
    lastError,
    canRetryRecognition,
    isListening: state === 'listening',
    isCaptureReady: state === 'listening' && captureReady,
    isBusy: state === 'listening' || state === 'submitting' || state === 'refining',
    speakerFiltered,
    canUndoRefinement,
    undoRefinement,
    handleUndoKeyDown,
    getLastSubmittedText: () => lastSubmittedTextRef.current,
    getLastRefinement: () => lastRefinementRef.current,
    getState,
    prepare,
    start,
    retryRecognition,
    clearRetainedFailedAudio,
    stop: stopWithGate,
    cancel,
    inspectTextTargetValue,
    flushDictionaryLearningWatches: clearDictionaryLearningWatches,
    discardDictionaryLearningWatches,
  };
}

function supportsSystemAudioMute(): boolean {
  try {
    const platform = window.electronAPI?.platform;
    return platform === 'darwin' || platform === 'win32';
  } catch {
    return false;
  }
}
