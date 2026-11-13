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
 *
 * The fence delimiters are matched per line, like a Markdown parser does. A
 * literal ``` inside a sentence (a draft asking to remove that marker, say) is
 * text the author wrote, not an opened block, and counting occurrences would
 * reject exactly the rewrites that preserved it.
 *
 * A fence is tracked by its character and length, the same way the composer's
 * list renderer scans a document (renderer/lib/composerListDocument.ts): a
 * block opened with `~~~` is closed by `~~~` or a longer run of tildes, and a
 * ``` line inside it is literal text rather than another fence. Only counting
 * backticks made a draft that displays a markdown block with `~~~` look
 * unclosed — the literal backticks inside it were taken for an opening fence,
 * and a perfectly valid rewrite was refused.
 */
export function hasUnclosedFence(text: string): boolean {
  let openFence: FenceState | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (openFence) {
      if (isFenceClosing(line, openFence)) openFence = null;
      continue;
    }
    const opening = fenceOpening(line);
    if (opening) openFence = opening;
  }
  return openFence !== null;
}

/** The delimiter a fenced block was opened with. */
interface FenceState {
  char: '`' | '~';
  length: number;
}

/**
 * The fence a line opens, or null when the line does not open one.
 *
 * An opening fence may carry an info string (` ```ts `, ` ~~~markdown `); a
 * backtick fence's info string may not contain a backtick, so such a line is
 * literal text. Both allow up to three leading spaces.
 */
function fenceOpening(line: string): FenceState | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { char: match[1][0] as FenceState['char'], length: match[1].length };
}

/**
 * True when the line closes the given fence: same character, at least as long
 * as the opening run, and nothing but trailing spaces or tabs after it.
 */
function isFenceClosing(line: string, state: FenceState): boolean {
  const pattern = new RegExp(`^ {0,3}${state.char}{${state.length},}[ \\t]*$`);
  return pattern.test(line);
}
