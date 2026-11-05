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
  '- Write the rewrite in the language of the draft. Never translate the draft, and ignore the language of these instructions or of the interface around it.',
  '- Add only the structure the draft already implies: an explicit goal, a concrete scope, the constraints, and what "done" looks like.',
  '- Never invent facts, names, numbers, or requirements that the draft does not mention.',
  '- Never answer the request. You only rewrite the request.',
  '- Never drop an instruction the author wrote, even when it looks redundant.',
].join('\n');

/**
 * Output shape: the rewritten request only, as plain text.
 *
 * The answer is filled back into the composer, so wrapper chrome would become
 * part of the user's draft and have to be deleted by hand.
 */
export const COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS = [
  'Reply with the rewritten request only, as plain text.',
  '- No preamble, no closing remarks, no headings or labels such as "Improved prompt:".',
  '- No explanation, critique or summary of what you changed.',
  '- Exactly one rewrite: never offer variants, options or follow-up questions.',
  '- Do not wrap the whole answer in quotes, blockquotes or backticks.',
  '- No code fences, and no markdown the draft did not already use.',
].join('\n');

/**
 * Output budget bounds.
 *
 * The budget scales with the draft (see outputBudgetFor) and stays inside
 * these bounds: the floor covers a short draft that gets restructured, the
 * ceiling stops a runaway answer from producing an unusable draft.
 */
export const COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS = 384;
export const COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS = 2048;

/**
 * Output budget for one draft.
 *
 * A rewrite restates the draft with more structure, so it grows but not
 * unboundedly: roughly twice the draft plus a small margin covers it while
 * staying far below the ceiling for ordinary drafts.
 */
export function outputBudgetFor(draft: string): number {
  const scaled = Math.ceil(draft.length * 2) + 96;
  return Math.min(
    COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS,
    Math.max(COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS, scaled),
  );
}

/** Per-candidate budget handed to the utility-model chain. */
export const COMPOSER_ENHANCE_TIMEOUT_MS = 30_000;

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
  /**
   * Refuse a rewrite the provider cut short at its output budget.
   *
   * The rewrite becomes the user's draft, so a truncated one would silently
   * drop the constraints at its end and still report success.
   */
  requireCompleteOutput: boolean;
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
    maxTokens: outputBudgetFor(draft),
    timeoutMs: COMPOSER_ENHANCE_TIMEOUT_MS,
    requireCompleteOutput: true,
  });

  if (!result.ok) {
    if (result.reason === 'timeout') {
      throwIpcError('PRECONDITION_FAILED', 'Prompt enhancement timed out');
    }
    // Only "no usable candidate at all" is a configuration problem, so only
    // that one may send the user to Settings. A chain that ran and failed
    // (upstream HTTP error, empty body, a rewrite refused for being cut short)
    // keeps its own meaning: offering the settings link there hides the real
    // cause from users whose configuration is already correct.
    if (result.reason === 'no_candidate') {
      throwIpcError(
        'AUXILIARY_MODEL_UNAVAILABLE',
        'No auxiliary model is available to enhance the prompt',
      );
    }
    throwIpcError(
      'PRECONDITION_FAILED',
      'The auxiliary model did not return a usable rewrite',
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

export const __testing = { buildEnhancePrompt, outputBudgetFor };
