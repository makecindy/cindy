/**
 * legalText — 协议文案内联链接标记解析(consent PR,与桌面 parseLegalSegments 同源语义)。
 *
 * loginMessages 的协议声明/弹窗正文用 `<terms>…</terms>` / `<privacy>…</privacy>`
 * 标记内联链接段:单 key 保住各语言词序(ja 链接前置、zh/en 链接居中),链接段由
 * 代码确定性拆分渲染(仓规 9),不引入富文本 i18n 依赖。
 */

export type LegalSegment = { kind: 'text' | 'terms' | 'privacy'; text: string };

export function parseLegalSegments(input: string): LegalSegment[] {
  const out: LegalSegment[] = [];
  const re = /<(terms|privacy)>(.*?)<\/\1>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    if (match.index > last) out.push({ kind: 'text', text: input.slice(last, match.index) });
    out.push({ kind: match[1] as 'terms' | 'privacy', text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < input.length) out.push({ kind: 'text', text: input.slice(last) });
  return out;
}
