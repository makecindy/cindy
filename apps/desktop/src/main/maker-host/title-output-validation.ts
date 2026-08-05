/** Deterministic acceptance rules for model-produced session titles. */

const META_PREFIX_RE =
  /^(?:(?:according to (?:the )?conversation|based on (?:the )?conversation|here(?:'s| is) (?:the )?title)(?:\b|\s|[,:：，。.!！?？])|(?:title|标题|タイトル|제목)\s*[:：]|以下是|根据对话内容)/iu;
const ROLE_LABEL_RE =
  /(?:^|\s)(?:assistant|user|助手|用户|アシスタント|ユーザー|어시스턴트|사용자)\s*(?::|：|[-—–]\s)/iu;
/**
 * Weak title models occasionally answer the title instructions themselves instead
 * of the quoted message (issue #1688: the whole title was "生成简洁中文标题").
 * Reject whole-title echoes of the instruction across the supported UI languages;
 * titles merely containing these words (e.g. "修复标题生成 bug") stay accepted.
 */
const INSTRUCTION_ECHO_RES: readonly RegExp[] = [
  /^(?:请|請)?(?:(?:为|為|给|給)(?:用户|用戶|以下)?(?:消息|訊息|对话|對話|会话|會話|任务|任務)?)?(?:生成)?(?:一个|一個)?(?:简洁|簡潔)(?:的)?(?:中文|英文|日文|日语|日語|韩文|韩语|韓語)?(?:会话|會話|对话|對話|任务|任務)?(?:标题|標題)$/u,
  /^(?:generate\s+)?(?:a\s+)?concise\s+(?:conversation\s+|session\s+|task\s+)?title$/iu,
  /^簡潔な(?:日本語の)?タイトル(?:を生成)?$/u,
  /^간결한\s*(?:한국어\s*)?제목(?:\s*생성)?$/u,
];

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
  if (INSTRUCTION_ECHO_RES.some((re) => re.test(title))) return null;
  if (exceedsUnicodeCodePointLimit(title, maxChars)) return null;
  return title;
}
