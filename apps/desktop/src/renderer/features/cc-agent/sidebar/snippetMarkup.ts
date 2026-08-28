/**
 * 搜索 snippet 的 `<mark>` 哨兵协议解析。
 *
 * 生产端（buildSnippetFromContent）会把原文里的 `<` / `>` / `&` 转成实体后再
 * 插入 `<mark>`。消费端必须先按哨兵切开，再把实体还原，否则用户内容里的真
 * `<mark>` 会被当成控制标记，展示被改写。
 *
 * 不要 trim：窗边缘的原文空格也是用户内容。
 */
export interface SnippetPart {
  text: string;
  marked: boolean;
}

export function parseSnippetMarkup(snippet: string | null | undefined): SnippetPart[] | null {
  if (snippet == null || snippet === '') return null;
  const parts = snippet.split(/(<\/?mark>)/g);
  const hasMarkup = parts.some((part) => part === '<mark>' || part === '</mark>');
  // 侧栏 preview/snippet 是原文切片，没有哨兵协议。没有 <mark> 时原样返回，
  // 不能把字面量 &lt; 解成 <。
  if (!hasMarkup) return [{ text: snippet, marked: false }];
  const out: SnippetPart[] = [];
  let marked = false;
  for (const part of parts) {
    if (!part) continue;
    if (part === '<mark>') {
      marked = true;
      continue;
    }
    if (part === '</mark>') {
      marked = false;
      continue;
    }
    out.push({ text: unescapeSnippetText(part), marked });
  }
  return out.length > 0 ? out : null;
}

/** 还原 buildSnippetFromContent 写入的 HTML 实体，让原文 `<` / `>` / `&` 原样展示。 */
export function unescapeSnippetText(text: string): string {
  // 必须先还原 &lt; / &gt;，再还原 &amp;：原文 "&lt;" 编码后是 "&amp;lt;"，
  // 先解 lt 碰不到它（中间夹着 amp;），再解 amp 才得到字面量 "&lt;"。
  // 若先解 amp，会把 "&amp;lt;" 变成 "&lt;" 再被解成 "<"，原文实体就丢了。
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
