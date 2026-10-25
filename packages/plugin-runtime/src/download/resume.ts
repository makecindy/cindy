/**
 * unified-downloader — M2: .meta.json sidecar + resume decision.
 * ---------------------------------------------------------------------------
 * Resume metadata validation and persistence are maintained in this module.
 *
 * The sidecar tracks the negotiated ETag/Last-Modified so a future attempt can
 * decide whether the existing `.part` is still resumable. Writes are atomic
 * (`tmp + rename`) so a crash mid-write leaves either the previous good copy
 * or no file at all.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MetaJson {
  url: string;
  expectedSize: number | null;
  expectedSha256: string;
  downloadedBytes: number;
  etag: string | null;
  lastModified: string | null;
  createdAt: string;
  updatedAt: string;
}

export function metaPath(targetPath: string): string {
  return `${targetPath}.meta.json`;
}

export function partPath(targetPath: string): string {
  return `${targetPath}.part`;
}

export function readMeta(targetPath: string): MetaJson | null {
  try {
    const raw = fs.readFileSync(metaPath(targetPath), 'utf8');
    return JSON.parse(raw) as MetaJson;
  } catch {
    return null;
  }
}

/** Atomic write: tmp file + rename. */
export function writeMeta(targetPath: string, meta: MetaJson): void {
  const final = metaPath(targetPath);
  const tmp = `${final}.tmp`;
  fs.mkdirSync(path.dirname(final), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, final);
}

export function deleteMeta(targetPath: string): void {
  try { fs.unlinkSync(metaPath(targetPath)); } catch { /* ignore */ }
}

export function deletePart(targetPath: string): void {
  try { fs.unlinkSync(partPath(targetPath)); } catch { /* ignore */ }
}

export function partSize(targetPath: string): number {
  try { return fs.statSync(partPath(targetPath)).size; } catch { return 0; }
}

/**
 * Decide whether to resume from an existing `.part` + `.meta.json`.
 *
 * Returns:
 *   - `null` → discard any partial and start fresh (caller will deletePart/deleteMeta).
 *   - `number` → use this byte offset as the Range start.
 *
 * Conservative: any inconsistency between meta and disk → fresh download.
 */
export function decideResumeOffset(
  targetPath: string,
  url: string,
  expectedSize: number | undefined,
  expectedSha256: string,
): number | null {
  const meta = readMeta(targetPath);
  if (meta === null) return null;
  if (meta.url !== url) return null;
  if (meta.expectedSha256 !== expectedSha256) return null;
  if (
    expectedSize !== undefined &&
    meta.expectedSize !== null &&
    meta.expectedSize !== expectedSize
  ) {
    return null;
  }

  const actualPartSize = partSize(targetPath);
  if (actualPartSize === 0) return null;
  // .part vs meta drift (likely crash mid-write) → restart fresh.
  if (actualPartSize !== meta.downloadedBytes) return null;
  return actualPartSize;
}
