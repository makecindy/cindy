/**
 * OpenAI Web Search may encode source references in assistant text with
 * private-use delimiters such as `\uE200cite\uE202...\uE201`. Those tokens are
 * transport metadata, not user-facing prose. Some Codex app-server versions
 * expose only the flattened text and omit the structured URL annotations, so
 * client boundaries must remove the opaque marker deterministically.
 *
 * Grok / xAI may also leak stop tokens such as `<|eos|>` as visible
 * assistant text, typically as a wrap-up after a tool-only turn. One token,
 * several in a row, or the same tokens split across stream deltas are still
 * transport control, not user-facing prose. Mentions that follow real
 * prose, such as `The token is <|eos|>`, stay intact.
 */
const MODEL_STOP_TOKEN_LIST = ['<|endoftext|>', '<|eot_id|>', '<|im_end|>', '<|eos|>'];
const LONGEST_MODEL_STOP_TOKEN = Math.max(
  ...MODEL_STOP_TOKEN_LIST.map((token) => token.length),
);
const WEB_CITATION_OPEN = '\uE200cite\uE202';
const WEB_CITATION_CLOSE = '\uE201';

function unfinishedWebCitationOpen(text: string): number {
  let from = 0;
  for (;;) {
    const open = text.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return -1;
    const close = text.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return open;
    from = close + WEB_CITATION_CLOSE.length;
  }
}

function partialWebCitationPrefixStart(text: string): number {
  const maxProbe = Math.min(text.length, WEB_CITATION_OPEN.length - 1);
  for (let length = maxProbe; length > 0; length -= 1) {
    if (text.endsWith(WEB_CITATION_OPEN.slice(0, length))) return text.length - length;
  }
  return text.length;
}

/**
 * Return the append-only prefix of a streaming assistant snapshot. A Web
 * citation tail is withheld until its closing delimiter arrives, because the
 * whole marker will disappear from the visible text once complete.
 */
export function stableInternalWebCitationBoundary(text: string): number {
  const unfinished = unfinishedWebCitationOpen(text);
  return unfinished === -1 ? partialWebCitationPrefixStart(text) : unfinished;
}

/**
 * Strip complete Web citation markers plus an unfinished final marker/prefix.
 * The payload is intentionally treated as opaque: private-use delimiters are
 * the exact compatibility boundary, while ordinary words such as "cite" are
 * left untouched. The transform is idempotent.
 */
export function stripInternalWebCitations(text: string): string {
  return stripStandaloneModelStopToken(stripInternalWebCitationMarkers(text));
}

function stripInternalWebCitationMarkers(text: string): string {
  if (!text.includes('\uE200')) return text;

  const stableEnd = stableInternalWebCitationBoundary(text);
  const stable = stableEnd === text.length ? text : text.slice(0, stableEnd);
  if (!stable.includes(WEB_CITATION_OPEN)) return stable;

  let output = '';
  let from = 0;
  for (;;) {
    const open = stable.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return output + stable.slice(from);
    const close = stable.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return output + stable.slice(from, open);
    output += stable.slice(from, open);
    from = close + WEB_CITATION_CLOSE.length;
  }
}

function matchStopTokenAt(text: string, index: number): string | null {
  for (const token of MODEL_STOP_TOKEN_LIST) {
    if (text.startsWith(token, index)) return token;
  }
  return null;
}

function isIncompleteStopTokenPrefix(text: string): boolean {
  return text.length > 0
    && text.length <= LONGEST_MODEL_STOP_TOKEN
    && MODEL_STOP_TOKEN_LIST.some((token) => token.startsWith(text));
}

/**
 * Eat a leading run of known stop tokens and the whitespace around them.
 * Completed messages only disappear when nothing remains. The streaming
 * hold keeps a recognized run pending until later prose proves the block
 * is not stop-control-only, then emits that original text.
 */
function consumeLeadingStopControl(text: string): { remainder: string; consumedToken: boolean } {
  let index = 0;
  let consumedToken = false;
  while (index < text.length) {
    if ((text[index] ?? '').trim() === '') {
      index += 1;
      continue;
    }
    const token = matchStopTokenAt(text, index);
    if (!token) break;
    consumedToken = true;
    index += token.length;
  }
  return { remainder: text.slice(index), consumedToken };
}

/**
 * Drop a leaked stop-token run only when it is the whole assistant
 * message (optional surrounding whitespace). Repeated or mixed tokens
 * still count. Mentions such as `The token is <|eos|>`, or a token
 * glued to later prose (`<|eos|>answer`), stay intact.
 */
export function stripStandaloneModelStopToken(text: string): string {
  const { remainder, consumedToken } = consumeLeadingStopControl(text);
  return consumedToken && remainder.length === 0 ? '' : text;
}

/**
 * True while `text` is still only stop-token control: whitespace, one or
 * more known tokens, and at most one incomplete prefix (`<`, `<|eo`, …).
 * Used to hold streaming deltas until the leftover can be dropped or flushed.
 */
export function isPossibleStandaloneStopPrefix(text: string): boolean {
  const { remainder } = consumeLeadingStopControl(text);
  return remainder.length === 0 || isIncompleteStopTokenPrefix(remainder);
}

/**
 * Return the append-only prefix of a streaming snapshot. A standalone
 * leftover — including repeated tokens and an incomplete `<|eos` prefix —
 * is withheld until the closer arrives, because the completed control
 * will disappear.
 */
export function stableStandaloneModelStopTokenBoundary(text: string): number {
  return isPossibleStandaloneStopPrefix(text) ? 0 : text.length;
}

export interface StandaloneStopTokenHold {
  pending: string;
  emitted: boolean;
}

/**
 * Hold leftover stop-token control until this stream has either completed
 * it or proven it is ordinary prose. A recognized run stays pending so a
 * later `answer` can still reconstruct `<|eos|>answer`; only a later copy
 * of the same control run is dropped. After visible prose starts, still
 * hold an unfinished Web-citation tail so split markers are not emitted
 * raw. The buffer is per stream; callers must not share it across
 * concurrent text streams.
 */
export function holdStandaloneStopTokenDelta(
  buffer: StandaloneStopTokenHold,
  delta: string,
): string | null {
  const combined = buffer.pending + delta;
  if (!buffer.emitted) {
    const { remainder } = consumeLeadingStopControl(combined);
    if (remainder.length === 0 || isIncompleteStopTokenPrefix(remainder)) {
      buffer.pending = combined;
      return null;
    }
  }
  const citationEnd = stableInternalWebCitationBoundary(combined);
  buffer.pending = combined.slice(citationEnd);
  const stable = combined.slice(0, citationEnd);
  const visible = buffer.emitted
    ? stripInternalWebCitationMarkers(stable)
    : stripInternalWebCitations(stable);
  if (visible.length > 0) buffer.emitted = true;
  return visible.length > 0 ? visible : null;
}
