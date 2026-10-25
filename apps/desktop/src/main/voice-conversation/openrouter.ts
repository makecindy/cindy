/** Only the documented OpenRouter API bases own this TTS contract. Chat keeps
 * its original /api (Messages) or /api/v1 (OpenAI) route; custom prefixes stay untouched.
 * https://openrouter.ai/docs/guides/overview/multimodal/tts
 */
export function openRouterSpeechBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin === 'https://openrouter.ai' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/api', '/api/v1'].includes(url.pathname.replace(/\/+$/, ''))
    )
      return `${url.origin}/api/v1`;
  } catch {
    /* Not an official API base. */
  }
  return undefined;
}
