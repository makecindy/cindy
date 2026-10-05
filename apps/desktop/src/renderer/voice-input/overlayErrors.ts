import type { VoiceInputErrorCode } from '@cindy/voice-input-core';
import { VOICE_INPUT_RATE_LIMITED_MESSAGE } from '../../shared/voiceInputErrors';

/**
 * i18n keys for the failures the voice controller classifies itself. Their
 * `message` is an English debug string, so the user-facing sentence must come
 * from the code. Uncoded failures originate in a provider (auth, quota,
 * protocol) and keep their own message — it is the only description we have.
 */
export const VOICE_INPUT_ERROR_CODE_KEYS: Record<VoiceInputErrorCode, string> = {
  empty_transcript: 'voiceInputOverlay.emptyTranscript',
  connection_interrupted: 'voiceInputOverlay.connectionInterrupted',
  recognition_stalled: 'voiceInputOverlay.recognitionStalled',
};

const VOICE_INPUT_SERVICE_CONNECTION_ERROR_PATTERN =
  /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|TLS)\b|getaddrinfo|network|websocket|timed out|fetch failed|certificate|self[- ]signed/i;

export function isVoiceInputServiceConnectionError(message: string): boolean {
  return VOICE_INPUT_SERVICE_CONNECTION_ERROR_PATTERN.test(message);
}

/** Resolve known messages at display time using this renderer's current locale. */
export function getVoiceInputErrorMessageKey(message: string): string | undefined {
  if (message === VOICE_INPUT_RATE_LIMITED_MESSAGE) return 'voiceInputOverlay.rateLimited';
  if (isVoiceInputServiceConnectionError(message)) return 'voiceInputOverlay.asrServiceUnavailable';
  return undefined;
}
