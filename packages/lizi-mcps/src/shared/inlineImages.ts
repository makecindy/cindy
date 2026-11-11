import { INLINE_IMAGE_TARGET_BYTES, type CompressInlineImageFn } from '../types.js';

export interface InlineImage {
  data: string;
  mimeType: string;
}

/** Share one tool-result budget; never fall back to oversized original bytes. */
export async function fitInlineImages(
  images: readonly InlineImage[],
  compress?: CompressInlineImageFn,
): Promise<{ images: InlineImage[]; omitted: number }> {
  const share = Math.floor(INLINE_IMAGE_TARGET_BYTES / Math.max(1, images.length));
  const fitted: InlineImage[] = [];
  for (const image of images) {
    const buffer = Buffer.from(image.data, 'base64');
    if (buffer.byteLength > 0 && buffer.byteLength <= share) {
      fitted.push(image);
      continue;
    }
    const smaller =
      buffer.byteLength > share && compress
        ? await compress(buffer, image.mimeType, { targetBytes: share }).catch(() => null)
        : null;
    if (smaller && smaller.buffer.byteLength > 0 && smaller.buffer.byteLength <= share) {
      fitted.push({ data: smaller.buffer.toString('base64'), mimeType: smaller.mime });
    }
  }
  return { images: fitted, omitted: images.length - fitted.length };
}
