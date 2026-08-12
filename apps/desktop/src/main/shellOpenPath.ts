/** Resolve user-openable local paths without exposing media-store paths to renderer. */

import path from 'node:path';

import * as cindyMediaBlobStore from './cindy-media/blobStore.js';

/**
 * Chat history persists managed media as a stable `cindy-media://` reference.
 * Resolve that reference inside main immediately before a user-initiated OS
 * open; ordinary callers retain the existing absolute-path contract.
 */
export function resolveShellOpenPathTarget(value: string): string | null {
  if (!value) return null;
  // path.normalize 把正斜杠 Windows 路径(`C:/x/a.docx`,常见于模型输出与命令
  // 文本)折成本机分隔符:shell.openPath 对「正斜杠 + 仅用户层文件关联」的组合
  // 解析失败,showItemInFolder 对正斜杠更是静默无反应。POSIX 上是幂等操作。
  if (path.isAbsolute(value)) return path.normalize(value);
  if (value.startsWith('cindy-media://')) return cindyMediaBlobStore.resolveSafe(value).absPath;
  return null;
}
