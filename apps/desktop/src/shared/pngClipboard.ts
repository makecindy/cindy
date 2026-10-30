/** Local bitmap export only: no file paths, URLs, or remote clipboard access. */
export const COPY_PNG_TO_CLIPBOARD_CHANNEL = 'media:copy-png-to-clipboard';
export const MAX_CLIPBOARD_PNG_BYTES = 72 * 1024 * 1024;
export const MAX_CLIPBOARD_PNG_EDGE = 16_384;
export const MAX_CLIPBOARD_PNG_PIXELS = 4096 ** 2 + 16_384;

export interface CopyPngToClipboardParams {
  png: ArrayBuffer;
  plainText?: string;
}
