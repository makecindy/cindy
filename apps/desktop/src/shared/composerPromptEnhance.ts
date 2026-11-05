/**
 * Shared contract for the composer's "enhance prompt" action.
 *
 * main / preload / renderer all read this file so the channel name and the
 * payload shape can never drift apart.
 */

/** IPC channel that rewrites a draft prompt with the auxiliary-model chain. */
export const COMPOSER_ENHANCE_PROMPT_CHANNEL = 'composer:enhance-prompt';

/**
 * Upper bound for the draft prompt the renderer may send.
 *
 * The rewrite is a single utility-model call, so an unbounded payload would
 * only buy a slower, more expensive round trip. The bound is deliberately
 * small: a rewrite expands the draft, and the output budget has to hold the
 * expanded result (see COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS).
 */
export const COMPOSER_ENHANCE_MAX_INPUT_CHARS = 1_500;

/** Successful rewrite: the new prompt text and the route that produced it. */
export type ComposerEnhancePromptSuccess = {
  text: string;
  model: string;
};

/**
 * True when a rewrite ends inside an unclosed code fence.
 *
 * This is a format check on the answer, not truncation detection: the
 * utility-model route does not expose the provider's finish reason, so a
 * response cut off by the token budget cannot be told apart from a complete
 * one here. A rewrite that breaks the fence would confuse the model, so it is
 * refused rather than applied.
 */
export function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/```/g);
  if (!fences) return false;
  return fences.length % 2 === 1;
}
