import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FAILED_VOICE_AUDIO_TTL_MS,
  isRetainedFailedVoiceAudioExpired,
  type RetainedFailedVoiceAudio,
} from '@cindy/voice-input-core';

/**
 * Holds at most one failed voice recording in bounded memory for one-click
 * re-recognition, with automatic cleanup on TTL expiry, scope switch,
 * replacement, or unmount.
 */
export function useMobileFailedVoiceRetry(scopeKey?: string) {
  const retainedRef = useRef<RetainedFailedVoiceAudio | null>(null);
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const clear = useCallback(() => {
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    retainedRef.current = null;
    setCanRetry(false);
  }, []);

  const retain = useCallback((audio: RetainedFailedVoiceAudio) => {
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    retainedRef.current = audio;
    setCanRetry(true);
    const delayMs = Math.max(1_000, Math.min(FAILED_VOICE_AUDIO_TTL_MS, audio.expiresAt - Date.now()));
    expireTimerRef.current = setTimeout(() => {
      expireTimerRef.current = null;
      retainedRef.current = null;
      setCanRetry(false);
    }, delayMs);
  }, []);

  const peek = useCallback((): RetainedFailedVoiceAudio | null => {
    const current = retainedRef.current;
    if (!current || isRetainedFailedVoiceAudioExpired(current)) {
      clear();
      return null;
    }
    return current;
  }, [clear]);

  useEffect(() => {
    clear();
  }, [clear, scopeKey]);

  useEffect(() => clear, [clear]);

  return { canRetry, retain, peek, clear };
}
