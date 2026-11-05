import { throwIpcError } from './utils/ipcValidate.js';
import {
  COMPOSER_ENHANCE_MAX_INPUT_CHARS,
  hasUnclosedFence,
} from '../shared/composerPromptEnhance.js';
import type { UtilityTextResult } from '../shared/utilityTextResult.js';

/**
 * Rewrite rules handed to the utility model.
 *
 * Kept in English on purpose: it is model-facing instructions rather than
 * user-facing copy, so it is not part of the localized string catalogue.
 * The wording stays domain-neutral on purpose — the composer is used for far
 * more than coding work.
 */
export const COMPOSER_ENHANCE_SYSTEM_PROMPT = [
  'You rewrite a draft request into a stronger, more explicit request for an AI assistant.',
  'Rules:',
  "- Preserve the author's intent, their language, and every concrete detail they wrote.",
  '- Add only the structure the draft already implies: an explicit goal, a concrete scope, the constraints, and what "done" looks like.',
  '- Never invent facts, names, numbers, or requirements that the draft does not mention.',
  '- Never answer the request. You only rewrite the request.',
  '- Never drop an instruction the author wrote, even when it looks redundant.',
].join('\n');

/** Output shape: the rewritten request only, no commentary around it. */
export const COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS =
  'Reply with the rewritten request only. No preamble, no commentary, no markdown code fences.';

/**
 * Output budget.
 *
 * Sized against COMPOSER_ENHANCE_MAX_INPUT_CHARS so a rewrite of the longest
 * accepted draft still fits: a rewrite may expand the draft, so the budget
 * leaves room instead of silently truncating the answer.
 */
export const COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS = 2048;

/** Per-candidate budget handed to the utility-model chain. */
export const COMPOSER_ENHANCE_TIMEOUT_MS = 60_000;

/** Wraps the author's draft in the instruction the utility model receives. */
export function buildEnhancePrompt(userText: string): string {
  return ['Rewrite the following draft request.', '', '<draft>', userText, '</draft>'].join('\n');
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
  if (hasUnclosedFence(enhanced)) {
    throwIpcError('INTERNAL', 'The enhanced prompt has an unclosed code fence');
  }
  return { text: enhanced, model: `${result.providerId}/${result.model}` };
}

export const __testing = { buildEnhancePrompt };
