import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';

/**
 * Host-owned files are not Plugin package contents. They must survive an update,
 * but they cannot be used to prove that a directory still contains the release
 * recorded by the market ledger.
 */
export const GHOST_CONTENT_DIGEST_SKIP_ROOT_FILES = new Set([
  '.disabled',
  '.cindy-trust.json',
  '.DS_Store',
]);

const MAX_CONTENT_ENTRIES = 10_000;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_ATTEMPTS = 3;

export interface GhostPackageContentEntry {
  path: string;
  bytes: number;
  sha256: string;
}

function canonicalEntries(entries: readonly GhostPackageContentEntry[]): string {
  return JSON.stringify(
    [...entries]
      .map((entry) => ({
        path: entry.path.replaceAll('\\', '/'),
        bytes: entry.bytes,
        sha256: entry.sha256,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

/** Stable digest shared by validated .cindy archives and installed directories. */
export function ghostPackageContentDigest(entries: readonly GhostPackageContentEntry[]): string {
  return crypto.createHash('sha256').update(canonicalEntries(entries)).digest('hex');
}

function shouldSkipRootEntry(name: string, relBase: string): boolean {
  return relBase === '' && GHOST_CONTENT_DIGEST_SKIP_ROOT_FILES.has(name);
}

async function snapshotDirectoryPass(rootDir: string): Promise<GhostPackageContentEntry[] | null> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(rootDir);
  } catch {
    return null;
  }

  const entries: GhostPackageContentEntry[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const walk = async (dir: string, relBase: string): Promise<boolean> => {
    let handle: fs.Dir;
    try {
      handle = await fs.promises.opendir(dir);
    } catch {
      return false;
    }
    try {
      for await (const entry of handle) {
        if (shouldSkipRootEntry(entry.name, relBase)) continue;
        entryCount += 1;
        if (entryCount > MAX_CONTENT_ENTRIES) return false;
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!(await walk(abs, rel))) return false;
          continue;
        }
        let bytes: Buffer | null;
        try {
          bytes = await readBoundedFileNoFollow(abs, Math.max(0, MAX_CONTENT_BYTES - totalBytes), {
            containWithin: realRoot,
            rejectHardLinks: true,
            verifyContentStability: true,
          });
        } catch {
          return false;
        }
        if (bytes === null) return false;
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_CONTENT_BYTES) return false;
        entries.push({
          path: rel,
          bytes: bytes.byteLength,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
  };

  if (!(await walk(realRoot, ''))) return null;
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Takes two byte-anchored passes. Updates and local edits during the read make
 * the result fail closed instead of producing a mixed directory fingerprint.
 */
export async function installedGhostContentDigest(dir: string): Promise<string | null> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const first = await snapshotDirectoryPass(dir);
    if (!first) return null;
    const second = await snapshotDirectoryPass(dir);
    if (!second) return null;
    if (canonicalEntries(first) === canonicalEntries(second)) {
      return ghostPackageContentDigest(first);
    }
  }
  return null;
}
