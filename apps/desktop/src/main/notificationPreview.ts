import { markdownPreviewText } from '../shared/markdownPreviewText';

/** Project message text and image descriptions before shortening. */
export function notificationPlainText(markdown: string, imageFallback = 'Image'): string {
  return markdownPreviewText(markdown, { imageFallback });
}

export function notificationPreview(markdown: string, limit = 240, imageFallback = 'Image'): string {
  return truncateNotificationText(notificationPlainText(markdown, imageFallback), limit);
}

export function truncateNotificationText(text: string, limit: number): string {
  // The notify protocol measures JS string length (UTF-16), not code points.
  let preview = '';
  for (const character of text) {
    if (preview.length + character.length > limit) break;
    preview += character;
  }
  return preview;
}
