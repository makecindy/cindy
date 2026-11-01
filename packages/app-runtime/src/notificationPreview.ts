import { markdownPreviewText } from './markdownPreviewText.js';

/** Project message text and image descriptions before shortening. */
export function notificationPlainText(markdown: string, imageFallback = 'Image'): string {
  return markdownPreviewText(markdown, { imageFallback });
}

export function notificationPreview(markdown: string, limit = 240, imageFallback = 'Image'): string {
  // The notify protocol measures JS string length (UTF-16), not code points.
  let preview = '';
  for (const character of notificationPlainText(markdown, imageFallback)) {
    if (preview.length + character.length > limit) break;
    preview += character;
  }
  return preview;
}
