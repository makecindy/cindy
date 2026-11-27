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

function isWordChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x5f
  );
}

function isDataUrlTerminator(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (
    code === 0x3c // <
    || code === 0x3e // >
    || code === 0x22 // "
    || code === 0x27 // '
    || code === 0x29 // )
  ) return true;
  if (code < 0xa0) return false;
  return (
    code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff
  );
}

/** Linear constant-stack equivalent of `.replace(/\bdata:[^\s<>"')]+/gi, "[redacted-url]")`. */
function redactInlineDataUrls(value: string): string {
  let result = "";
  let lastCopied = 0;
  let changed = false;
  const len = value.length;
  for (let index = 0; index <= len - 6; ) {
    const c0 = value.charCodeAt(index);
    if (
      (c0 === 0x64 || c0 === 0x44)
      && (index === 0 || !isWordChar(value.charCodeAt(index - 1)))
      && (value.charCodeAt(index + 1) === 0x61 || value.charCodeAt(index + 1) === 0x41)
      && (value.charCodeAt(index + 2) === 0x74 || value.charCodeAt(index + 2) === 0x54)
      && (value.charCodeAt(index + 3) === 0x61 || value.charCodeAt(index + 3) === 0x41)
      && value.charCodeAt(index + 4) === 0x3a
    ) {
      let end = index + 5;
      while (end < len && !isDataUrlTerminator(value.charCodeAt(end))) end += 1;
      if (end > index + 5) {
        changed = true;
        if (index > lastCopied) result += value.slice(lastCopied, index);
        result += "[redacted-url]";
        lastCopied = end;
        index = end;
        continue;
      }
      index += 5;
      continue;
    }
    index += 1;
  }
  if (!changed) return value;
  if (lastCopied < len) result += value.slice(lastCopied);
  return result;
}

/**
 * Bounded, path-free diagnostic text. Native / SSH / WebView failures often embed
 * absolute paths or signed URLs; those must not reach the `files` debug records.
 */
export function sanitizeDiagnosticText(value: string): string {
  if (!value) return "";
  const stripped = redactInlineDataUrls(
    value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+/gi, "[redacted-url]"),
  )
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
