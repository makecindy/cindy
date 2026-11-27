import type { AttachmentImageIntrinsicSize } from './mediaThumbnail';

/**
 * Module-level intrinsic image dimension cache shared by MessageRenderer and
 * room/account media cache invalidation. Keeping the map in a zero-UI module
 * lets chat/auth cleanup purge entries without pulling MessageRenderer in.
 */
export const ATTACHMENT_INTRINSIC_CACHE_MAX = 500;

export const attachmentIntrinsicSizeCache = new Map<
  string,
  AttachmentImageIntrinsicSize
>();

export function clearAttachmentIntrinsicSizes(
  predicate?: (key: string) => boolean,
): void {
  if (!predicate) {
    attachmentIntrinsicSizeCache.clear();
    return;
  }
  for (const key of attachmentIntrinsicSizeCache.keys()) {
    if (predicate(key)) attachmentIntrinsicSizeCache.delete(key);
  }
}
