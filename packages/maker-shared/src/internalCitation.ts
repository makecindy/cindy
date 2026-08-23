/**
 * OpenAI Web Search may encode source references in assistant text with
 * private-use delimiters such as `\uE200cite\uE202...\uE201`. Those tokens are
 * transport metadata, not user-facing prose. Some Codex app-server versions
 * expose only the flattened text and omit the structured URL annotations, so
 * client boundaries must remove the opaque marker deterministically.
 *
 * Grok / xAI may also leak the stop token `<|eos|>` as visible assistant
 * text, typically as a whole message after a tool-only wrap-up. That marker
 * is not user-facing prose either.
 */
const MODEL_STOP_TOKENS = new Set(['<|endoftext|>', '<|eot_id|>', '<|im_end|>', '<|eos|>']);
const LONGEST_MODEL_STOP_TOKEN = Math.max(
  ...[...MODEL_STOP_TOKENS].map((token) => token.length),
);
/** Leading whitespace plus the longest token. Anything longer cannot be standalone. */
const MAX_STANDALONE_STOP_PREFIX = LONGEST_MODEL_STOP_TOKEN + 16;
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

/**
 * Drop a leaked model stop token only when it is the whole assistant
 * message (optional surrounding whitespace). Embedded mentions such as
 * `The token is <|eos|>` stay intact.
 */
export function stripStandaloneModelStopToken(text: string): string {
  return MODEL_STOP_TOKENS.has(text.trim()) ? '' : text;
}

/**
 * True while `text` is still only a possible whole-message stop token:
 * surrounding whitespace, a known token, or any incomplete prefix of one
 * (`<`, `<|`, `<|eo`, …). Used to hold streaming deltas until the leftover
 * can be dropped or flushed.
 */
export function isPossibleStandaloneStopPrefix(text: string): boolean {
  const candidate = text.trim();
  if (candidate.length === 0) return true;
  if (MODEL_STOP_TOKENS.has(candidate)) return true;
  if (candidate.length > MAX_STANDALONE_STOP_PREFIX) return false;
  return [...MODEL_STOP_TOKENS].some((token) => token.startsWith(candidate));
}

/**
 * Return the append-only prefix of a streaming snapshot. A standalone
 * leftover — including its surrounding whitespace and an incomplete
 * `<|eos` prefix — is withheld until the closer arrives, because the
 * completed token will disappear.
 */
export function stableStandaloneModelStopTokenBoundary(text: string): number {
  return isPossibleStandaloneStopPrefix(text) ? 0 : text.length;
}

export interface StandaloneStopTokenHold {
  pending: string;
  emitted: boolean;
}

/**
 * Hold a leftover stop token until this stream has either completed it or
 * proven it is ordinary prose. After visible prose starts, still hold an
 * unfinished Web-citation tail so split markers are not emitted raw.
 * The buffer is per stream; callers must not share it across concurrent
 * text streams.
 */
export function holdStandaloneStopTokenDelta(
  buffer: StandaloneStopTokenHold,
  delta: string,
): string | null {
  const combined = buffer.pending + delta;
  if (!buffer.emitted && isPossibleStandaloneStopPrefix(combined)) {
    const candidate = combined.trim();
    if (candidate.length === 0) {
      buffer.pending = combined.slice(-MAX_STANDALONE_STOP_PREFIX);
    } else {
      const tokenStart = combined.lastIndexOf(candidate);
      buffer.pending = `${combined.slice(0, tokenStart).slice(-MAX_STANDALONE_STOP_PREFIX)}${candidate}`;
    }
    return null;
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
