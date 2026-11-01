/**
 * The technical-details text of a local-database startup failure.
 *
 * Main registers this exact string as Main-issued clipboard text when it returns the failure
 * to the renderer, and the fatal screen copies and displays the same string; both sides must
 * build it here, otherwise the main-process clipboard rejects the copy as not issued by Main.
 */
export function localDbFatalDetailsText(error: { code?: string; message?: string } | undefined): string {
  return [error?.code, error?.message].filter(Boolean).join('\n');
}
