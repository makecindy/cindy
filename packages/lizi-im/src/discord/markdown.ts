import { collectXdtImageRefs, transformXdtRefs } from '../xdtRefs.js';

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

function extractXdtImageLines(segment: string, imageUrls: string[]): string {
  const lines = segment.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    // 双协议:老 xdt-image + 媒体总仓 cindy-media。复用共享解析器:线性扫描,
    // 且未闭合引用不会吞掉其后的合法图片与正文。
    const refs = collectXdtImageRefs(line);

    if (refs.length > 0) {
      for (const ref of refs) imageUrls.push(ref.url);
      const withoutXdtImages = transformXdtRefs(line, { image: () => '' });
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
