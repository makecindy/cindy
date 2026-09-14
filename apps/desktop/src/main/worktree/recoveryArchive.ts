import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { safeStorage } from 'electron';
import * as tar from 'tar';

import { recycleJournalRoot } from './recycleJournal';

interface FileEvidence {
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

export async function inventoryWorktree(root: string): Promise<Record<string, FileEvidence>> {
  const files: Record<string, FileEvidence> = Object.create(null);
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

function archivePath(archive: Pick<WorktreeRecoveryArchive, 'file'>): string {
  if (!/^[a-f0-9-]+\.tar\.gz\.enc$/.test(archive.file)) throw new Error('invalid recovery archive path');
  return path.join(recycleJournalRoot(), archive.file);
}

function decryptArchive(archive: WorktreeRecoveryArchive) {
  const key = Buffer.from(safeStorage.decryptString(Buffer.from(archive.encryptedKey, 'base64')), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(archive.iv, 'base64'));
  key.fill(0);
  decipher.setAuthTag(Buffer.from(archive.tag, 'base64'));
  return decipher;
}

/** Fully authenticate before any restore is allowed to emit plaintext files. */
export async function verifyRecoveryArchive(archive: WorktreeRecoveryArchive): Promise<void> {
  const files: Record<string, FileEvidence> = Object.create(null);
  const entries: Promise<void>[] = [];
  const parser = tar.t({
    strict: true,
    onReadEntry(entry) {
      const name = path.normalize(entry.path).replace(/[\\/]+$/, '');
      if (path.isAbsolute(name) || name === '..' || name.startsWith(`..${path.sep}`) || name === '.git') {
        throw new Error('unsafe worktree archive entry');
      }
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
  await pipeline(createReadStream(archivePath(archive)), decryptArchive(archive), parser);
  await Promise.all(entries);
  if (!sameWorktreeFiles(files, archive.files)) throw new Error('archive content does not match worktree inventory');
}

export async function createRecoveryArchive(root: string, resourceId: string): Promise<WorktreeRecoveryArchive> {
  const files = await inventoryWorktree(root);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const encryptedKey = safeStorage.encryptString(key.toString('base64')).toString('base64');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  key.fill(0);
  const file = `${resourceId}-${randomUUID()}.tar.gz.enc`;
  await fs.mkdir(recycleJournalRoot(), { recursive: true });
  const target = archivePath({ file });
  try {
    await pipeline(
      tar.c({ cwd: root, gzip: true, follow: false, noDirRecurse: true, strict: true }, Object.keys(files)),
      cipher,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await fs.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const archive = { file, encryptedKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), files };
    await verifyRecoveryArchive(archive);
    if (!sameWorktreeFiles(await inventoryWorktree(root), files)) throw new Error('worktree changed during archive');
    return archive;
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
}

/** Authenticate first; keep mode fills only missing bytes of a verified partial restore. */
export async function extractRecoveryArchive(archive: WorktreeRecoveryArchive, staging: string, keep = false): Promise<void> {
  await verifyRecoveryArchive(archive);
  await pipeline(
    createReadStream(archivePath(archive)), decryptArchive(archive),
    tar.x({ cwd: staging, strict: true, preservePaths: false, unlink: !keep, keep }),
  );
  if (!sameWorktreeFiles(await inventoryWorktree(staging), archive.files)) {
    throw new Error('restored worktree files do not match recovery archive');
  }
}
