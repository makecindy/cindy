/** Public request languages. SDK/platform adapter IDs are implementation details. */
export type CompatibilityProtocol = 'openai-responses' | 'openai-chat' | 'anthropic' | 'google';
export type CompatibilityHarness = 'codex' | 'claude-code' | 'pi';

export function compatibilityProtocol(api: string | null | undefined): CompatibilityProtocol | null {
  switch (api) {
    case 'openai-responses': case 'azure-openai-responses': return 'openai-responses';
    case 'openai-chat': case 'openai-completions': return 'openai-chat';
    case 'anthropic': case 'anthropic-messages': return 'anthropic';
    case 'google': case 'google-generative-ai': case 'google-vertex': return 'google';
    // Converse and Conversations are distinct SDK transports, not aliases of these APIs.
    default: return null;
  }
}

/** Only choose among routes the caller has verified for this account and model. */
export function selectCompatibilityRoute<T extends { protocol: CompatibilityProtocol | null }>(
  harness: CompatibilityHarness, available: readonly T[],
): T | undefined {
  const native = harness === 'codex' ? 'openai-responses' : harness === 'claude-code' ? 'anthropic' : null;
  return (native ? available.find(route => route.protocol === native) : undefined) ?? available[0];
}
