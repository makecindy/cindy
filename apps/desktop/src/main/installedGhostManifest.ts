import crypto from 'node:crypto';
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

export interface InstalledGhostManifestSnapshot {
  manifest: GhostManifest;
  legacyManualIgnored: boolean;
  /** SHA-256 of the exact ghost.json bytes read from disk. */
  rawManifestSha256: string;
  /** Exact normalized shape emitted by the released v0.1.61 v2 validator. */
  releasedLegacyDigestFormat: unknown;
  /** Historical normalized projections; migration is their only consumer. */
  legacyDigestFormats: readonly unknown[];
}

export type InstalledGhostManifestSnapshotRead =
  | { ok: true; snapshot: InstalledGhostManifestSnapshot }
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
  const result = readInstalledGhostManifestSnapshot(dir, maxBytes);
  return result.ok
    ? {
        ok: true,
        manifest: result.snapshot.manifest,
        legacyManualIgnored: result.snapshot.legacyManualIgnored,
      }
    : result;
}

/**
 * Read the installed ghost.json once and derive every identity projection from
 * that same Buffer. Consumers must not pair this result with a second manifest
 * read: doing so would reopen a validate-one-file/use-another TOCTOU window.
 */
export function readInstalledGhostManifestSnapshot(
  dir: string,
  maxBytes: number,
): InstalledGhostManifestSnapshotRead {
  try {
    const bytes = readBoundedFileNoFollowSync(path.join(dir, 'ghost.json'), maxBytes);
    if (bytes === null) return { ok: false, reason: 'manifest is not a bounded regular file' };
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    const parsed = parseInstalledGhostManifest(raw);
    if (!parsed.ok) return parsed;
    const current = parsed.manifest;
    const legacy = ghostManifestToLegacyV2DigestFormat(current, raw);
    return {
      ok: true,
      snapshot: {
        manifest: current,
        legacyManualIgnored: parsed.legacyManualIgnored,
        rawManifestSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        releasedLegacyDigestFormat: legacy,
        legacyDigestFormats:
          JSON.stringify(current) === JSON.stringify(legacy) ? [current] : [current, legacy],
      },
    };
  } catch {
    return { ok: false, reason: 'manifest could not be read' };
  }
}

/** 当前投影与升级前 v2 slots 投影；调用方可兼容核对既有持久摘要。 */
export function readInstalledGhostManifestDigestFormats(
  dir: string,
  maxBytes: number,
): unknown[] {
  const result = readInstalledGhostManifestSnapshot(dir, maxBytes);
  return result.ok ? [...result.snapshot.legacyDigestFormats] : [];
}
