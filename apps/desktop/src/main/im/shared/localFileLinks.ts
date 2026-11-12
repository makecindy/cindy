import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Definition } from 'mdast';

import { resolveAllowedOutboundFile } from '@cindy/im';

const parser = unified().use(remarkParse).use(remarkGfm);

/** A scheme the IM recipient can open. A single letter is a Windows drive, `file:` is this computer. */
function isOpenableTarget(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(url)?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== 'file';
}

/**
 * Cheap superset of what `unlinkLocalFileLinks` rewrites: a link or definition
 * target without an openable scheme, a `file:` target, or a `<file:` autolink.
 * Streaming calls this on every delta, so replies with only web links (or none)
 * must not pay for a Markdown parse.
 */
const MAY_HAVE_LOCAL_LINK =
  /\][(:](?!\s*<?[a-z][a-z0-9+.-]+:)|\][(:]\s*<?file:|<file:/i;

/**
 * IM recipients cannot open this computer's files, and channels without
 * Markdown links show `[label](</abs/path>)` verbatim. Keep only the label of
 * links to local paths, relative paths or `file:` URLs. Images, managed media
 * and attachment links (`xdt-file://`) carry a scheme and stay for the
 * channel's own delivery; code examples are not links in the AST.
 */
export function unlinkLocalFileLinks(text: string): string {
  if (!MAY_HAVE_LOCAL_LINK.test(text)) return text;
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const imageDefinitions = new Set<string>();
  visit(tree, 'imageReference', (node) => {
    imageDefinitions.add(node.identifier);
  });
  const edits: { start: number; end: number }[] = [];
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const url = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
    if (url === undefined || isOpenableTarget(url)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const first = node.children[0]?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    if (first === undefined || last === undefined) edits.push({ start, end });
    else edits.push({ start, end: first }, { start: last, end });
  });
  visit(tree, 'definition', (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (isOpenableTarget(node.url) || imageDefinitions.has(node.identifier)) return;
    if (start !== undefined && end !== undefined) edits.push({ start, end });
  });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + result.slice(edit.end);
  }
  return result;
}

export interface LocalFileLink {
  /** Markdown link target (relative path, absolute path or `file:` URL). */
  url: string;
  /** Human label the assistant wrote; used for the attachment name fallback. */
  label: string;
}

/**
 * 回答里指向本机文件的链接（相对/绝对路径、`file:` URL）。
 *
 * 与 `unlinkLocalFileLinks` 用同一份 AST 判据：有可打开 scheme 的（http/https、
 * `xdt-file://`、`cindy-media://` 等）不在这里；图片引用（`![]()`）也不是文件链接。
 * 这些链接**不能**直接交给渠道当文本发（对方打不开本机路径），也不该要求模型改用
 * `xdt-file://`：宿主在发送前解析成受控附件，再由文件通道交付。
 */
export function collectLocalFileLinks(text: string): LocalFileLink[] {
  if (!MAY_HAVE_LOCAL_LINK.test(text)) return [];
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const links: LocalFileLink[] = [];
  const seen = new Set<string>();
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const url = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
    if (url === undefined || isOpenableTarget(url)) return;
    const label = node.children
      .map((child) => ('value' in child && typeof child.value === 'string' ? child.value : ''))
      .join('')
      .trim();
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ url, label });
  });
  return links;
}

export interface LocalFileAttachment {
  /** Canonical absolute path (realpath'd, verified inside the approved roots). */
  absPath: string;
  displayName: string;
}

/**
 * 把回答里的本机文件链接解析成**受控附件**。
 *
 * - 相对路径以**任务工作目录**为基准（不是进程 cwd），绝对路径原样尝试；
 * - 统一走 `resolveAllowedOutboundFile`：realpath + 包含判定，越界（含符号链接逃逸）
 *   或文件不存在一律丢弃 —— 不把任意本地路径当成已批准附件；
 * - 外部 http(s) 链接不在收集范围内（有 scheme），继续作为文本链接保留；
 * - 非媒体文件（PDF/docx/zip…）由文件通道交付，不进媒体总仓。
 *
 * `baseDir` 取该轮的工作目录（渠道 root 就是它）；SSH/远程任务的 root 为空，此时
 * 相对/绝对本地链接都无法在本机验证，直接不产生附件。
 */
export async function resolveLocalFileAttachments(args: {
  text: string;
  baseDir: string;
  allowedRoots: readonly string[];
  resolveAllowed?: typeof resolveAllowedOutboundFile;
}): Promise<LocalFileAttachment[]> {
  const resolveAllowed = args.resolveAllowed ?? resolveAllowedOutboundFile;
  if (args.allowedRoots.length === 0) return [];
  const attachments: LocalFileAttachment[] = [];
  const seen = new Set<string>();
  for (const link of collectLocalFileLinks(args.text)) {
    const candidate = localTargetPath(link.url, args.baseDir);
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const allowed = await resolveAllowed(candidate, args.allowedRoots);
    if (!allowed) continue;
    attachments.push({
      absPath: allowed,
      displayName: link.label.trim() || path.basename(allowed),
    });
  }
  return attachments;
}

/** 相对/绝对路径或 `file:` URL → 待校验的绝对路径; 其余（含带查询/锚点）返回 null。 */
function localTargetPath(url: string, baseDir: string): string | null {
  // 裸 `?`/`#` 在 Markdown 目标是查询/锚点, 不属于可交付的本地路径。
  if (!url || url.includes('?') || url.includes('#')) return null;
  // `file:` 目标**直接交给 URL 解析器**: `%23`/`%3F`/`%25` 这些百分号编码由它处理。
  // 先 decode 再当 URL 解析会把 `%23` 变成锚点, 从而指向同目录里被截断的同名文件。
  if (/^file:/i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  if (path.isAbsolute(decoded)) return decoded;
  if (!baseDir.trim()) return null;
  return path.resolve(baseDir, decoded);
}
