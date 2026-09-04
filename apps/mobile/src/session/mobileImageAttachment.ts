import { i18n } from '@/i18n';
import { MOBILE_MAX_ATTACHMENT_BYTES, extractRemoteFileExt } from '@/session/attachments';
import type { MobileAttachmentUploadCandidate } from '@/session/mobileAttachmentUpload';

export type MobileImagePickerAssetLike = {
  uri?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
};

export type MobileImageAttachmentCandidate = MobileAttachmentUploadCandidate & {
  uri: string;
  width?: number | null;
  height?: number | null;
  /**
   * 仅 HEIC / HEIF 等非白名单格式带此钩子:任务开跑时就地转 JPEG(#3889)。
   * 托盘预览仍用原始 uri;返回字段由上传管线覆盖到 candidate 上。
   */
  resolve?: () => Promise<{ uri: string; name: string; mimeType: string; size: number }>;
};

/** JPEG 转换器(可注入,单测用假实现避免触碰原生模块)。 */
export type MobileImageJpegConverter = (uri: string) => Promise<string>;

export interface BuildMobileImageAttachmentCandidateDeps {
  convertToJpeg?: MobileImageJpegConverter;
}

/**
 * 附件白名单与下游模型图像接口都只认这四种(与 attachments.ts 的
 * SUPPORTED_IMAGE_EXTS、pastedImageAttachment 的 WHITELISTED_IMAGE_EXTS 同口径)。
 */
const WHITELISTED_IMAGE_EXTS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
/** 与 useContextSheetMediaAssets / pastedImageAttachment 同口径:0.9 视觉无损,体积可控。 */
const IMAGE_JPEG_COMPRESS = 0.9;

export function buildMobileImageAttachmentCandidate(
  asset: MobileImagePickerAssetLike,
  index: number,
  deps: BuildMobileImageAttachmentCandidateDeps = {},
): MobileImageAttachmentCandidate {
  const uri = asset.uri?.trim();
  if (!uri) throw new Error(i18n.t('composer.upload.noImageRead'));
  const mimeType = normalizeImageMimeType(asset.mimeType, uri);
  const name = normalizeImageFileName(asset.fileName, uri, mimeType, index);
  const size = Number(asset.fileSize ?? 0);
  const candidate: MobileImageAttachmentCandidate = {
    uri,
    name,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mimeType,
    width: asset.width,
    height: asset.height,
  };
  if (!needsJpegConversion(name, mimeType)) return candidate;
  // 系统 Photos picker / 相机可能直接交出 HEIC / HEIF(iOS 原生格式):MIME 原样
  // 放行、文件名保留 .heic,而 preprocess 只在大图 / 超长边时才顺带 JPEG 重编码,
  // 小图会原样直传进只认 jpeg/png/gif/webp 的下游,表现为「截图发送失败」(#3889)。
  // 与相册 ph:// 链路、粘贴链路同一口径:在就位钩子里就地转 JPEG。
  const convert = deps.convertToJpeg ?? convertMobileImageToJpegNative;
  return {
    ...candidate,
    resolve: async () => ({
      uri: await convert(uri),
      name: replaceImageFileExt(name, 'jpg'),
      mimeType: 'image/jpeg',
      // 转码后字节数已变:置 0 让管线 stat 转换产物的真实大小。沿用 picker 给的原
      // HEIC 字节数会在 uploadMobileAttachmentFromFile 的大小一致性校验处被拒
      //(Attachment size changed),恰好卡死本次要修的小图场景(review P1)。
      size: 0,
    }),
  };
}

/** 文件名扩展名不在白名单、或 MIME 明示 HEIC / HEIF → 需转 JPEG 才能进上传管线。 */
export function needsJpegConversion(name: string, mimeType: string | null | undefined): boolean {
  const mime = mimeType?.trim().toLowerCase() ?? '';
  if (HEIC_MIME_TYPES.has(mime)) return true;
  return !WHITELISTED_IMAGE_EXTS.has(extractRemoteFileExt(name));
}

/**
 * 默认 JPEG 转换:expo-image-manipulator 动态 import,保证本模块在 vitest(node)
 * 下可导入;测试路径经 deps.convertToJpeg 注入。粘贴链路复用同一实现。
 */
export async function convertMobileImageToJpegNative(uri: string): Promise<string> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(uri);
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ compress: IMAGE_JPEG_COMPRESS, format: SaveFormat.JPEG });
    return saved.uri;
  } finally {
    // render 结果持有 native GPU 纹理,不显式 release 会在 GC 前持续占用
    //(与 useContextSheetMediaAssets / mobileImagePreprocess 同模式)。
    image.release();
    context.release();
  }
}

export function assertMobileImageSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(i18n.t('composer.upload.emptyImage'));
  }
  if (size > MOBILE_MAX_ATTACHMENT_BYTES) {
    throw new Error(i18n.t('composer.upload.imageTooLarge', { size: Math.round(MOBILE_MAX_ATTACHMENT_BYTES / 1024 / 1024) }));
  }
}

function normalizeImageMimeType(mimeType: string | null | undefined, uri: string): string {
  const trimmed = mimeType?.trim().toLowerCase();
  if (trimmed?.startsWith('image/')) return trimmed;
  const ext = extractRemoteFileExt(basenameFromUri(uri));
  if (ext === '.jpeg' || ext === '.jpg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function normalizeImageFileName(
  fileName: string | null | undefined,
  uri: string,
  mimeType: string,
  index: number,
): string {
  const explicit = fileName?.trim();
  if (explicit && extractRemoteFileExt(explicit)) return explicit;
  const uriName = basenameFromUri(uri);
  if (uriName && extractRemoteFileExt(uriName)) return uriName;
  return `mobile-image-${index + 1}.${extForImageMimeType(mimeType)}`;
}

function replaceImageFileExt(name: string, targetExt: string): string {
  const ext = extractRemoteFileExt(name);
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  return `${base}.${targetExt}`;
}

function basenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  const slash = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
  return slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
}

function extForImageMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}
