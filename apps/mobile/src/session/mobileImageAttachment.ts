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
};

export function buildMobileImageAttachmentCandidate(
  asset: MobileImagePickerAssetLike,
  index: number,
): MobileImageAttachmentCandidate {
  const uri = asset.uri?.trim();
  if (!uri) throw new Error(i18n.t('composer.upload.noImageRead'));
  const mimeType = normalizeImageMimeType(asset.mimeType, uri);
  const name = normalizeImageFileName(asset.fileName, uri, mimeType, index);
  const size = Number(asset.fileSize ?? 0);
  return {
    uri,
    name,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mimeType,
    width: asset.width,
    height: asset.height,
  };
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
