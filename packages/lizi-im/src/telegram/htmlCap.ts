/**
 * telegram/htmlCap.ts — HTML 安全截断(标签栈闭合)。
 * ---------------------------------------------------------------------------
 * #1855 L1: 从 components.capCardText 提取为**导出的通用原语** `capRenderedText`,
 * 供交互卡正文与其它 Telegram HTML 出站复用(官方旧路径裸 truncate(4000) 会切在
 * 标签中间整卡 400 —— 统一到这条安全截断)。
 *
 * 纯字符切片可能切在标签(`<a href=...`)或实体(`&amp;`)中间, parse_mode=HTML
 * 的 sendMessage 会 400 整条失败。截点先回退到完整边界, 再栈扫描闭合未配对的
 * 开标签(Telegram HTML 子集无自闭合标签)。
 */

/**
 * 把 `html` 安全截断到不超过 `maxChars`(含尾部省略号与补闭合标签)。
 * `html.length <= maxChars` 时原样返回。
 */
export function capRenderedText(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  let cut = html.slice(0, maxChars - 1);
  const lastOpen = cut.lastIndexOf('<');
  if (lastOpen > cut.lastIndexOf('>')) cut = cut.slice(0, lastOpen);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';') && cut.length - lastAmp <= 10) {
    cut = cut.slice(0, lastAmp);
  }
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cut)) !== null) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push(name);
    }
  }
  const closers = stack
    .reverse()
    .map((name) => `</${name}>`)
    .join('');
  return `${cut}…${closers}`;
}
