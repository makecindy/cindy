import { GHOST_MANUAL_ENTRY_FILE } from '../../shared/ghost.js';

// eslint-disable-next-line no-control-regex -- Markdown 只允许换行/制表等文本控制符。
const FORBIDDEN_MARKDOWN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- 逻辑路径与制品相对路径都拒绝 C0/DEL 和反斜杠。
const FORBIDDEN_MANUAL_PATH_CHAR_RE = /[\u0000-\u001f\u007f\\]/;

export const GHOST_MANUAL_LOGICAL_PATH_MAX_CHARS = 1024;

/**
 * ghost_manual 的逻辑调用路径判据。不做 URL decode，只接受 `/` 分段。
 */
export function parseGhostManualLogicalPath(rawPath: string): string[] | null {
  if (rawPath.length === 0 || rawPath.length > GHOST_MANUAL_LOGICAL_PATH_MAX_CHARS) return null;
  if (FORBIDDEN_MANUAL_PATH_CHAR_RE.test(rawPath)) return null;
  const segments = rawPath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

/**
 * 三侧共用的制品路径裁判。relativePath 永远使用 ZIP/manifest 的 `/`；目录可任意深，
 * 文件必须是 Markdown，并且映射后的完整逻辑调用路径必须可被 ghost_manual 原样读取。
 */
export function ghostManualLogicalPathForEntry(
  itemName: string,
  relativePath: string,
  kind: 'directory' | 'file',
): string | null {
  if (parseGhostManualLogicalPath(relativePath) === null) return null;
  if (kind === 'file' && !isGhostManualMarkdownFile(relativePath)) return null;
  const logicalPath =
    kind === 'file' && relativePath === GHOST_MANUAL_ENTRY_FILE
      ? itemName
      : `${itemName}/${relativePath}`;
  return parseGhostManualLogicalPath(logicalPath) === null ? null : logicalPath;
}

/** manual 单元内只允许普通 Markdown 文件。扩展名按跨平台文件系统语义折叠大小写。 */
export function isGhostManualMarkdownFile(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.md');
}

/** 严格 UTF-8 解码，并拒绝 Markdown 正文不应包含的二进制控制字节。 */
export function decodeGhostManualMarkdown(
  bytes: Uint8Array,
): { ok: true; content: string } | { ok: false; reason: string } {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: '不是合法 UTF-8 文本' };
  }
  if (FORBIDDEN_MARKDOWN_CONTROL_RE.test(content)) {
    return { ok: false, reason: '包含二进制控制字符' };
  }
  return { ok: true, content };
}
