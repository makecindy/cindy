/**
 * orcaImageAttachments.ts — Orca 派发工具(images 参数)的图片地址解析。
 *
 * Lead 模型手里的图片来源有两类:
 *   1. 会话里用户贴的图 — 上下文里是受管地址(cindy-media://blobs/ 或
 *      xdt-image://,由 cindy-host-image-references 注入),经既有
 *      resolveGhostAttachmentUrl 归一化为本地文件;
 *   2. Lead 自己生成/落盘的文件 — 任意本机绝对路径。
 * 两者都收敛到「可读的图片文件」;非图片(视频/音频 blob)一律拒绝。
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveGhostAttachmentUrl } from '../mcp-integrations/ghostAttachmentResolve.js';

/** 任意绝对路径回落的图片扩展名白名单(受管地址分支由 blobStore/缓存校验)。 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 模型给的一条 images 入参 → 可读图片文件;无法解析则 null(不抛)。 */
export function resolveOrcaImageAttachmentInput(
  input: string,
): { absPath: string; mimeType: string } | null {
  let resolved: { absPath: string; mimeType: string } | null = null;
  try {
    const grantResolved = resolveGhostAttachmentUrl(input);
    resolved = { absPath: grantResolved.absPath, mimeType: grantResolved.mimeType };
  } catch {
    resolved = null;
  }
  if (!resolved && typeof input === 'string' && !input.includes('\0') && path.isAbsolute(input)) {
    const mimeType = MIME_BY_EXT[path.extname(input).toLowerCase()];
    if (mimeType) {
      try {
        if (fs.statSync(input).isFile()) resolved = { absPath: input, mimeType };
      } catch {
        // 不存在/不可读 → 保持 null
      }
    }
  }
  if (!resolved || !resolved.mimeType.startsWith('image/')) return null;
  return resolved;
}
