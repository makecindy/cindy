/**
 * telegram/markdown.ts — agent markdown → Telegram HTML。
 * ---------------------------------------------------------------------------
 * Telegram 消息用 parse_mode='HTML' 发送(比 MarkdownV2 的转义规则稳健得多:
 * MarkdownV2 要求对 18 个标点全量转义, 漏一处整条消息 400)。支持的标签子集:
 * <b> <i> <s> <code> <pre> <a> <blockquote>。
 *
 * 与 discord/markdown.ts 同一双职责: 渲染文本 + 抽出受管图片
 * (xdt-image:// / cindy-media://)交给上层按 sendPhoto 旁路上传。
 */

interface Segment {
  kind: 'code' | 'text';
  content: string;
}

export function markdownToTelegramHtml(md: string): { html: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  const html = splitByCodeFence(md)
    .map((segment) =>
      segment.kind === 'code'
        ? renderFence(segment.content)
        : renderTextSegment(segment.content, imageUrls),
    )
    .join('');
  return { html, imageUrls };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 剥掉 Telegram HTML 子集标签(400 回退纯文本编辑用)。单趟线性扫描 —
 * 不用 `/<[^>]+>/g` 正则: CodeQL 判其对 '<' 重复串多项式回溯, 且单趟
 * replace 对嵌套构造(`<<b>`)剥不干净。输出走无 parse_mode 的 text 字段,
 * 残余尖括号只是字面字符, 不会被再解释。
 */
export function stripTelegramHtmlTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (!inTag && ch === '<') {
      inTag = true;
    } else if (inTag && ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

function splitByCodeFence(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: 'text', content: text.slice(last, index) });
    segments.push({ kind: 'code', content: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', content: text.slice(last) });
  return segments;
}

function renderFence(fence: string): string {
  const m = fence.match(/^```([^`\n]*)\n?([\s\S]*?)(?:```)?$/);
  const lang = (m?.[1] ?? '').trim();
  const body = m?.[2] ?? '';
  const langAttr = /^[\w+#.-]{1,32}$/.test(lang) ? ` class="language-${lang}"` : '';
  return `<pre><code${langAttr}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
  // 尾换行剥掉: <pre> 自带块级边界, 保留会多出一行空白。
}

function renderTextSegment(segment: string, imageUrls: string[]): string {
  const lines = segment.split('\n');
  const rendered: string[] = [];
  for (const line of lines) {
    const { text: withoutImages, found } = extractImageTokens(line, (url) => imageUrls.push(url));
    if (found) {
      const cleaned = withoutImages.replace(/[ \t]{2,}/g, ' ').trim();
      if (cleaned.length === 0) continue; // 纯图片行整行移除
      rendered.push(renderInline(cleaned));
      continue;
    }
    rendered.push(renderLine(line));
  }
  return rendered.join('\n');
}

/** 行级形态: 标题→粗体行, 引用→blockquote, 列表符号保留(Telegram 无列表标签)。 */
function renderLine(line: string): string {
  // [ \t] 有界量词(CodeQL polynomial-redos): \s+ 与后随 .* 都能吃空白,
  // 歧义边界在长空白串上被判多项式回溯; 行内已无 \n, 8 格之外不算标题。
  const heading = line.match(/^(#{1,6})[ \t]{1,8}(.*)$/);
  if (heading) return `<b>${renderInline(heading[2])}</b>`;
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) return `<blockquote>${renderInline(quote[1])}</blockquote>`;
  // 有界量词(CodeQL polynomial-redos): agent 输出的分隔线不会超过这个宽度。
  if (/^[ \t]{0,64}(?:[-*_][ \t]{0,64}){3,64}$/.test(line) && line.trim().length >= 3) {
    return '———';
  }
  return renderInline(line);
}

/**
 * 行内标记: 先按行内 code 切段(code 内不再解析其它标记), 非 code 段依次
 * 处理链接 / 粗体 / 斜体 / 删除线。纯线性替换, 不追求嵌套完备 —— 与 IM 消息
 * 的实际形态匹配(agent 输出以段落 + code + 链接为主)。
 */
function renderInline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let out = escapeHtml(part);
      // 网络图片语法 ![alt](http…) 降级为链接(Telegram 文本消息内嵌不了图),
      // 先于普通链接处理避免残留孤儿 '!'。label/url 用有界量词(CodeQL
      // polynomial-redos): 超界的病态输入按原文放行, 不构造链接。
      out = out.replace(
        /!\[([^\]]{1,512})\]\((https?:\/\/[^)\s]{1,2048})\)/g,
        (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
      );
      // [text](url) — 只放行 http(s), 其它 scheme 保留原文(不构造可点链接)。
      out = out.replace(
        /\[([^\]]{1,512})\]\((https?:\/\/[^)\s]{1,2048})\)/g,
        (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
      );
      out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      out = out.replace(/__([^_]+)__/g, '<b>$1</b>');
      out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<i>$2</i>');
      out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
      return out;
    })
    .join('');
}

/**
 * 受管图片 token 抽取 — 逐字符线性扫描(与 discord/markdown.ts 同实现思路,
 * 规避 `!\[...\]\(...\)` 正则在长行上的多项式回溯)。
 */
function extractImageTokens(
  line: string,
  onUrl: (url: string) => void,
): { text: string; found: boolean } {
  let out = '';
  let found = false;
  let i = 0;
  let knownAltEnd = -1;
  let knownClose = -1;
  while (i < line.length) {
    const start = line.indexOf('![', i);
    if (start === -1) {
      out += line.slice(i);
      break;
    }
    if (knownAltEnd < start + 2) knownAltEnd = line.indexOf(']', start + 2);
    if (knownAltEnd === -1) {
      out += line.slice(i);
      break;
    }
    const altEnd = knownAltEnd;
    const urlStart = altEnd + 2;
    let schemeLen = 0;
    if (line.charCodeAt(altEnd + 1) === 0x28 /* ( */) {
      if (line.startsWith('xdt-image://', urlStart)) schemeLen = 'xdt-image://'.length;
      else if (line.startsWith('cindy-media://', urlStart)) schemeLen = 'cindy-media://'.length;
    }
    if (schemeLen === 0) {
      out += line.slice(i, start + 2);
      i = start + 2;
      continue;
    }
    if (knownClose < urlStart + schemeLen) knownClose = line.indexOf(')', urlStart + schemeLen);
    if (knownClose === -1) {
      out += line.slice(i);
      break;
    }
    if (knownClose === urlStart + schemeLen) {
      out += line.slice(i, start + 2);
      i = start + 2;
      continue;
    }
    out += line.slice(i, start);
    onUrl(line.slice(urlStart, knownClose));
    found = true;
    i = knownClose + 1;
  }
  return { text: out, found };
}
