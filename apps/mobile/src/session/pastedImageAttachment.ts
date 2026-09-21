/**
 * 粘贴图片附件解析:把 ComposerRichInput 从 WebView 剪贴板落盘的临时文件 uri 解析成
 * 可直接走现有上传链路(buildMobileImageAttachmentCandidate →
 * uploadMobileAttachmentFromFile)的 { uri, fileName }。
 *
 * 粘贴落盘的临时文件名是无意义 UUID,统一生成 `pasted-image-<N>.<ext>` 友好名;
 * 扩展名不在附件白名单(jpeg/jpg/png/gif/webp)的图——HEIC/HEIF/TIFF/无扩展名等——
 * 就地转 JPEG,避免在链路下游变成不可用附件(同 Context 面板相册链路的处理)。
 */
import { extractRemoteFileExt } from '@/session/attachments';
import { convertMobileImageToJpegNative } from '@/session/mobileImageAttachment';

export const COMPOSER_PASTED_IMAGE_FILE_PREFIX = 'cindy-composer-paste-';

const WHITELISTED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;

export type PastedImageExt = (typeof WHITELISTED_IMAGE_EXTS)[number];

export interface PastedImageClassification {
  /** 生成文件名用的扩展名;需要转换时固定为 jpg。 */
  ext: PastedImageExt;
  needsJpegConversion: boolean;
}

export interface PastedImageAsset {
  /** 可上传的 file:// uri(需要时已转 JPEG)。 */
  uri: string;
  /** pasted-image-<index+1>.<ext> */
  fileName: string;
  /**
   * 上传用 MIME。必须随 asset 一起给出:candidate 缺 mimeType 时预签名不锁
   * Content-Type,而原生直传层会自动补 application/octet-stream,两边不一致
   * 直接 OSS SignatureDoesNotMatch 403(2026-07 粘贴上传实撞)。
   */
  mimeType: string;
}

/** 白名单扩展名 → MIME(粘贴链路的唯一真源,与 normalizeImageMimeType 同口径)。 */
export function mimeTypeForPastedImageExt(ext: PastedImageExt): string {
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** JPEG 转换器(可注入,单测用假实现避免触碰原生模块)。 */
export type PastedImageJpegConverter = (uri: string) => Promise<string>;

/** 从粘贴 uri 判定扩展名与是否需要转 JPEG(纯函数)。 */
export function classifyPastedImageUri(uri: string): PastedImageClassification {
  const ext = extractRemoteFileExt(basenameFromUri(uri)).replace(/^\./, '');
  if ((WHITELISTED_IMAGE_EXTS as readonly string[]).includes(ext)) {
    return { ext: ext as PastedImageExt, needsJpegConversion: false };
  }
  return { ext: 'jpg', needsJpegConversion: true };
}

/** 粘贴临时文件名无意义,统一生成友好名(纯函数)。 */
export function buildPastedImageFileName(index: number, ext: string): string {
  return `pasted-image-${index + 1}.${ext}`;
}

/** 只识别 ComposerRichInput 明确创建、应由本链路负责回收的缓存文件。 */
export function isComposerPastedImageUri(uri: string): boolean {
  return basenameFromUri(uri).startsWith(COMPOSER_PASTED_IMAGE_FILE_PREFIX);
}

/**
 * 把粘贴 uri 解析为可上传 asset。默认转换器走 expo-image-manipulator
 * (lazy import,保证本模块在 vitest node 环境可导入,测试路径经 deps 注入)。
 */
export async function resolvePastedImageAsset(
  uri: string,
  index: number,
  deps: { convertToJpeg?: PastedImageJpegConverter } = {},
): Promise<PastedImageAsset> {
  const classified = classifyPastedImageUri(uri);
  if (!classified.needsJpegConversion) {
    return {
      uri,
      fileName: buildPastedImageFileName(index, classified.ext),
      mimeType: mimeTypeForPastedImageExt(classified.ext),
    };
  }
  const convert = deps.convertToJpeg ?? convertMobileImageToJpegNative;
  return {
    uri: await convert(uri),
    fileName: buildPastedImageFileName(index, 'jpg'),
    mimeType: 'image/jpeg',
  };
}

function basenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  const slash = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
  return slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
}
