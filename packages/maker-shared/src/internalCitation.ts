/**
 * OpenAI Web Search may encode source references in assistant text with
 * private-use delimiters such as `\uE200cite\uE202...\uE201`. Those tokens are
 * transport metadata, not user-facing prose. Some Codex app-server versions
 * expose only the flattened text and omit the structured URL annotations, so
 * client boundaries must remove the opaque marker deterministically.
 */
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
