/** The existing Google AI Studio preset uses the OpenAI-compatible chat endpoint. */
export const GEMINI_API_PRESET_ID = 'google-gemini-api';
export const GEMINI_CHAT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';

export function isGeminiChatEndpoint(url: string | undefined): boolean {
  return url?.replace(/\/+$/, '') === GEMINI_CHAT_ENDPOINT;
}

/** A fresh identity prevents a later, same-name chat connection inheriting image billing. */
export function newGeminiConnectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'gemini-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
