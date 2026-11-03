/**
 * inboundKind.ts — 入站附件分流的**唯一判据**(各渠道共用)。
 *
 * 不变量: 一个入站附件只由 `classifyInboundAttachment` 判一次去处 ——
 *   - image: 进 host 媒体总仓(cacheImage);
 *   - av:    进 host 媒体总仓(cacheMedia);
 *   - file:  交 host 文件暂存(IMHost.files)。
 * 图片与音视频收不收由总仓按白名单与真实字节决定, 拒收即标不支持, 不回落文件
 * 暂存。平台给的 MIME 经常是空或 `application/octet-stream`, 所以 MIME 与扩展名
 * 任一命中即归类, 并给出交给总仓的 MIME。
 */

import path from 'node:path';

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const AV_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
};

export type InboundKind =
  | { kind: 'image'; mimeType: string }
  | { kind: 'av'; mimeType: string }
  | { kind: 'file'; mimeType: string };

function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

export function classifyInboundAttachment(
  mime: string | null | undefined,
  fileName: string | null | undefined,
): InboundKind {
  const normalized = normalizeMime(mime);
  if (normalized.startsWith('image/')) return { kind: 'image', mimeType: normalized };
  if (normalized.startsWith('video/') || normalized.startsWith('audio/')) {
    return { kind: 'av', mimeType: normalized };
  }
  const ext = path.extname(fileName ?? '').toLowerCase();
  const image = IMAGE_MIME_BY_EXT[ext];
  if (image) return { kind: 'image', mimeType: image };
  const av = AV_MIME_BY_EXT[ext];
  if (av) return { kind: 'av', mimeType: av };
  return { kind: 'file', mimeType: normalized || 'application/octet-stream' };
}

/** 音视频 → 交给总仓的 MIME; 不是音视频返回 null(classifyInboundAttachment 的便捷形)。 */
export function audioVideoMimeOf(
  mime: string | null | undefined,
  fileName: string | null | undefined,
): string | null {
  const classified = classifyInboundAttachment(mime, fileName);
  return classified.kind === 'av' ? classified.mimeType : null;
}
