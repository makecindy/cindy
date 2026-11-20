/**
 * 侧栏「↳ 来源短名」的截断：按显示宽度而不是字符数。东亚宽字符（汉字、假名、谚文、全角符号）
 * 与 emoji 记 2 个单位，其余记 1 个；超出时在宽度内截断并补「…」（「…」记 1 个单位）。
 * 这样同一预算下中文约 8 个字、英文约 16 个字母，视觉长度接近。
 */
export const SESSION_ORIGIN_SHORT_NAME_WIDTH = 16;

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

function charWidth(ch: string): number {
  return WIDE.test(ch) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

export function clipByDisplayWidth(text: string, maxWidth = SESSION_ORIGIN_SHORT_NAME_WIDTH): string {
  const trimmed = text.trim();
  if (displayWidth(trimmed) <= maxWidth) return trimmed;
  let width = 0;
  let out = '';
  for (const ch of trimmed) {
    const next = charWidth(ch);
    if (width + next > maxWidth - 1) break;
    out += ch;
    width += next;
  }
  return `${out.trimEnd()}…`;
}
