const VOICE_INPUT_SERVICE_CONNECTION_ERROR_PATTERN =
  /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|TLS)\b|getaddrinfo|network|websocket|timed out|fetch failed|certificate|self[- ]signed/i;

export function isVoiceInputServiceConnectionError(message: string): boolean {
  return VOICE_INPUT_SERVICE_CONNECTION_ERROR_PATTERN.test(message);
}
