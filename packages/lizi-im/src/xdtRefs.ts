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

export const XDT_IMAGE_REGEX = /!\[([^\]]*)\]\(((?:xdt-image|cindy-media):\/\/[^)]+)\)/g;
export const XDT_FILE_REGEX = /\[([^\]]*)\]\((xdt-file:\/\/[^)]+)\)/g;

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
  return text
    .replace(XDT_IMAGE_REGEX, (_m, alt) => `[🖼️ ${alt || '图片'} · 上传中...]`)
    .replace(XDT_FILE_REGEX, (_m, alt, url) => {
      const display = alt || path.basename(xdtFileUrlToAbsPath(url));
      return `[📎 ${display} · 准备发送...]`;
    });
}

/** Detect if `text` is essentially "only xdt refs" (no real prose). Used for
 *  picking a friendlier placeholder during streaming. */
export function classifyXdtOnly(
  text: string,
): 'image-only' | 'file-only' | 'mixed-or-text' {
  const trimmed = text.replace(XDT_IMAGE_REGEX, '').replace(XDT_FILE_REGEX, '').trim();
  if (trimmed.length > 0) return 'mixed-or-text';
  const hasImg = XDT_IMAGE_REGEX.test(text);
  // Reset lastIndex (regex with /g is stateful) before testing again.
  XDT_IMAGE_REGEX.lastIndex = 0;
  const hasFile = XDT_FILE_REGEX.test(text);
  XDT_FILE_REGEX.lastIndex = 0;
  if (hasImg && !hasFile) return 'image-only';
  if (hasFile && !hasImg) return 'file-only';
  return 'mixed-or-text';
}

/** Remove xdt-file links entirely (since they're delivered as separate file messages). */
export function stripXdtFileLinks(text: string): string {
  return text.replace(XDT_FILE_REGEX, '');
}

export interface XdtFileLink {
  alt: string;
  absPath: string;
}

/** Collect xdt-file links from text, deduped by absPath (model often repeats). */
export function collectXdtFileLinks(text: string): XdtFileLink[] {
  const seen = new Map<string, XdtFileLink>();
  for (const m of text.matchAll(XDT_FILE_REGEX)) {
    const absPath = xdtFileUrlToAbsPath(m[2]);
    if (seen.has(absPath)) continue;
    seen.set(absPath, { alt: m[1] || '', absPath });
  }
  return Array.from(seen.values());
}

/** Collect unique xdt-image URLs from text. */
export function collectXdtImageUrls(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(XDT_IMAGE_REGEX)) {
    set.add(m[2]);
  }
  return Array.from(set);
}
