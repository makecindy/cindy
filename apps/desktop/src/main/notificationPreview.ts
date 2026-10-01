import { markdownPreviewText } from '../shared/markdownPreviewText';

/** Parse before shortening, without leaking image filenames into notifications. */
export function notificationPlainText(markdown: string): string {
  return markdownPreviewText(markdown, { includeImageAlt: false });
}

export function notificationPreview(markdown: string, limit = 240): string {
  // The notify protocol measures JS string length (UTF-16), not code points.
  let preview = '';
  for (const character of notificationPlainText(markdown)) {
    if (preview.length + character.length > limit) break;
    preview += character;
  }
  return preview;
}
