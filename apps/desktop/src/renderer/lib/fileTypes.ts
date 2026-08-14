/**
 * fileTypes.ts
 * ---------------------------------------------------------------------------
 * File type utilities for the attachment system (F-FI-2).
 * Centralizes supported extensions, MIME mapping, categorization, and
 * batch validation logic.
 *
 * 文本扩展名白名单 (SUPPORTED_TEXT_EXTS / COMPOUND_EXTS / KNOWN_TEXT_FILENAMES)
 * 抽到了 ../../shared/textFileExts 让 main 进程的 RipgrepSearcher 也能复用,
 * 避免搜索范围跟附件支持的范围出现漂移。这里 re-export 是为了让所有
 * `@/lib/fileTypes` 的现存 import 不用改。
 */

import {
  SUPPORTED_TEXT_EXTS,
  COMPOUND_EXTS,
  KNOWN_TEXT_FILENAMES,
} from '../../shared/textFileExts';

// ── Supported extension sets ──

export const SUPPORTED_IMAGE_EXTS = new Set([
  '.jpeg', '.jpg', '.png', '.gif', '.webp',
]);

export const SUPPORTED_DOC_EXTS = new Set(['.pdf']);

export const SUPPORTED_OFFICE_EXTS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

export { SUPPORTED_TEXT_EXTS, COMPOUND_EXTS };

/**
 * Well-known filenames with no extension that map to 'text' category.
 * Keys are lowercase. 由 shared/textFileExts 中的 KNOWN_TEXT_FILENAMES 派生,
 * 保证搜索 glob 和附件分类用同一份名单。
 */
export const KNOWN_FILENAME_MAP: Record<string, FileCategory> = Object.fromEntries(
  Array.from(KNOWN_TEXT_FILENAMES, (name) => [name, 'text' as const]),
);

// ── Types ──

export type FileCategory = 'image' | 'pdf' | 'text' | 'office' | 'file';

export interface AttachedFileInput {
  name: string;
  path: string;
  size: number;
  ext: string;
  category: FileCategory;
  mimeType: string;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  category: FileCategory;
  mimeType: string;
  /**
   * image-local-cache: xdt-image:// url to the cached file. The primary
   * source for image rendering and SDK send. Undefined only when the
   * cache write failed and we fell back to in-memory base64 (F6).
   */
  url?: string;
  /**
   * image-local-cache: original filename (used by the missing-image
   * placeholder UI and as `originalName` in persisted ImageRef).
   */
  originalName?: string;
  /**
   * image: present only as F6 fallback after a failed cache write.
   *
   * @deprecated for file attachments: as of attachment-path-passthrough, new
   * attachments no longer carry base64 — only the path is forwarded to the
   * model. Field kept optional so historical messages loaded from the
   * server still type-check on render/resend paths.
   */
  base64?: string;
  /**
   * @deprecated as of attachment-path-passthrough: new text attachments no
   * longer carry inline content — 新消息走 composePromptText 路径透传
   * (buildContentBlocks 把路径追加到末尾 text block,由 Agent 主动用 Read
   * 工具按需读取)。Kept optional for backward-compat with historical
   * messages persisted in older format.
   */
  textContent?: string;
  /**
   * @deprecated companion to {@link textContent}. 同上,新消息走
   * composePromptText 路径透传,此字段仅为兼容历史消息保留。
   */
  truncated?: boolean;
  /**
   * 图片带用户手绘标注(lightbox 标注模式烧录产物)。发送时随 wire 契约透传,
   * buildMakerUserMessage 据此给模型注入"红色笔迹是用户标注"的固定说明。
   */
  annotated?: boolean;
  /**
   * 非破坏性标注:未烧录**原图**的 xdt-image:// 缓存 url。`annotated` 为真时
   * 存在;托盘预览用它(而非烧录位图)+ `annotationStrokes` 矢量叠加显示,
   * 使标注可继续编辑 / 撤销。仅编辑期数据,不进 SerializedAttachedFile。
   */
  annotationSourceUrl?: string;
  /** 非破坏性标注:归一化笔迹(0..1 相对原图自然尺寸)。托盘期唯一事实源;
   *  发送时据此烧录位图,烧录前的原图 url 记入 annotationSourceUrl。 */
  annotationStrokes?: ImageAnnotationStroke[];
  /**
   * url 指向的缓存文件是**共享引用**(如历史消息的原图),不归本附件所有:
   * 删除附件时不清理该文件。缺省(false)为附件私有,删除时照常清理。
   */
  cacheUrlShared?: boolean;
  /**
   * @deprecated image-local-cache removed blob-URL thumbnails. Setting this
   * is now a compile error so any leftover code path surfaces immediately.
   */
  thumbnailUrl?: never;
}

/**
 * 图片标注的一条手绘笔迹(归一化坐标)。定义放在附件类型域,组件层
 * (lightboxAnnotations)以别名复用,避免 lib → components 的反向依赖。
 */
export interface ImageAnnotationStroke {
  points: Array<{ x: number; y: number }>;
}

/**
 * Serializable subset of AttachedFile for IPC transport to main process.
 * - `url` + `originalName` for cached images (zero-copy path).
 * - `base64` only for image F6 fallbacks or historical inline payloads.
 *   New file attachments send forward the real file path instead of inline bytes.
 */
