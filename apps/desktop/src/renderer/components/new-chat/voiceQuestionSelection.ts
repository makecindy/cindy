/** A renderer-local capability installed only by the ordinary question card.
 * Never install one for permissions, plan approval or other execution decisions.
 * Object identity scopes an ASR utterance to one visible wizard step.
 */
export interface VoiceQuestionTarget {
  receive(text: string): void;
}
export interface VoiceQuestionBridge {
  current: VoiceQuestionTarget | null;
}

type Selection =
  | { kind: 'select'; indices: number[] }
  | { kind: 'ambiguous' }
  | { kind: 'confirm' | 'cancel' | 'unknown' };

const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/[。.!！?？]+$/u, '').replace(/\s+/gu, '').trim();

function ordinal(value: string): number | null {
  const cardinal = /^(?:option)?(one|two|three|four|five|six|seven|eight|nine|ten)$/u.exec(value);
  if (cardinal) return ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(cardinal[1]);
  const english = /^(?:the)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:option|one)?$/u.exec(value);
  if (english) return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].indexOf(english[1]);
  const korean = /^(첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)번째(?:옵션)?$/u.exec(value);
  if (korean) return ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'].indexOf(korean[1]);
  const match = /^(?:第([一二两三四五六七八九十\d]+)(?:个|项|個|項)?|(?:选项|選項|option)([一二两三四五六七八九十\d]+)|([一二三四五六七八九十\d]+)番(?:目)?|(\d+)(?:번)?)$/u.exec(value);
  if (!match) return null;
  const number = match[1] ?? match[2] ?? match[3] ?? match[4];
  const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return (chinese[number] ?? Number(number)) - 1;
}

/** Whole-utterance grammar only: never extract a choice from a negation,
 * quotation or a longer request. Unknown/ambiguous speech stays on the card.
 */
export function parseVoiceQuestionSelection(text: string, labels: readonly string[]): Selection {
  const normalized = normalize(text);
  // An option named "确认" or "取消" remains a real option.
  const exact = labels.flatMap((label, index) => normalize(label) === normalized ? [index] : []);
  if (exact.length) return exact.length === 1 ? { kind: 'select', indices: exact } : { kind: 'ambiguous' };
  if (/^(确认|确认选择|确认提交|提交选择|確認|確認選擇|確認提交|選択を確定|선택확인|confirm|confirmselection)$/u.test(normalized)) return { kind: 'confirm' };
  if (/^(取消|取消选择|重新选择|取消選擇|重新選擇|選択を取り消し|선택취소|cancel|cancelselection)$/u.test(normalized)) return { kind: 'cancel' };
  const value = normalized.replace(/^(?:我选择|我要选|我选|选择|选|我選擇|我要選|我選|選擇|選|select|choose)/u, '');
  // Try the entire label before separators: names can contain "和" or commas.
  const full = labels.flatMap((label, index) => normalize(label) === value ? [index] : []);
  if (full.length) return full.length === 1 ? { kind: 'select', indices: full } : { kind: 'ambiguous' };
  const parts = value.split(/(?:或者|还是|或|和|以及|还有|、|，|,|and|or)/u);
  const indices: number[] = [];
  for (const part of parts) {
    const matches = labels.flatMap((label, index) => normalize(label) === part ? [index] : []);
    if (matches.length > 1) return { kind: 'ambiguous' };
    const index = matches[0] ?? ordinal(part);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= labels.length) return { kind: 'unknown' };
    indices.push(index);
  }
  if (/(?:或者|还是|或|or)/u.test(value) && parts.length > 1) return { kind: 'ambiguous' };
  return { kind: 'select', indices: [...new Set(indices)] };
}
