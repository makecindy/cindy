/** Local text copy only: never routed to a remote host. */
export const COPY_TEXT_TO_CLIPBOARD_CHANNEL = 'clipboard:copy-text';
export const MAX_CLIPBOARD_TEXT_CHARS = 64 * 1024;

export interface CopyTextToClipboardParams {
  text: string;
}
