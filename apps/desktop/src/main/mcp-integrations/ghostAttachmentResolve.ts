/**
 * ghostAttachmentResolve.ts — ghost 附件过户的地址解析(单独成模块便于单测,
 * 规则 14:不拖 ghost.ts 的 ledger / forge 等重依赖)。
 *
 * 三层归一化:
 *   1. imageCacheStore.resolveSessionImageLenient —— 规范 xdt-image 地址、
 *      缓存内绝对路径、丢会话段地址(历史会话图缓存);
 *   2. 媒体总仓 blob —— 聊天附件或当前 Agent 工具结果进入总仓(cindy-media)后,
 *      落盘身份就是总仓 blob,模型手里的地址是 blob 绝对路径(prompt 附件
 *      路径透传)或 cindy-media://blobs/ 地址。绝对路径按文件名解出指纹后
 *      用 resolveHashRef 反推规范路径逐字节比对(分桶目录 = 指纹前两位),
 *      杜绝构造路径;媒体类型与扩展名由 blobStore 白名单和账本共同约束;
 *   3. maker-core 缩图缓存(默认 os.tmpdir()/maker-core-image-resize)——
 *      大图(典型:截图)送进模型前被 image-resizer 透明替换为缩图副本,
 *      prompt 里的 @mention 只有副本路径(claude-code/index.ts),模型手上
 *      根本没有原图地址,不认它,"发大图让意识改"必挂。只认恰好一级深、
 *      真实存在的文件,不放宽其它任何边界(该目录只含已送入模型的图片的
 *      降采样副本)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { getDefaultImageResizer } from '@cindy/maker-core';

import { getBlobsRoot, parseBlobUrl, resolveHashRef } from '../cindy-media/blobStore.js';
import { resolveSessionImageLenient } from '../imageCacheStore.js';

/** 缩图缓存路径可过户的图片扩展 → mime(该目录实际只产 .webp,其余留冗余)。 */
const RESIZE_CACHE_MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/**
 * 媒体总仓 blob 的两种写法 → 磁盘位置;不合格返回 null(由调用方回落其它层)。
 * 两种写法都收敛到 resolveHashRef 的规范校验(指纹 64 位 hex + 扩展名白名单 +
 * 落在字节仓内的前缀双保险);绝对路径额外要求与按指纹反推的规范路径完全一致
 * (win32 大小写不敏感比较),文件必须真实存在。类型由 resolveHashRef 白名单判定。
 */
function resolveCindyMediaBlob(
  input: string,
): { absPath: string; mimeType: string; blobHash: string } | null {
  let hash: string;
  let ext: string;
  const fromUrl = parseBlobUrl(input);
  if (fromUrl) {
    ({ hash, ext } = fromUrl);
  } else {
    if (!path.isAbsolute(input)) return null;
    const abs = path.resolve(input);
    const rel = path.relative(path.resolve(getBlobsRoot()), abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return null;
    const dotIdx = parts[1].lastIndexOf('.');
    if (dotIdx <= 0) return null;
    hash = parts[1].slice(0, dotIdx).toLowerCase();
    ext = parts[1].slice(dotIdx).toLowerCase();
  }
  let canonical: { absPath: string; mimeType: string };
  try {
    canonical = resolveHashRef(hash, ext);
  } catch {
    return null;
  }
  if (!fromUrl) {
    // 分桶目录必须等于指纹前两位:与规范路径比对,而不是信任传入路径。
    const abs = path.resolve(input);
    const eq =
      process.platform === 'win32'
        ? canonical.absPath.toLowerCase() === abs.toLowerCase()
        : canonical.absPath === abs;
    if (!eq) return null;
  }
  if (!fs.existsSync(canonical.absPath)) return null;
  return { absPath: canonical.absPath, mimeType: canonical.mimeType, blobHash: hash };
}

/**
 * 返回值的 blobHash:仅当经媒体总仓 blob 层解析时携带——调用方(ghost.ts
 * 接线)据此对 blob 形态附件加账本出生闸(attachmentGrantGate),会话图缓存 /
 * 缩图缓存两层不带(它们的可达面天然限于"进过会话的图")。
 */
export function resolveGhostAttachmentUrl(
  input: string,
): { absPath: string; mimeType: string; blobHash?: string } {
  try {
    return resolveSessionImageLenient(input);
  } catch (err) {
    if (typeof input === 'string' && !input.includes('\0')) {
      const blob = resolveCindyMediaBlob(input);
      if (blob) return blob;
    }
    if (typeof input === 'string' && !input.includes('\0') && path.isAbsolute(input)) {
      const resizeDir = path.resolve(getDefaultImageResizer().cacheDir);
      const absPath = path.resolve(input);
      const rel = path.relative(resizeDir, absPath);
      if (
        rel !== '' &&
        !rel.startsWith('..') &&
        !path.isAbsolute(rel) &&
        !rel.includes(path.sep) &&
        fs.existsSync(absPath)
      ) {
        const mime = RESIZE_CACHE_MIME_BY_EXT[path.extname(absPath).toLowerCase()];
        return { absPath, mimeType: mime ?? 'application/octet-stream' };
      }
    }
    throw err;
  }
}
