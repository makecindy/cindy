/**
 * Format a byte count for display in the toolbar (`3.4 MB`, `812 KB`, `73 B`).
 * Mirrors the spec wording — no thin-space, no parentheses, just "<n> <unit>".
 *
 * Lives outside TextLightbox so composer attachments can show sizes without
 * pulling the on-demand lightbox (CodeMirror) into the first screen.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
