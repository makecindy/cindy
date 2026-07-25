import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Check, Copy, Settings, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  DictationRefinementContext,
  VoiceInputErrorCode,
  VoiceInputState,
} from '@cindy/voice-input-core';

import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
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
  getVoiceInputSettings,
  subscribeVoiceInputSettings,
} from '@/hooks/useVoiceInputSettings';
import {
  recordVoiceInputRefinementUsage,
  recordVoiceInputUsage,
  type VoiceInputUsageOutcome,
} from '@/hooks/useVoiceInputUsageStats';
import {
  playVoiceInputEndCue,
  playVoiceInputStartCue,
  prepareVoiceInputCues,
} from './startCue';
import {
  VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
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
import { requestRendererMicrophonePermission, resolveVoiceInputStartGuards } from './startGuards';
import { formatVoiceInputShortcut } from './shortcut';
import { VoiceInputMicWaveIcon } from './VoiceInputMicWaveIcon';
import { getVoiceInputWorkletUrl } from './workletUrl';
import { VoiceInputPointerHintLayer } from './VoiceInputPointerHintLayer';
import { isVoiceInputServiceConnectionError } from './overlayErrors';
import {
  resolveVoiceInputReadinessRecovery,
  type VoiceInputRecoverySettingsTab,
} from './readinessRecovery';
import { buildRefinementPreviewText } from './refinementPreviewText';
import { isVoiceInputEventScopeActive, shouldHandleVoiceInputEvent } from './eventScope';
import { VoiceInputStatusErrorIcon, VoiceInputStatusNotice } from './VoiceInputStatusNotice';
import { useVoiceInputOverlayDrag } from './useVoiceInputOverlayDrag';

const log = createLogger('voice-input-overlay');
const workletUrl = getVoiceInputWorkletUrl();

// Renderer-only failsafe. Main/client own the real ASR/refine idle timeouts;
// this cap only prevents a broken IPC/state transition from leaving the HUD
// stuck forever while the user is waiting to paste.
const STOP_WAIT_TIMEOUT_MS = 90_000;
const START_READY_STOP_TIMEOUT_MS = 10_000;
const OVERLAY_ERROR_CLOSE_MS = 8_000;

type StartVoiceInputResult = { ok: true; runId: string } | { ok: false; error: string; authErrorReason?: string };
type StartReadyState = {
  attemptId: number;
  promise: Promise<StartVoiceInputResult>;
  resolve: (result: StartVoiceInputResult) => void;
};
type GlobalOverlayCommand = { type: 'start' | 'submit' | 'cancel' };
type CloseOverlayOptions = { preservePasteTarget?: boolean };
type PasteErrorCode = 'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed';
type PermissionPromptKind = 'microphone' | 'accessibility';

function resetOverlayFocus(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) activeElement.blur();
}

function preventOverlayButtonFocus(event: ReactFocusEvent<HTMLElement>): void {
  event.currentTarget.blur();
}

function beginOverlayButtonAction(event: ReactPointerEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.blur();
}

