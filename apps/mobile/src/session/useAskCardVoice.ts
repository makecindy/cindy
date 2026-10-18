/**
 * Voice input for the mobile question card's free-text answer.
 *
 * The composer owns the full press-and-hold path. This hook starts the same
 * dictation session against the answer string, and only loads the native audio
 * modules when the user actually taps the microphone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAskCardAuth } from '@/session/askCardAuth';
import type { MobileVoiceSelection } from '@/session/mobileVoiceInput';

type VoiceRun = {
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

export function useAskCardVoice(input: {
  deviceId?: string;
  getText: () => string;
  setText: (value: string) => void;
  getSelection: () => MobileVoiceSelection;
}): {
  listening: boolean;
  error: string | null;
  toggle: () => void;
} {
  const auth = useAskCardAuth();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<VoiceRun | null>(null);
  const startingRef = useRef(false);
  const startAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const authRef = useRef(auth);
  authRef.current = auth;

  const stop = useCallback(() => {
    startingRef.current = false;
    // Abort the startup so the microphone closes now instead of waiting for a
    // slow voice-service handshake to finish.
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    const run = runRef.current;
    runRef.current = null;
    setListening(false);
    if (!run) return;
    void run.stop().catch(() => undefined);
  }, []);

  // The card unmounts when the answer is submitted, skipped or the request
  // disappears — the recording must not outlive it.
  useEffect(() => () => {
    startingRef.current = false;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    const run = runRef.current;
    runRef.current = null;
    void run?.cancel().catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    if (runRef.current || startingRef.current) {
      stop();
      return;
    }
    const deviceId = inputRef.current.deviceId?.trim();
    const currentAuth = authRef.current;
    if (!deviceId || !currentAuth) {
      setError('语音输入需要先登录手机端。');
      return;
    }
    startingRef.current = true;
    setError(null);
    const abort = new AbortController();
    startAbortRef.current = abort;
    void (async () => {
      try {
        const { startAskCardDictation } = await import('@/session/askCardVoiceStart');
        if (!startingRef.current) return;
        const run = await startAskCardDictation({
          deviceId,
          signal: abort.signal,
          getAccessToken: () => currentAuth.getAccessToken(),
          refreshAccessToken: () => currentAuth.refreshAccessToken(),
          apiFetch: currentAuth.apiFetch,
          getText: () => inputRef.current.getText(),
          setText: (value) => inputRef.current.setText(value),
          getSelection: () => inputRef.current.getSelection(),
          onListening: () => {
            if (startingRef.current || runRef.current) setListening(true);
          },
          onError: (message) => {
            startingRef.current = false;
            runRef.current = null;
            setListening(false);
            setError(message);
          },
        });
        if (!startingRef.current) {
          await run.cancel();
          return;
        }
        runRef.current = run;
        startingRef.current = false;
        setListening(true);
      } catch (error) {
        startingRef.current = false;
        setListening(false);
        // Stopping during startup is a normal outcome, not a failure.
        if (!(error instanceof Error && error.name === 'AskCardVoiceCancelledError')) {
          setError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (startAbortRef.current === abort) startAbortRef.current = null;
      }
    })();
  }, [stop]);

  return { listening, error, toggle };
}
