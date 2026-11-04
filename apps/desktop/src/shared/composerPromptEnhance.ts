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
 * only buy a slower, more expensive round trip.
 */
export const COMPOSER_ENHANCE_MAX_INPUT_CHARS = 20_000;

/** Successful rewrite: the new prompt text and the route that produced it. */
export type ComposerEnhancePromptSuccess = {
  ok: true;
  text: string;
  model: string;
};
