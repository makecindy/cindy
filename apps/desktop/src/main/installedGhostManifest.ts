import path from 'node:path';

import {
  ghostManifestToLegacyV2DigestFormat,
  validateGhostManifest,
  type GhostManifest,
} from '../shared/ghost.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';

export type InstalledGhostManifestParse =
  | { ok: true; manifest: GhostManifest; legacyManualIgnored: boolean }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Installed directories may contain a pre-manual top-level `manual` metadata
 * field. Keep this compatibility rule confined to reads of already-installed
 * manifests; package/Forge validation remains strict via validateGhostManifest.
 */
export function parseInstalledGhostManifest(raw: unknown): InstalledGhostManifestParse {
  const strict = validateGhostManifest(raw);
  if (strict.ok) return { ok: true, manifest: strict.manifest, legacyManualIgnored: false };
  if (!isPlainObject(raw) || !Object.prototype.hasOwnProperty.call(raw, 'manual')) {
    return { ok: false, reason: strict.reason };
  }
  const withoutLegacyManual = { ...raw };
  delete withoutLegacyManual.manual;
  const compatible = validateGhostManifest(withoutLegacyManual);
  return compatible.ok
    ? { ok: true, manifest: compatible.manifest, legacyManualIgnored: true }
    : { ok: false, reason: compatible.reason };
}

export function readInstalledGhostManifest(
  dir: string,
  maxBytes: number,
): InstalledGhostManifestParse {
  try {
    const bytes = readBoundedFileNoFollowSync(path.join(dir, 'ghost.json'), maxBytes);
    if (bytes === null) return { ok: false, reason: 'manifest is not a bounded regular file' };
    return parseInstalledGhostManifest(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    return { ok: false, reason: 'manifest could not be read' };
  }
}

/** 当前投影与升级前 v2 slots 投影；调用方可兼容核对既有持久摘要。 */
export function readInstalledGhostManifestDigestFormats(
  dir: string,
  maxBytes: number,
): unknown[] {
  try {
    const bytes = readBoundedFileNoFollowSync(path.join(dir, 'ghost.json'), maxBytes);
    if (bytes === null) return [];
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    const parsed = parseInstalledGhostManifest(raw);
    if (!parsed.ok) return [];
    const current = parsed.manifest;
    const legacy = ghostManifestToLegacyV2DigestFormat(current, raw);
    return JSON.stringify(current) === JSON.stringify(legacy) ? [current] : [current, legacy];
  } catch {
    return [];
  }
}
