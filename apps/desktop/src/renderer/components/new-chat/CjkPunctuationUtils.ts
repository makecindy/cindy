/**
 * Shared CJK-context punctuation rules for the composer decoration plugins.
 *
 * ASCII punctuation can take the neighboring Latin font during Windows IME
 * composition, but only punctuation next to CJK text needs the CJK font stack.
 * Keeping this predicate shared prevents list fallback wrappers and inline
 * punctuation spans from disagreeing about which ranges they own.
 */
const CJK_PUNCT_CHAR_REGEX = /[\u3000-\u303f\uff00-\uffef]/;
const CJK_SCRIPT_CHAR_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_CJK_PUNCTUATION = new Set([
  '!',
  '"',
  "'",
  '(',
  ')',
  ',',
  '.',
  ':',
  ';',
  '?',
  '[',
  ']',
  '{',
  '}',
]);

function isCjkChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    (CJK_SCRIPT_CHAR_REGEX.test(char) || CJK_PUNCT_CHAR_REGEX.test(char))
  );
}

/**
 * Tests one character in the full text. The optional range limits which
 * punctuation characters are selected, while neighbor lookup still sees the
 * complete text so a list prefix can inherit context from its body.
 */
export function isCjkContextPunctuation(
  text: string,
  index: number,
  from = 0,
  to = text.length,
): boolean {
  const char = text[index];
  if (char === undefined || index < from || index >= to) return false;
  if (CJK_PUNCT_CHAR_REGEX.test(char)) return true;
  if (!ASCII_CJK_PUNCTUATION.has(char)) return false;

  const isContextSeparator = (value: string | undefined) =>
    value !== undefined && (/\s/.test(value) || ASCII_CJK_PUNCTUATION.has(value));
  let before = index - 1;
  while (before >= 0 && isContextSeparator(text[before])) before -= 1;
  if (before >= 0 && isCjkChar(text[before])) return true;

  let after = index + 1;
  while (after < text.length && isContextSeparator(text[after])) after += 1;
  return after < text.length && isCjkChar(text[after]);
}

export function hasCjkContextPunctuation(
  text: string,
  from = 0,
  to = text.length,
): boolean {
  for (let index = from; index < to; index += 1) {
    if (isCjkContextPunctuation(text, index, from, to)) return true;
  }
  return false;
}
