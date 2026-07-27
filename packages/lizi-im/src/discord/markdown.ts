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
  // Single-pass linear scan. Strips HTML tags while preserving autolinks like
  // <https://...>. Also strips nested/malicious fragments like "<scr<x>ipt>"
  // (where removing inner tags would reassemble a valid tag) in one pass,
  // without the O(n²) repeat-until-stable loop.
  const len = text.length;
  let out = '';
  let i = 0;
  while (i < len) {
    if (text.charCodeAt(i) !== 0x3c /* < */) {
      out += text[i];
      i += 1;
      continue;
    }
    // Potential tag start — probe ahead without consuming
    let j = i + 1;
    // Optional '/' for closing tags
    if (j < len && text.charCodeAt(j) === 0x2f) j += 1;
    // Tag name: [A-Za-z][A-Za-z0-9-]*
    const nameStart = j;
    if (j < len && isAsciiAlpha(text.charCodeAt(j))) {
      j += 1;
      while (j < len && isTagNameChar(text.charCodeAt(j))) j += 1;
    }
    if (j === nameStart) {
      out += '<';
      i += 1;
      continue;
    }
    // After tag name, check what follows
    const afterName = j < len ? text.charCodeAt(j) : 0;
    if (afterName === 0x3a /* : */) {
      // URI scheme (autolink like <https://...>) — preserve literally
      out += '<';
      i += 1;
      continue;
    }
    if (afterName === 0x3c /* < */) {
      // Nested fragment (e.g. <scr<x>ipt>) — strip to first '>'
      while (j < len && text.charCodeAt(j) !== 0x3e) j += 1;
      if (j >= len) {
        // No '>' in the remainder — emit rest literally (avoids O(n²) rescan)
        out += text.slice(i);
        i = len;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (afterName === 0x2f /* / */) {
      // Self-closing only if '/' is immediately followed by '>' (e.g. <br/>)
      if (j + 1 < len && text.charCodeAt(j + 1) === 0x3e) {
        i = j + 2;
      } else {
        // Not self-closing (e.g. <owner/repo>) — preserve literally
        out += '<';
        i += 1;
      }
      continue;
    }
    if (afterName === 0x3e || afterName === 0x20 || afterName === 0x09 ||
        afterName === 0x0a || afterName === 0x0c || afterName === 0x0d) {
      // Valid HTML tag — scan for '>', also stop at '<' to stay O(n)
      while (j < len && text.charCodeAt(j) !== 0x3e && text.charCodeAt(j) !== 0x3c) j += 1;
      if (j < len && text.charCodeAt(j) === 0x3e) {
        i = j + 1;
      } else if (j >= len) {
        // End-of-string — no closing '>', emit rest literally (avoids O(n²))
        out += text.slice(i);
        i = len;
      } else {
        // Hit another '<' — malformed/nested tag, skip the outer '<' to
        // prevent reassembly (e.g. "<div <script>" → strip "<div ")
        i = j;
      }
      continue;
    }
    // Unknown char after name (not a tag) — emit '<' literally
    out += '<';
    i += 1;
  }
  return out;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isTagNameChar(c: number): boolean {
  return isAsciiAlpha(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
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
