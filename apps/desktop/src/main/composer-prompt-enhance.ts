import { throwIpcError } from './utils/ipcValidate.js';
import { COMPOSER_ENHANCE_MAX_INPUT_CHARS } from '../shared/composerPromptEnhance.js';
import type { UtilityTextResult } from '../shared/utilityTextResult.js';

/**
 * Rewrite rules handed to the utility model.
 *
 * Kept in English on purpose: it is model-facing instructions rather than
 * user-facing copy, so it is not part of the localized string catalogue.
 */
export const COMPOSER_ENHANCE_SYSTEM_PROMPT = [
  'You rewrite a draft prompt into a stronger, more explicit prompt for an AI coding agent.',
  'Rules:',
  "- Preserve the author's intent, their language, and every concrete detail they wrote.",
  '- Add only the structure the draft already implies: an explicit goal, a concrete scope, the constraints, and what "done" looks like.',
  '- Never invent facts, file names, APIs, numbers, or requirements that the draft does not mention.',
  '- Never answer the request. You only rewrite the request.',
  "- Never drop an instruction the author wrote, even when it looks redundant.",
].join('\n');

/** Output shape: the rewritten prompt only, no commentary around it. */
export const COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS =
  'Reply with the rewritten prompt only. No preamble, no commentary, no markdown code fences.';

/** Output budget: a rewritten prompt is prose, not a document. */
export const COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS = 1024;

/** Wall-clock budget for one rewrite. */
export const COMPOSER_ENHANCE_TIMEOUT_MS = 60_000;

/** Wraps the author's draft in the instruction the utility model receives. */
export function buildEnhancePrompt(userText: string): string {
  return ['Rewrite the following draft prompt.', '', '<draft>', userText, '</draft>'].join('\n');
}

/** Options forwarded to the utility-model call. */
export type ComposerEnhanceRequestOptions = {
  systemPrompt: string;
  responseInstructions: string;
  maxTokens: number;
  timeoutMs: number;
};

/**
 * The utility-model call, injected so this module stays testable without
 * Electron or a live provider.
 */
export type ComposerEnhanceRequester = (
  prompt: string,
  options: ComposerEnhanceRequestOptions,
) => Promise<UtilityTextResult>;

/**
 * Rewrites a draft prompt and returns the new text.
 *
 * Failures surface as IPC errors so the renderer can decode them with the
 * shared `ipcError.*` contract instead of guessing from a message string.
 */
export async function enhanceComposerPrompt(
  request: ComposerEnhanceRequester,
  rawText: unknown,
): Promise<{ text: string; model: string }> {
  if (typeof rawText !== 'string') {
    throwIpcError('INVALID_PARAMS', 'Prompt text must be a string');
  }
  const draft = rawText.trim();
  if (!draft) {
    throwIpcError('INVALID_PARAMS', 'Prompt text must not be empty');
  }
  if (draft.length > COMPOSER_ENHANCE_MAX_INPUT_CHARS) {
    throwIpcError('INVALID_PARAMS', 'Prompt text is too long to enhance');
  }

  const result = await request(buildEnhancePrompt(draft), {
    systemPrompt: COMPOSER_ENHANCE_SYSTEM_PROMPT,
    responseInstructions: COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS,
    maxTokens: COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS,
    timeoutMs: COMPOSER_ENHANCE_TIMEOUT_MS,
  });

  if (!result.ok) {
    // The auxiliary chain is the only route this feature uses, so an exhausted
    // chain is a configuration problem the user can act on.
    throwIpcError(
      'PRECONDITION_FAILED',
      result.reason === 'timeout'
        ? 'Prompt enhancement timed out'
        : 'No auxiliary model is available to enhance the prompt',
    );
  }

  const enhanced = result.text.trim();
  if (!enhanced) {
    throwIpcError('INTERNAL', 'The enhancement model returned an empty prompt');
  }
  return { text: enhanced, model: `${result.providerId}/${result.model}` };
}

export const __testing = { buildEnhancePrompt };
