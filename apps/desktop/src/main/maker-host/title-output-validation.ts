/** Deterministic acceptance rules for model-produced session titles. */

const META_PREFIX_RE =
  /^(?:(?:according to (?:the )?conversation|based on (?:the )?conversation|here(?:'s| is) (?:the )?title)(?:\b|\s|[,:：，。.!！?？])|(?:title|标题|タイトル|제목)\s*[:：]|以下是|根据对话内容)/iu;
const ROLE_LABEL_RE =
  /(?:^|\s)(?:assistant|user|助手|用户|アシスタント|ユーザー|어시스턴트|사용자)\s*(?::|：|[-—–]\s)/iu;

function exceedsUnicodeCodePointLimit(value: string, maxChars: number): boolean {
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > maxChars) return true;
  }
  return false;
}

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
  if (exceedsUnicodeCodePointLimit(title, maxChars)) return null;
  return title;
}
