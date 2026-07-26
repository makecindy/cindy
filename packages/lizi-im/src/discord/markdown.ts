interface Segment {
  kind: 'code' | 'text';
  content: string;
}

export function markdownToDiscord(md: string): { text: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  const text = splitByCodeFence(md)
    .map((segment) =>
      segment.kind === 'code' ? segment.content : convertTextSegment(segment.content, imageUrls),
    )
    .join('');

  return { text, imageUrls };
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

function convertTextSegment(segment: string, imageUrls: string[]): string {
  const withoutXdtImages = extractXdtImageLines(segment, imageUrls);
  const withoutHtml = stripHtmlTags(withoutXdtImages);
  return wrapTables(withoutHtml);
}

/**
 * `line.replace(/!\[[^\]]*]\(((?:xdt-image|cindy-media):\/\/[^)]+)\)/g, ...)` 的
 * 线性扫描等价实现。原正则在「大量 `![` 前缀」的长行上会 O(n²) 回溯
 * （CodeQL js/polynomial-redos）；这里用单调前进的 `]`/`)` 查找指针保证线性。
 */
function extractImageTokens(line: string, onUrl: (url: string) => void): { text: string; found: boolean } {
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
      // 后面再无 ']',不可能闭合 alt,剩余原样保留
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
      // 该 '![' 不构成图片引用,跳过它继续找下一个
      out += line.slice(i, start + 2);
      i = start + 2;
      continue;
    }
    if (knownClose < urlStart + schemeLen) knownClose = line.indexOf(')', urlStart + schemeLen);
    if (knownClose === -1) {
      // 后面再无 ')',任何后续引用都闭合不了,剩余原样保留
      out += line.slice(i);
      break;
    }
    if (knownClose === urlStart + schemeLen) {
      // '://' 后紧跟 ')',URL 主体为空,原正则([^)]+)不算命中
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

function extractXdtImageLines(segment: string, imageUrls: string[]): string {
  const lines = segment.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    // 双协议:老 xdt-image + 媒体总仓 cindy-media(与 xdtRefs.XDT_IMAGE_REGEX 口径一致)。
    const { text: withoutXdtImages, found: hasXdtImage } = extractImageTokens(line, (url) => {
      imageUrls.push(url);
    });

    if (hasXdtImage) {
      const cleanedLine = withoutXdtImages.replace(/[ \t]{2,}/g, ' ').trim();
      if (cleanedLine.length > 0) {
        kept.push(cleanedLine);
      }
    } else {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function stripHtmlTags(text: string): string {
  // 属性区排除 '<':消除跨标签起点的 O(n²) 回溯(CodeQL js/polynomial-redos)。
  // 循环剥到稳定:单次替换会把 "<scr<x>ipt>" 剩成 "<script>"(js/incomplete-multi-character-sanitization)。
  let prev = text;
  for (;;) {
    const next = prev.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g, '');
    if (next === prev) return next;
    prev = next;
  }
}

function wrapTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (isTableStart(lines, i)) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;

      while (i < lines.length && isTableBodyLine(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;

      out.push('```', ...tableLines, '```');
      continue;
    }

    out.push(lines[i]);
  }

  return out.join('\n');
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableBodyLine(lines[index]) && isTableSeparatorLine(lines[index + 1] ?? '');
}

function isTableBodyLine(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

function isTableSeparatorLine(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
