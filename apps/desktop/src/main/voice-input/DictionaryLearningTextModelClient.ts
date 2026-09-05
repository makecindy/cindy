import type { TextModelClient } from '@cindy/voice-input-core';

import type { UtilityTextResult } from '../../shared/utilityTextResult.js';
import type { UtilityTextRequestOptions } from '../utility-model/oneShotCandidates.js';

type RequestText = (prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>;

/** Adapt dictionary JSON requests to the full auxiliary chain, without voice transport filtering. */
export class DictionaryLearningTextModelClient implements TextModelClient {
  servedRoute?: { providerId: string; model: string };

  constructor(
    private readonly requestText: RequestText,
    private readonly assertRequestCurrent: () => void,
  ) {}

  async requestJson<T>(input: Parameters<TextModelClient['requestJson']>[0]): Promise<T> {
    this.assertRequestCurrent();
    this.servedRoute = undefined;
    // Model selection and fallback belong to requestUtilityText. The advisor's
    // model/cache labels must not pin a provider or reintroduce the voice chain.
    const result = await this.requestText(JSON.stringify(input.user), {
      systemPrompt: input.system,
      timeoutMs: 8_000,
      // The advisor returns at most three actions, not a general text response.
      maxTokens: 4_096,
      disableReasoning: true,
      beforeDispatch: async () => {
        this.assertRequestCurrent();
        return true;
      },
      validateResponse: (text) => {
        try {
          parseDictionaryResponse(text);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.assertRequestCurrent();
    if (!result.ok) throw new Error(`Dictionary learning failed: ${result.reason}`);
    const parsed = parseDictionaryResponse(result.text);
    this.servedRoute = { providerId: result.providerId, model: result.model };
    return parsed as T;
  }
}

function parseDictionaryResponse(text: string): unknown {
  // Preserve the previous clients' fenced/wrapped JSON compatibility, but
  // never include model output in an exception sent to logs or the renderer.
  let parsed: unknown;
  try {
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Invalid dictionary response');
      parsed = JSON.parse(match[0]);
    }
  } catch {
    throw new Error('Invalid dictionary response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !('actions' in parsed) || !Array.isArray(parsed.actions)) {
    throw new Error('Invalid dictionary response');
  }
  return parsed;
}
