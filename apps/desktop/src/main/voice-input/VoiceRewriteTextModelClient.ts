import type { TextModelClient } from '@cindy/voice-input-core';

import type { UtilityTextResult } from '../../shared/utilityTextResult.js';
import type { UtilityTextRequestOptions } from '../utility-model/oneShotCandidates.js';

type RequestText = (prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>;

/**
 * Adapt explicit "selected text + voice rewrite" JSON requests to the desktop
 * auxiliary utility-model chain (`requestUtilityText`).
 *
 * Crucially, this NEVER touches managed `voice-server` `/refine` (whose system
 * prompt hash is strictly whitelisted for near-identity dictation cleanup).
 */
export class VoiceRewriteTextModelClient implements TextModelClient {
  servedRoute?: { providerId: string; model: string };

  constructor(
    private readonly requestText: RequestText,
    private readonly assertRequestCurrent: () => void,
  ) {}

  async requestJson<T>(input: Parameters<TextModelClient['requestJson']>[0]): Promise<T> {
    this.assertRequestCurrent();
    this.servedRoute = undefined;
    const result = await this.requestText(JSON.stringify(input.user), {
      source: 'voice-rewrite',
      systemPrompt: input.system,
      timeoutMs: 20_000,
      maxTokens: 4_096,
      disableReasoning: true,
      beforeDispatch: async () => {
        this.assertRequestCurrent();
        return true;
      },
      validateResponse: (text) => {
        try {
          parseRewriteResponse(text);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.assertRequestCurrent();
    if (!result.ok) throw new Error(`Voice rewrite failed: ${result.reason}`);
    const parsed = parseRewriteResponse(result.text);
    this.servedRoute = { providerId: result.providerId, model: result.model };
    return parsed as T;
  }
}

export function parseRewriteResponse(text: string): { text: string } {
  // Never include raw model output in thrown errors sent to logs or renderer.
  let parsed: unknown;
  try {
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Invalid voice rewrite response');
      parsed = JSON.parse(match[0]);
    }
  } catch {
    throw new Error('Invalid voice rewrite response');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('Invalid voice rewrite response');
  }
  return { text: (parsed as { text: string }).text };
}
