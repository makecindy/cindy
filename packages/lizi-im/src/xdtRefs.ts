/**
 * xdtRefs.ts — `xdt-image://` / `xdt-file://` 引用解析(渠道无关)。
 * ---------------------------------------------------------------------------
 * agent 文本里嵌的 xdt-* markdown 引用在各渠道的流式/收尾处理是同一套语义:
 *   - 中间帧: 替换成占位文本(渠道不接受裸 xdt-* URL)
 *   - finalize: 图片上传到渠道、文件单独发消息、正文剥掉 file 链接
 * 本模块只做纯文本解析, 上传/发送由各渠道 streamingText 自己实现。
 *
 * 引用形态(与 legacy feishuBot/replyClient.ts 对齐):
 *   图片  `![alt](xdt-image://...)` 或 `![alt](cindy-media://...)`(媒体总仓
 *         当前地址,生成图与集成图片均为此形态)
 *   文件  `[name](xdt-file:///abs/path)`
 */

import path from 'node:path';

export interface XdtImageRef {
  alt: string;
  url: string;
  start: number;
  end: number;
}

interface ParsedXdtRef extends XdtImageRef {
  kind: 'image' | 'file';
}

/**
 * Parse managed-media Markdown in one forward pass. Model output is
 * uncontrolled input, so this deliberately avoids the former global regexes:
 * repeated near-matches could make the regex engine rescan a long suffix.
 */
function parseXdtRefs(text: string): ParsedXdtRef[] {
  const refs: ParsedXdtRef[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openBracket = text.indexOf('[', cursor);
    if (openBracket === -1) break;

    const image = openBracket > 0 && text[openBracket - 1] === '!';
    const start = image ? openBracket - 1 : openBracket;
    const altStart = openBracket + 1;
    let altEnd = altStart;
    while (
      altEnd < text.length &&
      text[altEnd] !== '[' &&
      !(text[altEnd] === ']' && text[altEnd + 1] === '(')
    ) {
      altEnd += 1;
    }

    // A nested opening bracket supersedes the malformed outer candidate. This
    // both preserves later valid refs and keeps the scan strictly forward.
    if (text[altEnd] === '[') {
      cursor = altEnd;
      continue;
    }
    if (altEnd >= text.length) break;

    const urlStart = altEnd + 2;
    const scheme = image
      ? text.startsWith('xdt-image://', urlStart)
        ? 'xdt-image://'
        : text.startsWith('cindy-media://', urlStart)
          ? 'cindy-media://'
          : null
      : text.startsWith('xdt-file://', urlStart)
        ? 'xdt-file://'
        : null;
    if (!scheme) {
      cursor = urlStart;
      continue;
    }

    const endParen = text.indexOf(')', urlStart + scheme.length);
    if (endParen === -1) break;
    if (endParen > urlStart + scheme.length) {
      refs.push({
        kind: image ? 'image' : 'file',
        alt: text.slice(altStart, altEnd),
        url: text.slice(urlStart, endParen),
        start,
        end: endParen + 1,
      });
    }
    cursor = endParen + 1;
  }

  return refs;
}

function replaceXdtRefs(
  text: string,
  refs: ReadonlyArray<ParsedXdtRef>,
  replacement: (ref: ParsedXdtRef) => string,
): string {
  if (refs.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    parts.push(text.slice(cursor, ref.start), replacement(ref));
    cursor = ref.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** xdt-file://<absPath> → absPath (URL-decoded). */
export function xdtFileUrlToAbsPath(url: string): string {
  const raw = url.replace(/^xdt-file:\/\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  // 约定写法 xdt-file:///<绝对路径>:Unix 下剥协议后的首个 `/` 就是根;
  // Windows 盘符路径剥完剩 `/C:\...`(或 /C:/...),多余前导 `/` 会让下游
  // 存在性检查 / 目录白名单比对失败 → 文件静默丢失(2026-07-16 hook 渠道
  // 实踩)。与 hook-control/outbound.ts 的副本同步修改。
  return decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
}

/** Replace xdt-* refs with placeholder text suitable for intermediate frames. */
export function stripXdtForStreaming(text: string): string {
  const refs = parseXdtRefs(text);
  return replaceXdtRefs(text, refs, (ref) => {
    if (ref.kind === 'image') return `[🖼️ ${ref.alt || '图片'} · 上传中...]`;
    const display = ref.alt || path.basename(xdtFileUrlToAbsPath(ref.url));
    return `[📎 ${display} · 准备发送...]`;
  });
}

/** Detect if `text` is essentially "only xdt refs" (no real prose). Used for
 *  picking a friendlier placeholder during streaming. */
export function classifyXdtOnly(
  text: string,
): 'image-only' | 'file-only' | 'mixed-or-text' {
  const refs = parseXdtRefs(text);
  const trimmed = replaceXdtRefs(text, refs, () => '').trim();
  if (trimmed.length > 0) return 'mixed-or-text';
  const hasImg = refs.some((ref) => ref.kind === 'image');
  const hasFile = refs.some((ref) => ref.kind === 'file');
  if (hasImg && !hasFile) return 'image-only';
  if (hasFile && !hasImg) return 'file-only';
  return 'mixed-or-text';
}

/** Remove xdt-file links entirely (since they're delivered as separate file messages). */
export function stripXdtFileLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'file');
  return replaceXdtRefs(text, refs, () => '');
}

/** Remove managed-image Markdown after it has been delivered as media. */
export function stripXdtImageLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'image');
  return replaceXdtRefs(text, refs, () => '');
}

export interface XdtFileLink {
  alt: string;
  absPath: string;
}

/** Collect xdt-file links from text, deduped by absPath (model often repeats). */
export function collectXdtFileLinks(text: string): XdtFileLink[] {
  const seen = new Map<string, XdtFileLink>();
  for (const ref of parseXdtRefs(text)) {
    if (ref.kind !== 'file') continue;
    const absPath = xdtFileUrlToAbsPath(ref.url);
    if (seen.has(absPath)) continue;
    seen.set(absPath, { alt: ref.alt, absPath });
  }
  return Array.from(seen.values());
}

/** Collect managed-image refs in source order, including text offsets. */
export function collectXdtImageRefs(text: string): XdtImageRef[] {
  return parseXdtRefs(text)
    .filter((ref) => ref.kind === 'image')
    .map(({ alt, url, start, end }) => ({ alt, url, start, end }));
}

/** Collect unique xdt-image URLs from text. */
export function collectXdtImageUrls(text: string): string[] {
  const set = new Set<string>();
  for (const ref of collectXdtImageRefs(text)) set.add(ref.url);
  return Array.from(set);
}
