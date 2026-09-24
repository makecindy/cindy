/**
 * Shared shape for the `files` debug scope (remote file preview / playback).
 * Records stages, routes, sizes and timings only: never file paths, signed URLs or file contents.
 */
let trace = 0;

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

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
