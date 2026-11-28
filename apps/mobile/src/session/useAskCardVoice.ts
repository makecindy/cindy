/**
 * Voice input for the mobile question card's free-text answer.
 *
 * The composer owns the full press-and-hold path. This hook starts the same
 * dictation session against the answer string, and only loads the native audio
 * modules when the user actually taps the microphone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18n } from '@/i18n';
import { playHaptic } from '@/platform/haptics';
import { useAskCardAuth } from '@/session/askCardAuth';
import { useMobileFailedVoiceRetry } from '@/session/useMobileFailedVoiceRetry';
import { useSpeakerFilterNotice } from '@/session/useSpeakerFilterNotice';
import type { MobileVoiceSelection } from '@/session/mobileVoiceInput';

type VoiceRun = {
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

export function useAskCardVoice(input: {
  deviceId?: string;
  getText: () => string;
  setText: (value: string, selection?: MobileVoiceSelection) => void;
  getSelection: () => MobileVoiceSelection;
}): {
  listening: boolean;
  starting: boolean;
  busy: boolean;
  stopping: boolean;
  error: string | null;
  /** The voiceprint filter just muted someone else's speech. */
  speakerFiltered: boolean;
  canRetry: boolean;
  toggle: () => void;
  stop: () => Promise<boolean>;
  retry: () => void;
} {
  const auth = useAskCardAuth();
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedRetry = useMobileFailedVoiceRetry(input.deviceId);
  const {
    visible: speakerFiltered,
    show: showSpeakerFiltered,
    clear: clearSpeakerFiltered,
  } = useSpeakerFilterNotice();
  const runRef = useRef<VoiceRun | null>(null);
  const startingRef = useRef(false);
  const retryingRef = useRef(false);
  const runReadyRef = useRef<{ promise: Promise<VoiceRun | null>; resolve: (run: VoiceRun | null) => void } | null>(null);
  const stoppingRef = useRef<Promise<boolean> | null>(null);
  const failedRef = useRef(false);
  const mountedRef = useRef(true);
  const startAbortRef = useRef<AbortController | null>(null);
  const replayAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const authRef = useRef(auth);
  authRef.current = auth;

  const stop = useCallback(() => {
    if (stoppingRef.current) return stoppingRef.current;
    const abort = startAbortRef.current;
    const ready = runReadyRef.current;
    setStopping(true);
    const finishing = (async () => {
      // The handle is published after module/permission/speaker-filter setup,
      // before the service handshake. A submit during setup must not be lost.
      const run = runRef.current ?? await ready?.promise;
      if (!run || abort?.signal.aborted) return false;
      await run.stop();
      return !failedRef.current && !abort?.signal.aborted;
    })().catch((error: unknown) => {
      if (mountedRef.current) setError(error instanceof Error ? error.message : String(error));
      return false;
    }).finally(() => {
      if (stoppingRef.current === finishing) stoppingRef.current = null;
      runRef.current = null;
      startingRef.current = false;
      abort?.abort();
      if (mountedRef.current) {
        setStarting(false);
        setListening(false);
        setStopping(false);
      }
    });
    stoppingRef.current = finishing;
    return finishing;
  }, []);

  // The card unmounts when the answer is submitted, skipped or the request
  // disappears — the recording must not outlive it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startingRef.current = false;
      startAbortRef.current?.abort();
      replayAbortRef.current?.abort();
      replayAbortRef.current = null;
      runReadyRef.current?.resolve(null);
      startAbortRef.current = null;
      const run = runRef.current;
      runRef.current = null;
      void run?.cancel().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    return () => {
      replayAbortRef.current?.abort();
      replayAbortRef.current = null;
    };
  }, [input.deviceId]);

  const toggle = useCallback(() => {
    // A session that is still closing must finish first; starting a new one
    // now would race the microphone teardown.
    if (stoppingRef.current || retryingRef.current) return;
    if (startingRef.current && !runRef.current) {
      // A second mic tap cancels setup; submit calls stop() directly and waits.
      startAbortRef.current?.abort();
      runReadyRef.current?.resolve(null);
      startingRef.current = false;
      setStarting(false);
      return;
    }
    if (runRef.current) {
      void stop();
      return;
    }
    const deviceId = inputRef.current.deviceId?.trim();
    const currentAuth = authRef.current;
    if (!deviceId || !currentAuth) {
      setError(i18n.t('composer.voice.loginRequired'));
      return;
    }
    failedRetry.clear();
    startingRef.current = true;
    failedRef.current = false;
    setStarting(true);
    setError(null);
    clearSpeakerFiltered();
    let resolveRun!: (run: VoiceRun | null) => void;
    const ready = { promise: new Promise<VoiceRun | null>((resolve) => { resolveRun = resolve; }), resolve: (run: VoiceRun | null) => resolveRun(run) };
    runReadyRef.current = ready;
    const abort = new AbortController();
    startAbortRef.current = abort;
    // Opening permissions/dismissing the keyboard can move native selection.
    // Dictation belongs to the caret the user had when they pressed the mic.
    const selection = { ...inputRef.current.getSelection() };
    void (async () => {
      try {
        const { startAskCardDictation } = await import('@/session/askCardVoiceStart');
        if (abort.signal.aborted) return;
        const run = await startAskCardDictation({
          deviceId,
          signal: abort.signal,
          getAccessToken: () => currentAuth.getAccessToken(),
          refreshAccessToken: () => currentAuth.refreshAccessToken(),
          apiFetch: currentAuth.apiFetch,
          getText: () => inputRef.current.getText(),
          setText: (value, nextSelection) => { if (!abort.signal.aborted) inputRef.current.setText(value, nextSelection); },
          getSelection: () => selection,
          onListening: () => {
            if (abort.signal.aborted) return;
            startingRef.current = false;
            setStarting(false);
            if (!stoppingRef.current) {
              setListening(true);
              playHaptic('commit');
            }
          },
          onRunCreated: (run) => {
            if (abort.signal.aborted) { void run.cancel().catch(() => undefined); return; }
            runRef.current = run;
            ready.resolve(run);
          },
          onSpeakerFiltered: () => {
            if (!abort.signal.aborted) showSpeakerFiltered();
          },
          onRetainedFailedAudio: (audio) => {
            if (!mountedRef.current || abort.signal.aborted) return;
            failedRetry.retain(audio);
          },
          onError: (message) => {
            if (abort.signal.aborted) return;
            failedRef.current = true;
            ready.resolve(null);
            setStarting(false);
            startingRef.current = false;
            setError(message);
            if (!stoppingRef.current) {
              const failedRun = runRef.current;
              runRef.current = null;
              abort.abort();
              setListening(false);
              void failedRun?.cancel().catch(() => undefined);
            }
          },
        });
        if (abort.signal.aborted) {
          await run.cancel();
          return;
        }
        runRef.current = run;
        ready.resolve(run);
      } catch (error) {
        ready.resolve(null);
        if (abort.signal.aborted) return;
        setStarting(false);
        startingRef.current = false;
        runRef.current = null;
        setListening(false);
        // Stopping during startup is a normal outcome, not a failure.
        if (!(error instanceof Error && error.name === 'AskCardVoiceCancelledError')) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }, [clearSpeakerFiltered, failedRetry, showSpeakerFiltered, stop]);

  const retry = useCallback(() => {
    if (stoppingRef.current || startingRef.current || runRef.current || retryingRef.current) return;
    const retained = failedRetry.peek();
    if (!retained) return;
    const deviceId = inputRef.current.deviceId?.trim();
    const currentAuth = authRef.current;
    if (!deviceId || !currentAuth) {
      setError(i18n.t('composer.voice.loginRequired'));
      return;
    }
    retryingRef.current = true;
    const replayAbort = new AbortController();
    replayAbortRef.current = replayAbort;
    setRetrying(true);
    setError(null);
    clearSpeakerFiltered();
    const selection = { ...inputRef.current.getSelection() };
    void (async () => {
      try {
        const { replayAskCardDictation } = await import('@/session/askCardVoiceStart');
        await replayAskCardDictation({
          deviceId,
          audio: retained,
          signal: replayAbort.signal,
          getAccessToken: () => currentAuth.getAccessToken(),
          refreshAccessToken: () => currentAuth.refreshAccessToken(),
          apiFetch: currentAuth.apiFetch,
          getText: () => inputRef.current.getText(),
          setText: (value, nextSelection) => { if (mountedRef.current && !replayAbort.signal.aborted) inputRef.current.setText(value, nextSelection); },
          getSelection: () => selection,
          onError: (message) => {
            if (mountedRef.current && !replayAbort.signal.aborted) setError(message);
          },
        });
        if (mountedRef.current && !replayAbort.signal.aborted) {
          failedRetry.clear();
          setError(null);
        }
      } catch (err) {
        if (mountedRef.current && !replayAbort.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (replayAbortRef.current === replayAbort) replayAbortRef.current = null;
        retryingRef.current = false;
        if (mountedRef.current) setRetrying(false);
      }
    })();
  }, [clearSpeakerFiltered, failedRetry]);

  return {
    listening,
    starting,
    stopping: stopping || retrying,
    busy: starting || listening || stopping || retrying,
    error,
    speakerFiltered,
    canRetry: failedRetry.canRetry && !retrying,
    toggle,
    stop,
    retry,
  };
}
