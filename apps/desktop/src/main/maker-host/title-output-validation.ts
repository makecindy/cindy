/** Deterministic acceptance rules for model-produced session titles. */

const META_PREFIX_RE =
  /^(?:according to (?:the )?conversation|based on (?:the )?conversation|here(?:'s| is) (?:the )?title|title\s*[:：]|标题\s*[:：]|以下是|根据对话内容)(?:\b|\s|[,:：，。.!！?？]|这)/iu;
const ROLE_LABEL_RE = /(?:^|\s)(?:assistant|user)\s*(?::|：|[-—–]\s)/iu;

function stripWrappingQuotes(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length >= 2) {
      return value.slice(open.length, -close.length).trim();
    }
  }
  return value;
}

/**
 * Return a safe one-line title, or null when the model returned transcript/meta text.
 * `maxChars` uses Unicode code points rather than UTF-16 code units.
 */
export function validateTitleOutput(
  raw: string | null | undefined,
  maxChars: number,
): string | null {
  if (typeof raw !== 'string' || !Number.isFinite(maxChars) || maxChars <= 0) return null;
  const original = raw.trim();
  if (!original || /[\r\n\u2028\u2029]/u.test(original)) return null;

  const title = stripWrappingQuotes(original)
    .replace(/[\t\f\v ]+/gu, ' ')
    .trim();
  if (!title || title.includes('```')) return null;
  if (/^#{1,6}\s/u.test(title)) return null;
  if (ROLE_LABEL_RE.test(title) || META_PREFIX_RE.test(title)) return null;
  if (Array.from(title).length > maxChars) return null;
  return title;
}
