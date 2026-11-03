import type { ChatUploadAttachment } from './chatServerMedia.js';

/** Check decoded paths before any filesystem lookup can contact a remote share. */
export function isNetworkOrDevicePath(value: string): boolean {
  return /^[\\/]{2}|^[\\/]\?\?[\\/]/.test(value);
}

/** A rendered image and its download link share one upload at their first occurrence. */
export function mergeChatReplyAttachments(images: ChatUploadAttachment[], files: ChatUploadAttachment[]): ChatUploadAttachment[] {
  const imageSources = new Map<string, ChatUploadAttachment>();
  const merged = images.map(image => ({ ...image }));
  for (const image of merged) for (const source of image.sourcePaths ?? []) imageSources.set(source, image);
  for (const file of files) {
    const image = file.sourcePaths?.map(source => imageSources.get(source)).find(Boolean);
    if (image) {
      if (file.sourceOffset !== undefined) image.sourceOffset = Math.min(image.sourceOffset ?? Infinity, file.sourceOffset);
    } else merged.push(file);
  }
  return merged.sort((a, b) => {
    const position = (a.sourceOffset ?? Infinity) - (b.sourceOffset ?? Infinity);
    // Removing an outer file link can project it and its nested preview to the same offset.
    return position || (a.sourceOffset !== undefined && b.sourceOffset !== undefined
      ? Number(a.category === 'image') - Number(b.category === 'image') : 0);
  });
}
