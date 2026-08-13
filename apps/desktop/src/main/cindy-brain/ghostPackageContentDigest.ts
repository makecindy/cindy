import crypto from 'node:crypto';
import path from 'node:path';

import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { collectGhostContentFiles, type GhostContentTree } from './ghostContentTree.js';
import { shouldSkipGhostPackEntry } from './ghostPackageContentRules.js';

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

/**
 * 单次快照。类型判定与递归全部来自共享的 `ghostContentTree`(lstat 分类,
 * 不信 readdir 的 Dirent 类型位——Windows junction 的类型位跨平台不稳,跟随
 * 它递归会把根外字节算进摘要,让"内容相同的插件"哈希不一致);非普通条目按
 * `throw` 策略 fail closed。跳过的目录整棵不递归(例如 source 树的
 * node_modules),文件列表收集完成后再做有界逐文件读取。
 */
async function snapshotDirectoryPass(
  rootDir: string,
  shouldSkipEntry: (name: string, relativeDir: string) => boolean,
): Promise<GhostPackageContentEntry[] | null> {
  let tree: GhostContentTree;
  try {
    tree = await collectGhostContentFiles(rootDir, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'plugin recovery content digest',
      shouldSkipEntry,
    });
  } catch {
    return null;
  }
  if (tree.files.length > MAX_CONTENT_ENTRIES) return null;

  const entries: GhostPackageContentEntry[] = [];
  let totalBytes = 0;
  for (const rel of tree.files) {
    const abs = path.join(tree.rootIdentity.realPath, ...rel.split('/'));
    let bytes: Buffer | null;
    try {
      bytes = await readBoundedFileNoFollow(abs, Math.max(0, MAX_CONTENT_BYTES - totalBytes), {
        containWithin: tree.rootIdentity.realPath,
        rejectHardLinks: true,
        verifyContentStability: true,
      });
    } catch {
      return null;
    }
    if (bytes === null) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_CONTENT_BYTES) return null;
    entries.push({
      path: rel,
      bytes: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Takes two byte-anchored passes. Updates and local edits during the read make
 * the result fail closed instead of producing a mixed directory fingerprint.
 */
export async function installedGhostContentDigest(dir: string): Promise<string | null> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const first = await snapshotDirectoryPass(dir, shouldSkipRootEntry);
    if (!first) return null;
    const second = await snapshotDirectoryPass(dir, shouldSkipRootEntry);
    if (!second) return null;
    if (canonicalEntries(first) === canonicalEntries(second)) {
      return ghostPackageContentDigest(first);
    }
  }
  return null;
}

/**
 * Digests the bytes that packGhostDirToFile would include from a custom source
 * tree. Development artifacts omitted by the packer must not turn a byte-for-
 * byte installed package into a recovery mismatch.
 */
export async function packableGhostSourceContentDigest(dir: string): Promise<string | null> {
  const skipPackEntry = (name: string): boolean => shouldSkipGhostPackEntry(name);
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const first = await snapshotDirectoryPass(dir, skipPackEntry);
    if (!first) return null;
    const second = await snapshotDirectoryPass(dir, skipPackEntry);
    if (!second) return null;
    if (canonicalEntries(first) === canonicalEntries(second)) {
      return ghostPackageContentDigest(first);
    }
  }
  return null;
}
