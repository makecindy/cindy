/**
 * Shared shape for the `files` debug scope (remote file preview / playback).
 * Records stages, routes, sizes and timings only: never file paths, signed URLs or file contents.
 */
let trace = 0;

const MAX_ERROR_TEXT = 300;

/** Correlates the stages of one remote read inside a single exported log. */
export function nextFileTrace(): number {
  trace = (trace + 1) % 1_000_000;
  return trace;
}

/** File extension of a desktop media reference (`xdt-file://open?path=…`), without the path itself. */
export function mediaExtOf(url: string): string {
  try {
    const match = /[?&]path=([^&#]*)/.exec(url);
    const path = match ? decodeURIComponent(match[1]) : url;
    return /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

/** Which transport produced a playable/renderable URL. */
export function resolvedUrlKind(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme ?? "unknown";
}

/**
 * Bounded, path-free diagnostic text. Native / SSH / WebView failures often embed
 * absolute paths or signed URLs; those must not reach the `files` debug records.
 */
export function sanitizeDiagnosticText(value: string): string {
  if (!value) return "";
  const stripped = value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+/gi, "[redacted-url]")
    .replace(/\bdata:[^\s<>"')]+/gi, "[redacted-url]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\\\\[^\s\\/<>"']+[\\/])[^\n<>"']*/g,
      "[redacted-path]",
    )
    .replace(
      /(^|[\s"'=(])(\/(?:Users|home|var|private|data|tmp|srv|mnt|opt|root|storage|sdcard|Applications)\/[^\n<>"']+)/g,
      "$1[redacted-path]",
    )
    .replace(
      /(^|[\s"'=(])(\/(?:[^/\s<>"')]+\/)+[^/\s<>"')]+)/g,
      "$1[redacted-path]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_TEXT);
  return stripped;
}

export function errorText(error: unknown): string {
  if (error == null) return "";
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeDiagnosticText(raw);
}
