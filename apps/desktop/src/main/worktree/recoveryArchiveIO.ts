import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

export interface FileEvidence {
  kind: 'file' | 'link' | 'directory';
  hash: string;
  mode: number;
}

/** Compressed, encrypted local recovery bytes; secrets never enter Git objects. */
export interface WorktreeRecoveryArchive {
  file: string;
  encryptedKey: string;
  iv: string;
  tag: string;
  files: Record<string, FileEvidence>;
}

function restorableMode(mode: number): number {
  // Windows exposes read/write attributes; tar adds synthetic directory execute bits.
  return mode & (process.platform === 'win32' ? 0o666 : 0o777);
}

export async function inventoryWorktree(root: string, maxBytes?: number): Promise<Record<string, FileEvidence>> {
  const files: Record<string, FileEvidence> = Object.create(null);
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await fs.readdir(directory)) {
      if (directory === root && name === '.git') continue;
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      const relative = path.relative(root, absolute);
      const mode = restorableMode(stat.mode);
      if (stat.isSymbolicLink()) {
        files[relative] = { kind: 'link', hash: await fs.readlink(absolute), mode };
      } else if (stat.isDirectory()) {
        files[relative] = { kind: 'directory', hash: '', mode };
        await walk(absolute);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (maxBytes !== undefined && bytes > maxBytes) throw new Error('MIGRATION_FILE_TOO_LARGE');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        files[relative] = { kind: 'file', hash: hash.digest('hex'), mode };
      } else {
        throw new Error('worktree contains an unsupported filesystem entry');
      }
    }
  };
  await walk(root);
  return files;
}

export function sameWorktreeFiles(
  actual: Record<string, FileEvidence>,
  saved: Record<string, FileEvidence>,
  allowMissing = false,
): boolean {
  if (!allowMissing && Object.keys(actual).length !== Object.keys(saved).length) return false;
  return Object.entries(actual).every(([name, file]) => {
    const expected = saved[name];
    return expected?.kind === file.kind && expected.hash === file.hash && expected.mode === file.mode;
  });
}

function archivePath(directory: string, archive: Pick<WorktreeRecoveryArchive, 'file'>): string {
  if (!/^[a-f0-9-]+\.tar\.gz\.enc$/.test(archive.file)) throw new Error('invalid recovery archive path');
  return path.join(directory, archive.file);
}

function decryptArchive(archive: WorktreeRecoveryArchive, key: Uint8Array) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(archive.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(archive.tag, 'base64'));
  return decipher;
}

/** Fully authenticate before any restore is allowed to emit plaintext files. */
export async function verifyRecoveryArchive(archive: WorktreeRecoveryArchive, directory: string, key: Uint8Array, maxBytes?: number): Promise<void> {
  const files: Record<string, FileEvidence> = Object.create(null);
  const entries: Promise<void>[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      bytes += entry.size ?? 0;
      if (maxBytes !== undefined && bytes > maxBytes) throw new Error('MIGRATION_FILE_TOO_LARGE');
      const name = path.normalize(entry.path).replace(/[\\/]+$/, '');
      // An empty tree is represented by its root directory header (tar rejects zero-entry archives).
      if (name === '.' && entry.type === 'Directory' && Object.keys(archive.files).length === 0) {
        entry.resume();
        return;
      }
      if (path.isAbsolute(name) || name === '..' || name.startsWith(`..${path.sep}`) || name === '.git') {
        throw new Error('unsafe worktree archive entry');
      }
      if (!Object.hasOwn(archive.files, name) || seen.has(name)) throw new Error('unexpected worktree archive entry');
      seen.add(name);
      const check = (async () => {
        if (files[name]) throw new Error('duplicate worktree archive entry');
        const hash = createHash('sha256');
        for await (const chunk of entry) hash.update(chunk);
        const mode = restorableMode(entry.mode ?? 0);
        if (entry.type === 'Directory') files[name] = { kind: 'directory', hash: '', mode };
        else if (entry.type === 'SymbolicLink') {
          if (typeof entry.linkpath !== 'string') throw new Error('invalid archive symbolic link');
          files[name] = { kind: 'link', hash: entry.linkpath, mode };
        }
        else if (entry.type === 'Link') {
          if (typeof entry.linkpath !== 'string') throw new Error('invalid archive hard link');
          const target = archive.files[path.normalize(entry.linkpath)];
          if (target?.kind !== 'file') throw new Error('invalid archive hard link');
          files[name] = { ...target, mode };
        } else if (entry.type === 'File') files[name] = { kind: 'file', hash: hash.digest('hex'), mode };
        else throw new Error('unsupported worktree archive entry');
      })();
      // Handle rejection immediately even while the remaining encrypted stream drains.
      void check.catch(() => {});
      entries.push(check);
    },
  });
  await pipeline(createReadStream(archivePath(directory, archive)), decryptArchive(archive, key), parser);
  await Promise.all(entries);
  if (!sameWorktreeFiles(files, archive.files)) throw new Error('archive content does not match worktree inventory');
}

export async function createRecoveryArchive(root: string, resourceId: string, directory: string, key: Uint8Array, encryptedKey: string, iv: Uint8Array, maxBytes?: number): Promise<WorktreeRecoveryArchive> {
  const files = await inventoryWorktree(root, maxBytes);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const file = `${resourceId}-${randomUUID()}.tar.gz.enc`;
  await fs.mkdir(directory, { recursive: true });
  const target = archivePath(directory, { file });
  try {
    const names = Object.keys(files);
    // Keep one root header for an empty tree; noDirRecurse prevents capturing later additions.
    const packOptions = { cwd: root, gzip: true, follow: false, noDirRecurse: true, strict: true };
    const contents = tar.c(packOptions, names.length ? names : ['.']);
    await pipeline(
      contents,
      cipher,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await fs.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const archive = { file, encryptedKey, iv: Buffer.from(iv).toString('base64'), tag: cipher.getAuthTag().toString('base64'), files };
    await verifyRecoveryArchive(archive, directory, key, maxBytes);
    if (!sameWorktreeFiles(await inventoryWorktree(root), files)) throw new Error('worktree changed during archive');
    return archive;
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
}

/** Authenticate first; keep mode fills only missing bytes of a verified partial restore. */
export async function extractRecoveryArchive(archive: WorktreeRecoveryArchive, staging: string, keep: boolean, directory: string, key: Uint8Array, maxBytes?: number): Promise<void> {
  await verifyRecoveryArchive(archive, directory, key, maxBytes);
  await pipeline(
    createReadStream(archivePath(directory, archive)), decryptArchive(archive, key),
    tar.x({ cwd: staging, strict: true, preservePaths: false, unlink: !keep, keep }),
  );
  if (!sameWorktreeFiles(await inventoryWorktree(staging), archive.files)) {
    throw new Error('restored worktree files do not match recovery archive');
  }
}