function suppressOverlayButtonClick(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function normalizePasteErrorCode(errorCode: string | undefined): PasteErrorCode {
  if (
    errorCode === 'empty' ||
    errorCode === 'unavailable' ||
    errorCode === 'unconfirmed' ||
    errorCode === 'permission' ||
    errorCode === 'failed'
  ) {
    return errorCode;
  }
  return 'failed';
}

function getPasteErrorHintKey(errorCode: PasteErrorCode | null): string {
  switch (errorCode) {
    case 'empty':
      return 'voiceInputOverlay.pasteErrors.empty';
    case 'unavailable':
      return 'voiceInputOverlay.pasteErrors.unavailable';
    case 'unconfirmed':
      return 'voiceInputOverlay.pasteErrors.unconfirmed';
    case 'permission':
      return 'voiceInputOverlay.pasteErrors.permission';
    case 'failed':
    default:
      return 'voiceInputOverlay.pasteErrors.failed';
  }
}

export function VoiceInputOverlay() {
  const { t, i18n } = useTranslation();
  const codexSessionPromptActiveRef = useRef(false);
  const promptCodexSessionExpired = useCodexSessionExpiredPrompt({
    onPromptClosed: () => {
      codexSessionPromptActiveRef.current = false;
    },
  });
  const [state, setState] = useState<VoiceInputState>('idle');
  const [draftText, setDraftText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [refinementPreviewText, setRefinementPreviewText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [microphoneNotice, setMicrophoneNotice] = useState<string | null>(null);
  const [hasPasteError, setHasPasteError] = useState(false);
  const [pasteErrorCode, setPasteErrorCode] = useState<PasteErrorCode | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptKind | null>(null);
  const [settingsRecoveryTab, setSettingsRecoveryTab] = useState<VoiceInputRecoverySettingsTab | null>(null);
  const [actionTipsDisabled, setActionTipsDisabled] = useState(false);
  const [stopInFlight, setStopInFlight] = useState(false);
  const [shortcutLabel, setShortcutLabel] = useState(() => (
    formatVoiceInputShortcut(getVoiceInputSettings().shortcut)
  ));

  const settingsRef = useRef(getVoiceInputSettings());
  const engineRef = useRef<WebMicAudioEngine | null>(null);
  const runIdRef = useRef<string | null>(null);
  const stateRef = useRef<VoiceInputState>('idle');
  const stopInFlightRef = useRef(false);
  const errorCloseTimerRef = useRef<number | null>(null);
  const draftTextRef = useRef('');
  const finalTextRef = useRef('');
  const rawTranscriptTextRef = useRef('');
  const pendingPasteTextRef = useRef('');
  const historyEntryIdRef = useRef<string | null>(null);
  const sentAudioMsRef = useRef(0);
  const terminalOutcomeRef = useRef<VoiceInputUsageOutcome>('success');
  const systemAudioMutedRef = useRef(false);
  const pendingSystemAudioMutePromiseRef = useRef<Promise<void> | null>(null);
  const systemAudioMuteGateOpenRef = useRef(true);
  const systemAudioMuteGateDropLoggedRef = useRef(false);
  const closingRef = useRef(false);
  const startAttemptIdRef = useRef(0);
  const pasteAttemptIdRef = useRef(0);
  const doneWaitersRef = useRef(new Set<() => void>());
  const startReadyRef = useRef<StartReadyState | null>(null);
  const ownedRunIdRef = useRef<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  // Set by cancelAndClose, checked by stopAndPaste after each await. Lets the
  // user abandon a run while it is in submitting/refining without paste firing
  // afterwards. closingRef alone could not do this — it is also raised by
  // stopAndPaste itself to gate re-entry, so reusing it would deadlock cancel.
  const cancelRequestedRef = useRef(false);
  const suppressedStartErrorAttemptsRef = useRef(new Set<number>());
  const settingsRecoveryTabRef = useRef<VoiceInputRecoverySettingsTab | null>(null);
  const openSettingsInFlightRef = useRef(false);

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    if (next === 'error') terminalOutcomeRef.current = 'failed';
    setState(next);
  }, []);

  const resetOverlayInteraction = useCallback(() => {
    resetOverlayFocus();
    // The global overlay is hidden instead of destroyed for fast reuse. Disable
    // action tips until the next real pointer move so stale hover/focus state
    // from the previous presentation cannot reopen a tooltip immediately.
    setActionTipsDisabled(true);
  }, []);

  const clearErrorCloseTimer = useCallback(() => {
    if (errorCloseTimerRef.current === null) return;
    window.clearTimeout(errorCloseTimerRef.current);
    errorCloseTimerRef.current = null;
  }, []);

  const resetHiddenOverlaySession = useCallback(() => {
    setError(null);
    setMicrophoneNotice(null);
    setHasPasteError(false);
    setPasteErrorCode(null);
    setPermissionPrompt(null);
    setSettingsRecoveryTab(null);
    settingsRecoveryTabRef.current = null;
    openSettingsInFlightRef.current = false;
    setDraftText('');
    setFinalText('');
    setRefinementPreviewText('');
    draftTextRef.current = '';
    finalTextRef.current = '';
    rawTranscriptTextRef.current = '';
    pendingPasteTextRef.current = '';
    historyEntryIdRef.current = null;
    terminalOutcomeRef.current = 'success';
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    startReadyRef.current = null;
    closingRef.current = false;
    cancelRequestedRef.current = false;
    stopInFlightRef.current = false;
    clearErrorCloseTimer();
    setStopInFlight(false);
    setVoiceState('idle');
    resetOverlayInteraction();
  }, [clearErrorCloseTimer, resetOverlayInteraction, setVoiceState]);

  const enableActionTips = useCallback(() => {
    setActionTipsDisabled(false);
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
        log.warn('global voice input start readiness timed out while stopping', {
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

  const resolveDoneWaiters = useCallback(() => {
    const waiters = Array.from(doneWaitersRef.current);
    doneWaitersRef.current.clear();
    waiters.forEach((resolve) => resolve());
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
    // Keep submit semantics lossless: the worklet can hold a sub-chunk that has
    // not reached the ASR provider yet. Drain it before asking the provider to
    // finalize, otherwise the final spoken word can be cut off.
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

  const commitUsageStats = useCallback(() => {
    const audioMs = sentAudioMsRef.current;
    sentAudioMsRef.current = 0;
    if (audioMs > 0) recordVoiceInputUsage(audioMs, terminalOutcomeRef.current);
  }, []);

  const formatVoiceInputError = useCallback((message: string, code?: VoiceInputErrorCode): string => {
    if (code === 'empty_transcript') return t('voiceInputOverlay.emptyTranscript');
    return message;
  }, [t]);

  const appendAudioChunk = useCallback((chunk: PcmChunk) => {
    sentAudioMsRef.current += chunk.trace.durationMs;
    window.electronAPI.voiceInput.appendAudio(chunk);
  }, []);

  const canAcceptAudioChunk = useCallback(() => {
    if (systemAudioMuteGateOpenRef.current) return true;
    if (!systemAudioMuteGateDropLoggedRef.current) {
      systemAudioMuteGateDropLoggedRef.current = true;
      log.debug('global dropping pcm until system audio mute completes');
    }
    return false;
  }, []);

  const formatVoiceInputStartError = useCallback((message: string): string => {
    if (isVoiceInputServiceConnectionError(message)) {
      return t('voiceInputOverlay.asrServiceUnavailable');
    }
    return message;
  }, [t]);

  const cancelStartedRun = useCallback((startPromise: Promise<StartVoiceInputResult>) => {
    void startPromise
      .then((result) => {
        if (!result.ok) return undefined;
        return window.electronAPI.voiceInput.cancel({ runId: result.runId });
      })
      .catch((error) => {
        log.warn('cancel pending global voice input start failed:', error instanceof Error ? error.message : String(error));
      });
  }, []);

  const muteSystemAudioForRecording = useCallback(() => {
    if (!supportsSystemAudioMute()) {
      systemAudioMuteGateOpenRef.current = true;
      return Promise.resolve();
    }
    if (systemAudioMutedRef.current) {
      systemAudioMuteGateOpenRef.current = true;
      return pendingSystemAudioMutePromiseRef.current ?? Promise.resolve();
    }
    if (pendingSystemAudioMutePromiseRef.current) return pendingSystemAudioMutePromiseRef.current;

    const mutePromise = window.electronAPI.voiceInput
      .muteSystemAudio()
      .then((result) => {
        if (result.ok) {
          systemAudioMutedRef.current = true;
        } else {
          log.warn('global system audio mute failed:', result.error);
        }
      })
      .catch((muteError) => {
        log.warn('global system audio mute failed:', muteError instanceof Error ? muteError.message : String(muteError));
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
    const pendingMute = pendingSystemAudioMutePromiseRef.current;
    if (pendingMute) await pendingMute;
    if (!systemAudioMutedRef.current) return;
    systemAudioMutedRef.current = false;
    try {
      const result = await window.electronAPI.voiceInput.restoreSystemAudio();
      if (!result.ok) {
        log.warn('system audio restore failed:', result.error);
      }
    } catch (restoreError) {
      log.warn('system audio restore failed:', restoreError instanceof Error ? restoreError.message : String(restoreError));
    }
  }, []);

  const restoreSystemAudioAndMaybePlayEndCue = useCallback((playEndCue: boolean) => {
    return restoreSystemAudioForRecording().finally(() => {
      // If "mute while recording" is enabled, the end cue must be emitted only
      // after restoring system audio. Keep this off the ASR/refine critical
      // path: callers start the restore immediately after mic shutdown but do
      // not wait for it before finalizing transcription.
      if (playEndCue) playVoiceInputEndCue();
    });
  }, [restoreSystemAudioForRecording]);

  const closeOverlay = useCallback(async (options?: CloseOverlayOptions) => {
    log.debug('global overlay close requested', {
      state: stateRef.current,
      hasPendingPasteText: Boolean(pendingPasteTextRef.current),
      hasPasteError,
      preservePasteTarget: Boolean(options?.preservePasteTarget),
    });
    try {
      await window.electronAPI.voiceInput.closeGlobalOverlay(options);
    } catch (closeError) {
      log.warn('global overlay close failed:', closeError instanceof Error ? closeError.message : String(closeError));
    }
  }, [hasPasteError]);

  const scheduleErrorClose = useCallback(() => {
    clearErrorCloseTimer();
    errorCloseTimerRef.current = window.setTimeout(() => {
      errorCloseTimerRef.current = null;
      void closeOverlay();
    }, OVERLAY_ERROR_CLOSE_MS);
  }, [clearErrorCloseTimer, closeOverlay]);

  const closeOverlayAndReset = useCallback(async (options?: CloseOverlayOptions) => {
    await closeOverlay(options);
    resetHiddenOverlaySession();
  }, [closeOverlay, resetHiddenOverlaySession]);

  const showStartFailure = useCallback(async (message: string, authErrorReason?: string) => {
    const failureAttemptId = startAttemptIdRef.current;
    resetOverlayInteraction();
    log.warn('global voice input start failed:', message);
    await stopEngine();
    await restoreSystemAudioForRecording();
    const modelSelection = await window.electronAPI.voiceInput.getModelSelection().catch((selectionError) => {
      log.warn(
        'read voice input model selection after start failure failed:',
        selectionError instanceof Error ? selectionError.message : String(selectionError),
      );
      return null;
    });
    const readinessRecovery = modelSelection && !modelSelection.readiness.ok
      ? resolveVoiceInputReadinessRecovery(modelSelection.readiness, modelSelection.selection.serviceMode)
      : null;
    if (startAttemptIdRef.current !== failureAttemptId) return;
    const promptReason = authErrorReason ?? message;
    const shouldPromptCodexSessionExpired = promptCodexSessionExpired(promptReason);
    if (shouldPromptCodexSessionExpired) {
      codexSessionPromptActiveRef.current = true;
    }
    setError(readinessRecovery ? t(readinessRecovery.messageKey) : formatVoiceInputStartError(message));
    settingsRecoveryTabRef.current = readinessRecovery?.settingsTab ?? null;
    setSettingsRecoveryTab(readinessRecovery?.settingsTab ?? null);
    setMicrophoneNotice(null);
    setHasPasteError(false);
    setPasteErrorCode(null);
    setPermissionPrompt(null);
    setVoiceState('error');
    closingRef.current = false;
    const showResult = await window.electronAPI.voiceInput.showGlobalOverlay();
    if (!showResult.ok) {
      log.warn('show global voice input start failure overlay failed:', showResult.error);
    }
    if (!shouldPromptCodexSessionExpired && !readinessRecovery) {
      scheduleErrorClose();
    }
  }, [
    closeOverlay,
    formatVoiceInputStartError,
    promptCodexSessionExpired,
    resetOverlayInteraction,
    restoreSystemAudioForRecording,
    scheduleErrorClose,
    setVoiceState,
    stopEngine,
    t,
  ]);

  const openReadinessSettings = useCallback(async () => {
    const tab = settingsRecoveryTab;
    if (!tab || openSettingsInFlightRef.current) return;
    openSettingsInFlightRef.current = true;
    try {
      await window.electronAPI.voiceInput.openSettings(tab);
    } catch (settingsError) {
      const ipcError = extractIpcError(settingsError);
      log.warn(
        'open voice input recovery settings failed:',
        ipcError?.message ?? (settingsError instanceof Error ? settingsError.message : String(settingsError)),
      );
      setError(t('voiceInputOverlay.settingsOpenFailed'));
    } finally {
      openSettingsInFlightRef.current = false;
    }
  }, [settingsRecoveryTab, t]);

  const cancelAndClose = useCallback(async () => {
    // Re-entry guard is the dedicated cancelRequestedRef, NOT closingRef —
    // closingRef is also raised by stopAndPaste at the start of submit, and
    // gating cancel on it means Esc/X stops working the moment the user
    // commits to a paste (i.e. throughout submitting + refining). The user
    // expects cancel to remain available until the overlay is actually gone.
    if (cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    suppressedStartErrorAttemptsRef.current.add(startAttemptIdRef.current);
    closingRef.current = true;
    startAttemptIdRef.current += 1;
    pasteAttemptIdRef.current += 1;
    resolveDoneWaiters();

    const runId = runIdRef.current;
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    try {
      await stopEngine();
      await window.electronAPI.voiceInput.cancel(runId ? { runId } : undefined);
    } finally {
      await restoreSystemAudioForRecording();
      commitUsageStats();
      setVoiceState('done');
      await closeOverlayAndReset();
    }
  }, [
    closeOverlayAndReset,
    commitUsageStats,
    resolveDoneWaiters,
    restoreSystemAudioForRecording,
    stopEngine,
  ]);

  const failRecording = useCallback(async (message: string) => {
    if (stateRef.current !== 'listening') return;
    log.warn('global microphone capture interrupted:', message);
    const runId = runIdRef.current;
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    setError(message);
    setVoiceState('error');
    resolveDoneWaiters();
    await stopEngine();
    try {
      await window.electronAPI.voiceInput.cancel(runId ? { runId } : undefined);
    } finally {
      await restoreSystemAudioForRecording();
      commitUsageStats();
    }
    scheduleErrorClose();
  }, [
    closeOverlay,
    commitUsageStats,
    resolveDoneWaiters,
    restoreSystemAudioForRecording,
    scheduleErrorClose,
    setVoiceState,
    stopEngine,
  ]);

  const buildRefinementContext = useCallback((): DictationRefinementContext => {
    const settings = settingsRef.current;
    return buildBaseVoiceInputRefinementContext({
      settings,
      uiLanguage: i18n.resolvedLanguage ?? i18n.language ?? navigator.language,
    });
  }, [i18n.language, i18n.resolvedLanguage]);

  const formatMicrophoneStartError = useCallback((error: unknown): string => {
    if (isMicrophoneDeviceUnavailableError(error)) {
      return t(
        isSelectedMicrophoneUnavailableError(error)
          ? 'settings.voiceInput.microphone.errors.selectedUnavailable'
          : 'settings.voiceInput.microphone.errors.deviceUnavailable',
      );
    }
    return error instanceof Error ? error.message : String(error);
  }, [t]);

  const formatMicrophoneFallbackMessage = useCallback((): string => (
    t('settings.voiceInput.microphone.errors.fallbackToAuto')
  ), [t]);

  // 这个 overlay 订阅的是全部语音设置,但只有这两项与采集设备有关。语言、润色等
  // 变更同样会走到这里,如果不过滤,一次无关设置改动就会在保活窗口已经到期释放后
  // 重新打开麦克风,让隐私指示灯毫无理由地重新亮起。
  const lastKeepAliveConfigRef = useRef<string | null>(null);

  const prewarmFastActivationIfEnabled = useCallback((settings: ReturnType<typeof getVoiceInputSettings>) => {
    const configKey = `${settings.fastActivationEnabled ? 'on' : 'off'}|${settings.microphoneDeviceId ?? ''}`;
    if (lastKeepAliveConfigRef.current === configKey) return;
    lastKeepAliveConfigRef.current = configKey;
    if (!settings.fastActivationEnabled) {
      void disposeKeepAliveVoiceInputMicrophone('setting_disabled').catch(() => undefined);
      return;
    }
    const permission = window.electronAPI.voiceInput.getMicrophonePermissionCached();
    if (!permission.ok) return;
    void prewarmVoiceInputMicrophoneWithAutomaticFallback(
      {
        workletUrl,
        deviceId: settings.microphoneDeviceId ?? undefined,
        ...createVoiceInputAudioProfile(true),
      },
      () => {
        log.warn('fast activation selected microphone unavailable, prewarming automatic microphone');
      },
    ).catch((error) => {
      log.warn('fast activation microphone prewarm failed', {
        error: error instanceof Error ? error.message : String(error),
        workletUrl,
        hasDeviceId: Boolean(settings.microphoneDeviceId),
      });
    });
  }, []);

  const startRecording = useCallback(async () => {
    if (stateRef.current === 'listening' || stateRef.current === 'submitting' || stateRef.current === 'refining') {
      return;
    }
    clearErrorCloseTimer();
    resetOverlayInteraction();
    const attemptId = startAttemptIdRef.current + 1;
    startAttemptIdRef.current = attemptId;
    createStartReadyState(attemptId);
    suppressedStartErrorAttemptsRef.current.delete(attemptId);
    pasteAttemptIdRef.current += 1;
    const settings = settingsRef.current;
    closingRef.current = false;
    cancelRequestedRef.current = false;
    await stopEngine();
    const bootstrapStartedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - bootstrapStartedAt);

    setError(null);
    setMicrophoneNotice(null);
    setHasPasteError(false);
    setPasteErrorCode(null);
    setPermissionPrompt(null);
    setSettingsRecoveryTab(null);
    settingsRecoveryTabRef.current = null;
    openSettingsInFlightRef.current = false;
    setDraftText('');
    setFinalText('');
    setRefinementPreviewText('');
    draftTextRef.current = '';
    finalTextRef.current = '';
    rawTranscriptTextRef.current = '';
    pendingPasteTextRef.current = '';
    historyEntryIdRef.current = null;
    sentAudioMsRef.current = 0;
    terminalOutcomeRef.current = 'success';
    runIdRef.current = null;
    ownedRunIdRef.current = null;
    systemAudioMuteGateOpenRef.current = true;
    systemAudioMuteGateDropLoggedRef.current = false;
    if (settings.muteSystemAudio && supportsSystemAudioMute()) {
      systemAudioMuteGateOpenRef.current = false;
      void muteSystemAudioForRecording();
    }
    setVoiceState('listening');

    log.debug('global voice input bootstrap requested');

    // Positive permission/readiness cache removes the common two-IPC delay
    // from shortcut-to-microphone. Negative or missing cache still uses the
    // async path so newly granted permission / freshly completed Codex login
    // can be picked up immediately. Main verifies readiness again in start().
    const guards = await resolveVoiceInputStartGuards({ requireAccessibility: true });
    log.debug('global voice input start guards checked', {
      ok: guards.ok,
      failed: guards.ok ? undefined : guards.failed,
      permissionSource: guards.permissionSource,
      accessibilitySource: guards.accessibilitySource,
      readinessSource: guards.readinessSource,
      auth: guards.readiness.auth,
      elapsedMs: elapsedMs(),
    });
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      await restoreSystemAudioForRecording();
      return;
    }
    if (!guards.permission.ok) {
      resolveStartReadyState(attemptId, { ok: false, error: t('voiceInputOverlay.permissionPrompts.microphone.message') });
      setError(t('voiceInputOverlay.permissionPrompts.microphone.message'));
      setPermissionPrompt('microphone');
      setVoiceState('done');
      closingRef.current = false;
      await restoreSystemAudioForRecording();
      return;
    }
    if (!guards.accessibility.ok) {
      resolveStartReadyState(attemptId, { ok: false, error: t('voiceInputOverlay.permissionPrompts.accessibility.message') });
      setError(t('voiceInputOverlay.permissionPrompts.accessibility.message'));
      setPermissionPrompt('accessibility');
      setVoiceState('done');
      closingRef.current = false;
      await restoreSystemAudioForRecording();
      return;
    }
    if (!guards.readiness.ok) {
      const error = guards.readiness.auth === 'codex'
        ? t('voiceInputOverlay.codexRequired')
        : t('voiceInputOverlay.apiKeyRequired');
      const authErrorReason = guards.readiness.authErrorReason;
      await showStartFailure(error, authErrorReason);
      resolveStartReadyState(attemptId, { ok: false, error });
      return;
    }

    if (settings.playInteractionSound) {
      prepareVoiceInputCues();
      playVoiceInputStartCue();
    }

    // Both gates passed — fire the start IPC in parallel with engine.start()
    // so the ASR WebSocket and mic capture initialize concurrently.
    const startResultPromise: Promise<StartVoiceInputResult> = window.electronAPI.voiceInput
      .start({
        sourceLanguage: settings.language,
        refinementEnabled: settings.refinementEnabled,
        refinementContext: settings.refinementEnabled ? buildRefinementContext() : undefined,
        refinementCacheScope: VOICE_INPUT_REFINEMENT_CACHE_SCOPE,
      })
      .catch((startError): StartVoiceInputResult => ({
        ok: false,
        error: startError instanceof Error ? startError.message : String(startError),
      }));

    const captureStart = await startVoiceInputCaptureSession({
      label: 'global',
      workletUrl,
      deviceId: settings.microphoneDeviceId ?? undefined,
      fastActivationEnabled: settings.fastActivationEnabled,
      getRunId: () => runIdRef.current,
      setEngine: (engine) => {
        engineRef.current = engine;
      },
      isCurrentEngine: (engine) => startAttemptIdRef.current === attemptId && engineRef.current === engine,
      canAcceptAudioChunk,
      appendAudioChunk,
      onInterrupted: (message) => {
        void failRecording(message);
      },
      onStateChange: (event, details) => {
        log.debug('global microphone engine', event, details);
      },
      getFallbackMessage: formatMicrophoneFallbackMessage,
      onFallback: setMicrophoneNotice,
      formatStartError: formatMicrophoneStartError,
      elapsedMs,
    });
    if (!captureStart.ok) {
      // 电源释放(锁屏/挂起)取消了启动:走与「启动尝试已失效」相同的静默清理,
      // 不把内部错误消息推到 UI —— 用户是主动离开,不是遇到故障。
      if (captureStart.cancelled) {
        log.debug('global microphone start cancelled by power release');
        resolveStartReadyState(attemptId, { ok: false, error: captureStart.error });
        startAttemptIdRef.current += 1;
        cancelStartedRun(startResultPromise);
        suppressedStartErrorAttemptsRef.current.delete(attemptId);
        await restoreSystemAudioForRecording();
        // setVoiceState('listening') already ran, and this path owns no engine
        // or run, so no later cancel/state event will arrive to clear it.
        // Leaving it would strand the overlay in 'listening' — where the
        // stateRef.current === 'listening' guard silently swallows every
        // subsequent shortcut press.
        await closeOverlayAndReset();
        return;
      }
      log.warn('global microphone start failed:', captureStart.error);
      resolveStartReadyState(attemptId, { ok: false, error: captureStart.error });
      startAttemptIdRef.current += 1;
      cancelStartedRun(startResultPromise);
      suppressedStartErrorAttemptsRef.current.delete(attemptId);
      await restoreSystemAudioForRecording();
      setError(captureStart.error);
      setVoiceState('error');
      scheduleErrorClose();
      return;
    }

    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: 'Voice input start was cancelled.' });
      cancelStartedRun(startResultPromise);
      await stopEngine();
      await restoreSystemAudioForRecording();
      return;
    }

    const result = await startResultPromise;
    if (!isActiveStartAttempt(attemptId)) {
      resolveStartReadyState(attemptId, { ok: false, error: result.ok ? 'Voice input start was cancelled.' : result.error });
      await stopEngine();
      await restoreSystemAudioForRecording();
      if (result.ok) {
        await window.electronAPI.voiceInput.cancel({ runId: result.runId });
      } else if (!suppressedStartErrorAttemptsRef.current.has(attemptId)) {
        await showStartFailure(result.error, result.authErrorReason);
      }
      suppressedStartErrorAttemptsRef.current.delete(attemptId);
      return;
    }
    if (!result.ok) {
      await showStartFailure(result.error, result.authErrorReason);
      resolveStartReadyState(attemptId, result);
      suppressedStartErrorAttemptsRef.current.delete(attemptId);
      return;
    }

    runIdRef.current = result.runId;
    ownedRunIdRef.current = result.runId;
    suppressedStartErrorAttemptsRef.current.delete(attemptId);
    captureStart.drainPendingChunks();
    resolveStartReadyState(attemptId, result);
  }, [
    appendAudioChunk,
    buildRefinementContext,
    canAcceptAudioChunk,
    cancelStartedRun,
    clearErrorCloseTimer,
    closeOverlay,
    closeOverlayAndReset,
    createStartReadyState,
    failRecording,
    formatMicrophoneFallbackMessage,
    formatMicrophoneStartError,
    showStartFailure,
    isActiveStartAttempt,
    muteSystemAudioForRecording,
    promptCodexSessionExpired,
    resetOverlayInteraction,
    resolveStartReadyState,
    restoreSystemAudioForRecording,
    scheduleErrorClose,
    setVoiceState,
    stopEngine,
    t,
  ]);

  const waitForDone = useCallback(() => {
    return new Promise<void>((resolve) => {
      doneWaitersRef.current.add(resolve);
      window.setTimeout(resolve, STOP_WAIT_TIMEOUT_MS);
    });
  }, []);

  const copyPendingText = useCallback(async () => {
    const text = (pendingPasteTextRef.current || finalTextRef.current || draftTextRef.current).trim();
    if (!text) {
      setVoiceState('done');
      await closeOverlayAndReset();
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (copyError) {
      log.warn('copy failed after global paste failure:', copyError instanceof Error ? copyError.message : String(copyError));
      return;
    }
    // Copying from the overlay can activate the Electron process on macOS.
    // Restore the originally captured target before hiding the overlay so the
    // user can immediately paste manually in the app they were dictating into.
    try {
      const restoreResult = await window.electronAPI.voiceInput.restoreGlobalPasteTargetFocus();
      if (!restoreResult.ok) {
        log.warn('restore global paste target focus after copy failed:', restoreResult.error);
      }
    } catch (restoreError) {
      log.warn(
        'restore global paste target focus after copy failed:',
        restoreError instanceof Error ? restoreError.message : String(restoreError),
      );
    }
    await closeOverlayAndReset();
  }, [closeOverlayAndReset]);

  const openAccessibilitySettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.voiceInput.openAccessibilitySettings();
      if (!result.ok) {
        log.warn('open accessibility settings failed:', result.error);
      }
    } catch (error) {
      log.warn('open accessibility settings failed:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const openMicrophonePermission = useCallback(async () => {
    try {
      const requestResult = await requestRendererMicrophonePermission();
      if (requestResult.ok) return;
      const settingsResult = await window.electronAPI.voiceInput.openMicrophoneSettings();
      if (!settingsResult.ok) {
        log.warn('open microphone settings failed:', settingsResult.error);
      }
    } catch (error) {
      log.warn('open microphone settings failed:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  const openPermissionPromptSettings = useCallback(() => {
    const prompt = permissionPrompt;
    if (!prompt) return;

    void closeOverlayAndReset().finally(() => {
      if (prompt === 'microphone') {
        void openMicrophonePermission();
        return;
      }
      void openAccessibilitySettings();
    });
  }, [closeOverlayAndReset, openAccessibilitySettings, openMicrophonePermission, permissionPrompt]);

  const showPasteFailure = useCallback(async (
    message: string,
    pasteAttemptId: number,
    errorCode?: string,
  ) => {
    if (pasteAttemptIdRef.current !== pasteAttemptId) return;
    resetOverlayInteraction();
    log.warn('global paste failed:', message);
    setError(null);
    setHasPasteError(true);
    setPasteErrorCode(normalizePasteErrorCode(errorCode));
    setVoiceState('done');
    closingRef.current = false;
    const showResult = await window.electronAPI.voiceInput.showGlobalOverlay();
    if (!showResult.ok) {
      log.warn('show global paste failure overlay failed:', showResult.error);
    }
  }, [resetOverlayInteraction, setVoiceState]);

  const pastePendingTextInBackground = useCallback((
    text: string,
    pasteAttemptId: number,
    hiddenPromise: Promise<unknown>,
    rawTranscriptText?: string,
  ) => {
    log.debug('global background paste started', {
      chars: text.length,
      rawTranscriptChars: rawTranscriptText?.length ?? 0,
      pasteAttemptId,
    });
    void window.electronAPI.voiceInput
      .pasteIntoFocusedTarget(text, rawTranscriptText)
      .then((pasteResult) => {
        if (pasteAttemptIdRef.current !== pasteAttemptId) return;
        if (pasteResult.ok) {
          log.debug('global background paste finished', { pasteAttemptId });
          void hiddenPromise.finally(resetHiddenOverlaySession);
          return;
        }
        void showPasteFailure(pasteResult.error, pasteAttemptId, pasteResult.errorCode);
      })
      .catch((pasteError) => {
        const message = pasteError instanceof Error ? pasteError.message : String(pasteError);
        void showPasteFailure(message, pasteAttemptId);
      });
  }, [resetHiddenOverlaySession, showPasteFailure]);

  const stopAndPaste = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;

    const settings = settingsRef.current;
    setVoiceState('submitting');
    await drainAndStopEngine();
    void restoreSystemAudioAndMaybePlayEndCue(settings.playInteractionSound);

    let runId = runIdRef.current;
    if (!runId && startReadyRef.current) {
      const startReady = startReadyRef.current;
      const startResult = await waitForStartReadyWhileStopping(startReady);
      if (cancelRequestedRef.current) return;
      if (!startResult.ok) {
        if (settingsRecoveryTabRef.current) {
          commitUsageStats();
          closingRef.current = false;
          return;
        }
        invalidateStartAttempt();
        setError(formatVoiceInputStartError(startResult.error));
        setVoiceState('error');
        commitUsageStats();
        closingRef.current = false;
        scheduleErrorClose();
        return;
      }
      runId = startResult.runId;
      // Pending chunks captured before start resolved are flushed by
      // startRecording() after runId is known; drain the IPC queue once more
      // before provider finalization so early-stop audio cannot be stranded.
      await drainAndStopEngine();
      await drainQueuedAudioToMain();
    }
    startAttemptIdRef.current += 1;
    runIdRef.current = null;
    if (!runId) {
      await window.electronAPI.voiceInput.cancel();
      commitUsageStats();
    } else {
      const donePromise = waitForDone();
      stopInFlightRef.current = true;
      setStopInFlight(true);
      let result: Awaited<ReturnType<typeof window.electronAPI.voiceInput.stop>>;
      try {
        result = await window.electronAPI.voiceInput.stop();
      } finally {
        stopInFlightRef.current = false;
        setStopInFlight(false);
      }
      if (cancelRequestedRef.current) return;
      if (!result.ok) {
        setError(result.error);
        setVoiceState('error');
        commitUsageStats();
        closingRef.current = false;
        return;
      }
      await donePromise;
      // A stop-time transcription failure resolves the shared done waiter
      // through the error event. Keep the overlay open so the error notice and
      // retry action remain visible instead of closing an empty draft.
      if (stateRef.current === 'error') {
        commitUsageStats();
        closingRef.current = false;
        return;
      }
    }

    // Critical bail point: if cancelAndClose ran while we were waiting on
    // stop()/donePromise (i.e. user pressed Esc/X during submitting or
    // refining), we must NOT proceed to paste. cancelAndClose has already
    // told the controller to discard the in-flight refine and closed the
    // overlay; running paste here would push stale partial text into the
    // user's target app after they explicitly asked to abandon.
    if (cancelRequestedRef.current) return;
    if (codexSessionPromptActiveRef.current) {
      stateRef.current = 'done';
      setVoiceState('done');
      closingRef.current = false;
      window.setTimeout(commitUsageStats, 0);
      return;
    }

    const text = (finalTextRef.current || draftTextRef.current).trim();
    if (!text) {
      stateRef.current = 'done';
      commitUsageStats();
      void closeOverlayAndReset();
      return;
    }
    pendingPasteTextRef.current = text;
    const pasteAttemptId = pasteAttemptIdRef.current + 1;
    pasteAttemptIdRef.current = pasteAttemptId;

    stateRef.current = 'done';
    const hiddenPromise = closeOverlay({ preservePasteTarget: true });
    pastePendingTextInBackground(text, pasteAttemptId, hiddenPromise, rawTranscriptTextRef.current || undefined);
    window.setTimeout(commitUsageStats, 0);
  }, [
    closeOverlay,
    closeOverlayAndReset,
    commitUsageStats,
    drainAndStopEngine,
    drainQueuedAudioToMain,
    formatVoiceInputStartError,
    invalidateStartAttempt,
    pastePendingTextInBackground,
    restoreSystemAudioAndMaybePlayEndCue,
    scheduleErrorClose,
    setVoiceState,
    waitForStartReadyWhileStopping,
    waitForDone,
  ]);

  // Overlay BrowserWindow is cached across hide/show (see main/voice-input/global.ts),
  // so React never remounts and `useRef(getVoiceInputSettings())` would freeze on the
  // first read. Subscribe to settings changes (same window CHANGE_EVENT + cross-window
  // storage event from the main settings UI), refresh the imperative ref, and
  // update derived tooltip text that is visible in the cached overlay.
  useEffect(() => {
    return subscribeVoiceInputSettings((next) => {
      settingsRef.current = next;
      setShortcutLabel(formatVoiceInputShortcut(next.shortcut));
      prewarmFastActivationIfEnabled(next);
    });
  }, [prewarmFastActivationIfEnabled]);

  useEffect(() => {
    return window.electronAPI.voiceInput.onDictionaryLearningEvidence((payload) => {
      void adviseAndRecordVoiceInputDictionaryLearning({
        ...payload.evidence,
        context: {
          ...payload.evidence.context,
          uiLanguage: navigator.language,
          sourceLanguage: resolveBrowserVoiceInputLanguage(settingsRef.current.language),
        },
      });
      log.debug('global voice input dictionary learning evidence recorded', {
        beforeChars: payload.evidence.beforeText.length,
        afterChars: payload.evidence.afterText.length,
      });
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.voiceInput.onEvent((event) => {
      if (!shouldHandleVoiceInputEvent(
        ownedRunIdRef.current,
        event.runId,
        isVoiceInputEventScopeActive(stateRef.current),
      )) return;
      switch (event.type) {
        case 'auth-required':
          codexSessionPromptActiveRef.current = promptCodexSessionExpired(event.reason);
          break;
        case 'state':
          if (event.outcome) terminalOutcomeRef.current = event.outcome;
          if (closingRef.current && event.state === 'done') {
            // Once the user has confirmed global dictation, the overlay is only
            // waiting for ASR/refine to settle so it can paste. Rendering the
            // final "done" frame creates a visible flash and delays the paste
            // handoff without adding useful information.
            stateRef.current = event.state;
            resolveDoneWaiters();
            runIdRef.current = null;
            ownedRunIdRef.current = null;
            break;
          }
          setVoiceState(event.state);
          if (event.state === 'done' || event.state === 'error') {
            resolveDoneWaiters();
            if (event.state === 'done') {
              runIdRef.current = null;
              ownedRunIdRef.current = null;
            }
          }
          break;
        case 'draft':
          draftTextRef.current = event.text;
          setDraftText(event.text);
          break;
        case 'submitted':
          finalTextRef.current = event.text;
          rawTranscriptTextRef.current = event.text;
          setRefinementPreviewText('');
          // closingRef only prevents duplicate submit/paste. The overlay remains
          // visible while ASR/refine finishes, so keep its transcript display live
          // until closeOverlay actually hides it.
          setFinalText(event.text);
          historyEntryIdRef.current = recordVoiceInputHistory(event.text);
          break;
        case 'refinement-preview':
          // Refinement streams AFTER stop() nulls runIdRef, so the preview must
          // not require a live runIdRef — that strict guard dropped every
          // preview frame. The top-level guard above already filters stale runs
          // (it only returns when runIdRef is set AND mismatched).
          setRefinementPreviewText(event.text);
          break;
        case 'refined':
          finalTextRef.current = event.text;
          rawTranscriptTextRef.current = event.segment.basedOnText ?? rawTranscriptTextRef.current;
          setRefinementPreviewText('');
          if (!closingRef.current) {
            setFinalText(event.text);
          } else {
            // In the confirmed global overlay path, `refined` is already the
            // final text used for paste. Do not wait for React to render it or
            // for the following `done` state frame; start the paste handoff as
            // soon as the model's final result arrives.
            resolveDoneWaiters();
          }
          if (historyEntryIdRef.current) {
            const historyEntryId = historyEntryIdRef.current;
            window.setTimeout(() => updateVoiceInputHistoryEntry(historyEntryId, event.text), 0);
          }
          break;
        case 'error': {
          log.warn('global voice input error:', event.message);
          terminalOutcomeRef.current = 'failed';
          const formattedMessage = formatVoiceInputError(event.message, event.code);
          if (promptCodexSessionExpired(formattedMessage)) {
            codexSessionPromptActiveRef.current = true;
          }
          // Preserve already-recognized text for the user to copy. The
          // overlay's existing "paste failed" UI does exactly this — render
          // the captured draft + a copy button — so reuse that path. The
          // distinction from a real paste failure (no text was ever delivered
          // to the target app vs. paste was rejected by the target) is not
          // worth a separate UI surface; what matters is the user does not
          // lose the transcription they just produced.
          const recognizedText = (finalTextRef.current || draftTextRef.current).trim();
          if (closingRef.current && recognizedText) {
            // Stop-time provider errors can arrive after ASR has produced a
            // stable transcript while refinement is still running. Treating
            // that late error as completion makes the global overlay paste raw
            // ASR text before the refined result arrives. Keep waiting for
            // done/refined here; waitForDone still has its timeout fallback.
            break;
          }
          setError(formatVoiceInputStartError(formattedMessage));
          if (recognizedText) {
            pendingPasteTextRef.current = recognizedText;
            setPasteErrorCode('failed');
            setHasPasteError(true);
          }
          setVoiceState('error');
          runIdRef.current = null;
          ownedRunIdRef.current = null;
          resolveDoneWaiters();
          break;
        }
        case 'usage':
          if (closingRef.current) {
            window.setTimeout(() => recordVoiceInputRefinementUsage(event.refinement), 0);
          } else {
            recordVoiceInputRefinementUsage(event.refinement);
          }
          break;
        case 'timeline':
          if (
            event.event.type === 'refine_rejected' &&
            isCodexSessionExpiredError(event.event.reason)
          ) {
            codexSessionPromptActiveRef.current = promptCodexSessionExpired(event.event.reason);
          }
          break;
      }
    });
  }, [formatVoiceInputError, formatVoiceInputStartError, promptCodexSessionExpired, resolveDoneWaiters, setVoiceState]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.voiceInput.onGlobalOverlayCommand((command: GlobalOverlayCommand) => {
      if (command.type === 'start') {
        void startRecording();
        return;
      }
      if (command.type === 'submit') {
        if (stateRef.current === 'error') {
          if (stopInFlightRef.current) return;
          void startRecording();
          return;
        }
        void stopAndPaste();
        return;
      }
      if (command.type === 'cancel') {
        void cancelAndClose();
      }
    });
    window.electronAPI.voiceInput.notifyGlobalOverlayReady();
    return unsubscribe;
  }, [cancelAndClose, startRecording, stopAndPaste]);

  // Mount-time prewarm. The overlay is now pre-created at app idle (see
  // prewarmGlobalVoiceInputOverlay in main/voice-input/global.ts) so this
  // effect runs well before the user's first shortcut press, populating the
  // shared AudioContext + worklet module and warming provider auth.
  useEffect(() => {
    void window.electronAPI.voiceInput.prewarm({
      sourceLanguage: settingsRef.current.language,
      refinementEnabled: settingsRef.current.refinementEnabled,
    }).catch(() => undefined);
    void prewarmVoiceInputAudio(workletUrl).catch(() => undefined);
    prewarmFastActivationIfEnabled(settingsRef.current);
    if (import.meta.env.DEV) void prewarmVoiceInputBenchmarkFixture().catch(() => undefined);
  }, [prewarmFastActivationIfEnabled]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      void cancelAndClose();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [cancelAndClose]);

  useEffect(() => {
    return () => {
      if (closingRef.current) return;
      startAttemptIdRef.current += 1;
      resolveDoneWaiters();
      commitUsageStats();
      void stopEngine();
      void restoreSystemAudioForRecording();
      void window.electronAPI.voiceInput.cancel(runIdRef.current ? { runId: runIdRef.current } : undefined);
    };
  }, [commitUsageStats, resolveDoneWaiters, restoreSystemAudioForRecording, stopEngine]);

  // 卡片任意非交互区域可拖动浮窗、双击复位到默认位置。手势细节与
  // main 侧几何规则见 useVoiceInputOverlayDrag / main/voice-input/overlayPlacement.ts。
  const dragHandlers = useVoiceInputOverlayDrag();

  const hasPermissionPrompt = Boolean(permissionPrompt);
  const hasSettingsRecovery = Boolean(settingsRecoveryTab);
  const hasBlockingError = Boolean(error) && !hasPasteError && !hasPermissionPrompt;
  const displayText = hasPasteError
    ? pendingPasteTextRef.current || finalText || draftText
    : hasPermissionPrompt
      ? error ?? ''
    : finalText || draftText;
  const displayContent: ReactNode = refinementPreviewText && !hasPasteError && !hasPermissionPrompt
    ? buildRefinementPreviewText(rawTranscriptTextRef.current, refinementPreviewText)
    : displayText;
  const showTranscriptPointerHint = Boolean(displayText) && !hasBlockingError && !hasPasteError && !hasPermissionPrompt;

  // Stick the transcript scroll to the bottom whenever the visible text
  // changes. With multi-recover sessions producing > 88px of accumulated
  // text, the natural rendering order would push the newest partial off the
  // bottom edge of the fixed-height card; the user wants to see what they
  // just said, not the start of the dictation. Manual scroll-up still works
  // because the container is overflow-y-auto.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [displayText, refinementPreviewText, hasBlockingError, error]);
  const submitTooltip = shortcutLabel
    ? t('voiceInputOverlay.submitWithShortcut', { shortcut: shortcutLabel })
    : t('voiceInputOverlay.submit');
  const closeTooltip = t('voiceInputOverlay.closeWithShortcut', { shortcut: 'Esc' });
  const statusLabel = useMemo(() => {
    if (hasPermissionPrompt) return t('voiceInputOverlay.status.permissionRequired');
    if (hasPasteError) return t('voiceInputOverlay.status.inputFailed');
    if (hasBlockingError) return t('voiceInputOverlay.status.error');
    if (state === 'refining') return t('voiceInputOverlay.status.refining');
    if (state === 'submitting') return t('voiceInputOverlay.status.submitting');
    return t('voiceInputOverlay.status.listening');
  }, [hasBlockingError, hasPasteError, hasPermissionPrompt, state, t]);
  const pasteFailureHint = t(getPasteErrorHintKey(pasteErrorCode));
  const permissionPromptHint = permissionPrompt
    ? t(`voiceInputOverlay.permissionPrompts.${permissionPrompt}.hint`)
    : '';
  const transcriptClassName = hasPasteError || hasPermissionPrompt || hasSettingsRecovery
    ? 'min-h-[44px] max-h-[72px] cursor-default overflow-y-auto whitespace-pre-wrap break-words text-15 leading-6 text-[var(--cmd-palette-item-text)]'
    : 'h-[88px] cursor-default overflow-y-auto whitespace-pre-wrap break-words text-15 leading-6 text-[var(--cmd-palette-item-text)]';
  const showLiveMicWave = state === 'listening' && !hasBlockingError && !hasPasteError && !hasPermissionPrompt;

  return (
    <div
      // select-none on the whole overlay: this is a transient HUD, not a
      // document. Letting the user lasso-select the status label or the live
      // partial text gives no useful affordance (the Copy button covers the
      // only legitimate need to grab the transcript) and just creates visual
      // noise + ugly drag-selection rectangles when the user clicks anywhere
      // on the card.
      className="flex h-screen w-screen select-none items-start justify-center bg-transparent p-[52px] text-13 text-[var(--cmd-palette-item-text)]"
      onPointerMove={actionTipsDisabled ? enableActionTips : undefined}
    >
      <div
        className="w-full rounded-[14px] border border-[var(--cmd-palette-border)] px-4 py-3 shadow-[var(--shadow-menu)] backdrop-blur"
        style={{ backgroundColor: 'color-mix(in srgb, var(--cmd-palette-bg) 95%, transparent)' }}
        {...dragHandlers}
      >
        <div className="mb-2 flex items-center gap-2 text-[var(--cmd-palette-item-meta)]">
          {hasBlockingError ? (
            <VoiceInputStatusErrorIcon />
          ) : state === 'refining' || state === 'submitting' ? (
            <Spinner size={16} className="text-[var(--cmd-palette-item-text)]" />
          ) : (
            // Same mic icon as the in-app voice caret. The cached overlay can
            // sit hidden for hours, so only live listening runs the level bars.
            <VoiceInputMicWaveIcon
              active={showLiveMicWave}
              className="inline-flex h-4 w-4 text-[var(--cmd-palette-item-text)]"
            />
          )}
          <span className="font-medium text-[var(--cmd-palette-item-text)]">{statusLabel}</span>
          <div className="ml-auto flex items-center gap-1">
            {!hasBlockingError && !hasPasteError && !hasPermissionPrompt && (
              <Tip text={submitTooltip} side="bottom" delay={150} disabled={actionTipsDisabled}>
                <button
                  type="button"
                  aria-label={submitTooltip}
                  tabIndex={-1}
                  className="rounded-full p-1.5 text-[var(--cmd-palette-item-meta)] transition hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--cmd-palette-item-text)] active:scale-95 disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[var(--cmd-palette-item-meta)]"
                  disabled={state === 'submitting' || state === 'refining'}
                  onFocus={preventOverlayButtonFocus}
                  onPointerDown={(event) => {
                    beginOverlayButtonAction(event);
                    void stopAndPaste();
                  }}
                  onClick={suppressOverlayButtonClick}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </Tip>
            )}
            {!hasPermissionPrompt && (
              <Tip text={closeTooltip} side="bottom" delay={150} disabled={actionTipsDisabled}>
                <button
                  type="button"
                  aria-label={closeTooltip}
                  tabIndex={-1}
                  className="rounded-full p-1.5 text-[var(--cmd-palette-item-meta)] transition hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--cmd-palette-item-text)] active:scale-95"
                  onFocus={preventOverlayButtonFocus}
                  onPointerDown={(event) => {
                    beginOverlayButtonAction(event);
                    void cancelAndClose();
                  }}
                  onClick={suppressOverlayButtonClick}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tip>
            )}
          </div>
        </div>
        <VoiceInputPointerHintLayer
          ref={transcriptScrollRef}
          active={showTranscriptPointerHint}
          state={state}
          className={transcriptClassName}
        >
          {hasBlockingError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <VoiceInputStatusNotice
                message={error!}
                className="w-full justify-start rounded-[12px] shadow-none"
                maxWidthClassName="max-w-none"
              />
              <button
                type="button"
                tabIndex={-1}
                className="inline-flex h-9 shrink-0 items-center rounded-full border border-[var(--cmd-palette-border)] bg-[var(--send-btn-bg)] px-3 text-12 font-medium text-[var(--send-btn-icon)] transition hover:opacity-85 active:scale-[0.98]"
                onFocus={preventOverlayButtonFocus}
                onPointerDown={(event) => {
                  beginOverlayButtonAction(event);
                  void startRecording();
                }}
                onClick={suppressOverlayButtonClick}
                disabled={stopInFlight}
              >
                {t('voiceInputOverlay.retry')}
              </button>
            </div>
          ) : displayText ? (
            displayContent
          ) : (
            <span className="text-[var(--cmd-palette-item-meta)]">{t('voiceInputOverlay.placeholder')}</span>
          )}
        </VoiceInputPointerHintLayer>
        {microphoneNotice && !hasBlockingError && !hasPasteError && !hasPermissionPrompt && (
          <div className="mt-2 text-12 leading-5 text-[var(--cmd-palette-item-meta)]">
            {microphoneNotice}
          </div>
        )}
        {hasPermissionPrompt && !hasPasteError && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="min-w-0 text-12 leading-5 text-[var(--cmd-palette-item-meta)]">
              {permissionPromptHint}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                tabIndex={-1}
                className="inline-flex h-9 shrink-0 items-center rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] px-3 text-12 font-medium text-[var(--cmd-palette-item-text)] shadow-sm transition hover:bg-[var(--cmd-palette-item-hover)] active:scale-[0.98]"
                onFocus={preventOverlayButtonFocus}
                onPointerDown={(event) => {
                  beginOverlayButtonAction(event);
                  void cancelAndClose();
                }}
                onClick={suppressOverlayButtonClick}
              >
                {t('commonUi.confirmDialog.cancel')}
              </button>
              <button
                type="button"
                tabIndex={-1}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--cmd-palette-border)] bg-[var(--send-btn-bg)] px-3 text-12 font-medium text-[var(--send-btn-icon)] shadow-sm transition hover:opacity-85 active:scale-[0.98]"
                onFocus={preventOverlayButtonFocus}
                onPointerDown={(event) => {
                  beginOverlayButtonAction(event);
                  openPermissionPromptSettings();
                }}
                onClick={suppressOverlayButtonClick}
              >
                <Settings className="h-3.5 w-3.5" />
                {t('voiceInputOverlay.openPermissionSettings')}
              </button>
            </div>
          </div>
        )}
        {hasSettingsRecovery && hasBlockingError && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="min-w-0 text-12 leading-5 text-[var(--cmd-palette-item-meta)]">
              {t('voiceInputOverlay.settingsRecoveryHint')}
            </span>
            <button
              type="button"
              tabIndex={-1}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--cmd-palette-border)] bg-[var(--send-btn-bg)] px-3 text-12 font-medium text-[var(--send-btn-icon)] shadow-sm transition hover:opacity-85 active:scale-[0.98]"
              onFocus={preventOverlayButtonFocus}
              onPointerDown={(event) => {
                beginOverlayButtonAction(event);
                void openReadinessSettings();
              }}
              onClick={suppressOverlayButtonClick}
            >
              <Settings className="h-3.5 w-3.5" />
              {t('voiceInputOverlay.openSettings')}
            </button>
          </div>
        )}
        {hasPasteError && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="min-w-0 text-12 leading-5 text-[var(--cmd-palette-item-meta)]">
              {pasteFailureHint}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {pasteErrorCode === 'permission' && (
                <button
                  type="button"
                  tabIndex={-1}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--cmd-palette-border)] bg-[var(--send-btn-bg)] px-3 text-12 font-medium text-[var(--send-btn-icon)] shadow-sm transition hover:opacity-85 active:scale-[0.98]"
                  onFocus={preventOverlayButtonFocus}
                  onPointerDown={(event) => {
                    beginOverlayButtonAction(event);
                    void openAccessibilitySettings();
                  }}
                  onClick={suppressOverlayButtonClick}
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('voiceInputOverlay.openPermissionSettings')}
                </button>
              )}
              <button
                type="button"
                tabIndex={-1}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] px-3 text-12 font-medium text-[var(--cmd-palette-item-text)] shadow-sm transition hover:bg-[var(--cmd-palette-item-hover)] active:scale-[0.98]"
                onFocus={preventOverlayButtonFocus}
                onPointerDown={(event) => {
                  beginOverlayButtonAction(event);
                  void copyPendingText();
                }}
                onClick={suppressOverlayButtonClick}
              >
                <Copy className="h-3.5 w-3.5" />
                {t('voiceInputOverlay.copy')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function supportsSystemAudioMute(): boolean {
  return window.electronAPI.platform === 'darwin' || window.electronAPI.platform === 'win32';
}
