/**
 * File types a plugin can open for the user (`fileOpener`, schemaVersion 3 only).
 *
 * When the user opens a local file from Cindy with the system default app (a preview's Open
 * button, "open with default app", a modifier click, the file browser), Cindy first offers the
 * file to an enabled plugin that declared its extension. The plugin's logic page receives the
 * absolute path and answers whether it opened the file; otherwise Cindy falls back to the
 * system default app. The plugin receives a host absolute path, so the field requires a `node`
 * worker, the same boundary `pick` uses. Users can turn it off per plugin.
 */

export const GHOST_FILE_OPENER_MAX_EXTENSIONS = 32;
/** Lowercase, leading dot, same shape as `mcpApps.host` attachment extensions. */
export const GHOST_FILE_OPENER_EXTENSION_RE = /^\.[a-z0-9][a-z0-9._+-]{0,31}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface GhostFileOpenerDecl {
  extensions: string[];
  /** Future fields are preserved as data and never interpreted. */
  [key: string]: unknown;
}

export type GhostFileOpenerParse =
  | { ok: true; fileOpener: GhostFileOpenerDecl }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGhostFileOpener(raw: unknown, node: unknown): GhostFileOpenerParse {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'fileOpener must be an object such as { "extensions": [".docx"] }' };
  }
  if (!node) return { ok: false, reason: 'fileOpener requires a node worker declaration' };
  const list = raw.extensions;
  if (!Array.isArray(list) || list.length === 0 || list.length > GHOST_FILE_OPENER_MAX_EXTENSIONS) {
    return {
      ok: false,
      reason: `fileOpener.extensions must list 1–${GHOST_FILE_OPENER_MAX_EXTENSIONS} file extensions`,
    };
  }
  const extensions: string[] = [];
  for (const ext of list) {
    if (typeof ext !== 'string' || !GHOST_FILE_OPENER_EXTENSION_RE.test(ext)) {
      return {
        ok: false,
        reason: `fileOpener.extensions has an invalid entry ${JSON.stringify(ext)}; use lowercase forms such as ".docx"`,
      };
    }
    if (extensions.includes(ext)) {
      return { ok: false, reason: `fileOpener.extensions lists ${ext} twice` };
    }
    extensions.push(ext);
  }
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'extensions' && !RESERVED_KEYS.has(key)),
  );
  return { ok: true, fileOpener: { ...extra, extensions } };
}

/** Whether the declaration covers this file name or path (case-insensitive suffix match). */
export function ghostFileOpenerMatches(
  decl: Pick<GhostFileOpenerDecl, 'extensions'> | undefined,
  fileName: string,
): boolean {
  if (!decl) return false;
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
  return decl.extensions.some((ext) => base.endsWith(ext) && base.length > ext.length);
}

/** Market cap: the real package may only open a subset of the reviewed extensions. */
export function ghostFileOpenerWithinCap(
  actual: Pick<GhostFileOpenerDecl, 'extensions'> | undefined,
  cap: Pick<GhostFileOpenerDecl, 'extensions'> | undefined,
): boolean {
  if (!actual) return true;
  if (!cap) return false;
  return actual.extensions.every((ext) => cap.extensions.includes(ext));
}