export interface SerializedAttachedFile {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  category: FileCategory;
  mimeType: string;
  /** Image source was selected or pasted on the Desktop host. */
  pathOrigin?: 'desktop-host';
  url?: string;
  originalName?: string;
  /**
   * Image F6 fallback. For non-image files this is **only** populated when
   * forwarding a historical message that already had base64 stored
   * (back-compat path). New pdf sends never set it.
   */
  base64?: string;
  /**
   * @deprecated 新消息走 composePromptText 路径透传(buildContentBlocks 把
   * 路径追加到末尾 text block,由 Agent 主动用 Read 工具按需读取),此字段
   * 仅为兼容历史消息保留。
   */
  textContent?: string;
  /**
   * @deprecated companion to {@link textContent}. 同上,新消息走 composePromptText
   * 路径透传,此字段仅为兼容历史消息保留。
   */
  truncated?: boolean;
  /** 图片带用户手绘标注,见 {@link AttachedFile.annotated}。 */
  annotated?: boolean;
}

export interface MentionedResource {
  type: 'file' | 'dir' | 'agent';
  name: string;
  path: string;
}

export interface FileValidationResult {
  valid: AttachedFileInput[];
  errors: { name: string; reason: string }[];
}

// ── Functions ──

/**
 * Categorize a file by its lowercase extension (including the dot).
 * Returns null for unsupported types.
 */
export function categorizeFile(ext: string): FileCategory | null {
  const lower = ext.toLowerCase();
  if (!lower) return null;
  if (SUPPORTED_IMAGE_EXTS.has(lower)) return 'image';
  if (SUPPORTED_DOC_EXTS.has(lower)) return 'pdf';
  if (SUPPORTED_OFFICE_EXTS.has(lower)) return 'office';
  if (SUPPORTED_TEXT_EXTS.has(lower)) return 'text';
  return 'file';
}

/**
 * Get the MIME type for a file extension + category pair.
 */
export function getMimeType(ext: string, category: FileCategory): string {
  if (category === 'pdf') return 'application/pdf';
  if (category === 'text') return 'text/plain';
  if (category === 'file') {
    const lower = ext.toLowerCase();
    if (lower === '.mp3') return 'audio/mpeg';
    if (lower === '.m4a') return 'audio/mp4';
    if (lower === '.wav') return 'audio/wav';
    if (lower === '.flac') return 'audio/flac';
    if (lower === '.ogg') return 'audio/ogg';
    if (lower === '.mp4') return 'video/mp4';
    if (lower === '.mov') return 'video/quicktime';
    if (lower === '.webm') return 'video/webm';
    if (lower === '.mkv') return 'video/x-matroska';
    if (lower === '.avi') return 'video/x-msvideo';
    if (lower === '.zip') return 'application/zip';
    if (lower === '.tar') return 'application/x-tar';
    if (lower === '.gz') return 'application/gzip';
    if (lower === '.tgz') return 'application/gzip';
    if (lower === '.7z') return 'application/x-7z-compressed';
    if (lower === '.rar') return 'application/vnd.rar';
    return 'application/octet-stream';
  }
  if (category === 'office') {
    const lower = ext.toLowerCase();
    if (lower === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (lower === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (lower === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (lower === '.doc') return 'application/msword';
    if (lower === '.xls') return 'application/vnd.ms-excel';
    if (lower === '.ppt') return 'application/vnd.ms-powerpoint';
    return 'application/octet-stream';
  }
  // image
  const lower = ext.toLowerCase();
  if (lower === '.jpeg' || lower === '.jpg') return 'image/jpeg';
  if (lower === '.png') return 'image/png';
  if (lower === '.gif') return 'image/gif';
  if (lower === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Extract file extension from a filename using string ops (no Node `path`).
 *
 * Handles special cases:
 * - Compound extensions (`.env.example`) are matched first as a single unit
 * - Dot-prefixed hidden files without further extension (`.gitignore`) →
 *   the entire filename (lowered) is treated as the extension
 * - Standard files → last dot segment (`.ts`, `.tsx`, etc.)
 */
export function extractExt(name: string): string {
  const lower = name.toLowerCase();

  // 1. Check compound extensions first (longest match wins)
  for (const compound of COMPOUND_EXTS) {
    if (lower.endsWith(compound)) {
      return compound;
    }
  }

  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return ''; // no dot at all (e.g. "Dockerfile")
  if (dotIdx === 0) return lower; // dot-prefixed, no further ext (e.g. ".gitignore")

  return lower.slice(dotIdx);
}

/**
 * Categorize a file by its filename when the extension is empty.
 * Returns null if the filename is not in the known list.
 */
export function categorizeByFilename(name: string): FileCategory | null {
  // Strip any path separator leftovers (should already be just name)
  const base = name.replace(/.*[\\/]/, '').toLowerCase();
  // Remove trailing dot/extension part for matching (e.g. "CMakeLists.txt" has ext)
  return KNOWN_FILENAME_MAP[base] ?? null;
}

/**
 * 批量给文件分类并组装为 AttachedFileInput。
 *
 * 对标 Codex Desktop:renderer 层不对附件做大小 / 数量 / 类型前置校验,
 * 因此恒返回 errors: []。保留 {valid, errors} 签名与第二参数,仅为兼容
 * 既有调用方的解构与调用形态;真正的约束交由下游承接(maker-core 的
 * path 透传 + image-resizer + 上游 vendor API)。
 */
export function validateFiles(
  files: { name: string; path: string; size: number }[],
  _currentAttachmentCount: number,
): FileValidationResult {
  const valid: AttachedFileInput[] = files.map((file) => {
    const ext = extractExt(file.name);
    const category = ext
      ? (categorizeFile(ext) ?? 'file')
      : (categorizeByFilename(file.name) ?? 'file');
    const mimeType = getMimeType(ext, category);
    return { name: file.name, path: file.path, size: file.size, ext, category, mimeType };
  });

  return { valid, errors: [] };
}
