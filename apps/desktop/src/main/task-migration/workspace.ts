import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runRecoveryArchiveTask } from '../worktree/recoveryArchiveWorkerClient';
import type { FileEvidence, WorktreeRecoveryArchive } from '../worktree/recoveryArchiveIO';
import {
  captureWorktreeContent,
  worktreeContentBaselineMatches,
} from '../worktree/contentSnapshot';
import { gitExec, GitExecError } from '../worktree/gitExec';
import { assertDiskCapacity } from './resources';

export interface PortableWorkspace {
  version: 1;
  archive: WorktreeRecoveryArchive;
  key: string;
  unpackedBytes: number;
  contextBytes?: number;
  git?: { head: string; headRef: string | null; indexTree: string; ref: string };
}

/** Portable names only. In particular, links must never lead extraction outside its new root. */
export function validateWorkspaceEntries(files: Record<string, FileEvidence>): void {
  const folded = new Set<string>();

  for (const [name, entry] of Object.entries(files)) {
    const parts = name.split('/');
    if (
      !name ||
      name.length > 4096 ||
      name.includes('\\') ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          /[\x00-\x1f:*?"<>|]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
    ) {
      throw new Error('MIGRATION_NONPORTABLE_PATH');
    }
    const key = name.normalize('NFC').toLowerCase();
    if (folded.has(key)) throw new Error('MIGRATION_PATH_COLLISION');
    folded.add(key);
    if (
      !entry ||
      !['file', 'directory', 'link'].includes(entry.kind) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      typeof entry.hash !== 'string'
    )
      throw new Error('MIGRATION_INVALID_MANIFEST');
    if (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.hash))
      throw new Error('MIGRATION_INVALID_MANIFEST');
    if (entry.kind === 'directory' && entry.hash !== '')
      throw new Error('MIGRATION_INVALID_MANIFEST');
    if (entry.kind === 'link') {
      if (
        !entry.hash ||
        entry.hash.includes('\\') ||
        path.posix.isAbsolute(entry.hash) ||
        /^[a-z]:/i.test(entry.hash)
      )
        throw new Error('MIGRATION_EXTERNAL_LINK');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.hash));
      if (target === '..' || target.startsWith('../') || target.split('/').includes('.git'))
        throw new Error('MIGRATION_EXTERNAL_LINK');
      // Do not accept a link chain or a directory-link ancestor during extraction.
      const targetEntry = files[target];
      if (!targetEntry || targetEntry.kind === 'link') throw new Error('MIGRATION_EXTERNAL_LINK');
    }
    for (let i = 1; i < parts.length; i++) {
      if (files[parts.slice(0, i).join('/')]?.kind !== 'directory')
        throw new Error('MIGRATION_INVALID_MANIFEST');
    }
  }
}

/** No checkout, reset, stash, or source deletion. Existing recovery code preserves ignored bytes too. */
export async function snapshotWorkspace(
  root: string,
  directory: string,
  id: string,
): Promise<PortableWorkspace> {
  if ((await fs.lstat(root)).isSymbolicLink()) root = await fs.realpath(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let git: PortableWorkspace['git'];
  let baseline: Awaited<ReturnType<typeof captureWorktreeContent>> | undefined;
  try {
    const probe = await gitExec(['rev-parse', '--show-toplevel'], root, {
      extraEnv: { LC_ALL: 'C' },
    });
    if ((await fs.realpath(probe.stdout.trim())) !== (await fs.realpath(root)))
      throw new Error('MIGRATION_REQUIRES_REPOSITORY_ROOT');
    const entries = await gitExec(['ls-files', '--stage', '-z'], root);
    if (entries.stdout.split('\0').some((entry) => entry.startsWith('160000 ')))
      throw new Error('MIGRATION_SUBMODULE_UNSUPPORTED');
    baseline = await captureWorktreeContent(root, `refs/cindy/migration/${id}`);
    git = {
      head: baseline.head,
      headRef: baseline.headRef ?? null,
      indexTree: baseline.indexTree,
      ref: baseline.ref,
    };
    await gitExec(
      ['bundle', 'create', path.join(directory, 'repository.bundle'), baseline.ref],
      root,
    );
  } catch (error) {
    // Only a positive "not a repository" verdict means plain directory. Other Git failures are real.
    if (!(error instanceof GitExecError) || !error.stderr.includes('not a git repository'))
      throw error;
  }
  const key = randomBytes(32);
  try {
    const space = await fs.statfs(directory);
    const archive = await runRecoveryArchiveTask({
      operation: 'create',
      root,
      directory,
      resourceId: id,
      key: new Uint8Array(key),
      encryptedKey: '',
      iv: randomBytes(12),
      maxBytes: Math.floor((space.bavail * space.bsize) / 1.1),
    });
    archive.files = Object.fromEntries(
      Object.entries(archive.files).map(([name, entry]) => [name.split(path.sep).join('/'), entry]),
    );
    validateWorkspaceEntries(archive.files);
    let unpackedBytes = 0;
    for (const [name, entry] of Object.entries(archive.files)) {
      if (entry.kind === 'file') unpackedBytes += (await fs.lstat(path.join(root, name))).size;
    }
    if (!Number.isSafeInteger(unpackedBytes)) throw new Error('MIGRATION_INVALID_MANIFEST');
    if (baseline && !(await worktreeContentBaselineMatches(root, baseline)))
      throw new Error('MIGRATION_WORKSPACE_CHANGED');
    return {
      version: 1,
      archive,
      key: key.toString('base64'),
      unpackedBytes,
      ...(git ? { git } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('MIGRATION_FILE_TOO_LARGE'))
      throw new Error('MIGRATION_NO_SPACE');
    throw error;
  } finally {
    key.fill(0);
  }
}

/** Caller supplies a newly-created private directory, never an existing user checkout. */
export async function restoreWorkspace(
  snapshot: PortableWorkspace,
  directory: string,
  target: string,
): Promise<void> {
  if (
    snapshot.version !== 1 ||
    !Number.isSafeInteger(snapshot.unpackedBytes) ||
    snapshot.unpackedBytes < 0 ||
    !/^[a-f0-9-]+\.tar\.gz\.enc$/.test(snapshot.archive.file) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(snapshot.key)
  )
    throw new Error('MIGRATION_INVALID_MANIFEST');
  validateWorkspaceEntries(snapshot.archive.files);
  if ((await fs.readdir(target)).length) throw new Error('MIGRATION_TARGET_NOT_EMPTY');
  const repositoryBytes = snapshot.git
    ? (await fs.stat(path.join(directory, 'repository.bundle'))).size
    : 0;
  await assertDiskCapacity([
    {
      path: target,
      bytes:
        snapshot.unpackedBytes +
        repositoryBytes * 3 +
        Object.keys(snapshot.archive.files).length * 4096,
    },
  ]);
  const archive = {
    ...snapshot.archive,
    files: Object.fromEntries(
      Object.entries(snapshot.archive.files).map(([name, entry]) => [
        name.split('/').join(path.sep),
        { ...entry, mode: entry.mode & (process.platform === 'win32' ? 0o666 : 0o777) },
      ]),
    ),
  };
  const key = Buffer.from(snapshot.key, 'base64');
  try {
    await runRecoveryArchiveTask({
      operation: 'extract',
      archive,
      directory,
      staging: target,
      keep: false,
      key: new Uint8Array(key),
      maxBytes: snapshot.unpackedBytes,
    });
  } finally {
    key.fill(0);
  }
  const git = snapshot.git;
  if (git) {
    if (
      ![git.head, git.indexTree].every((value) => /^[a-f0-9]{40,64}$/.test(value)) ||
      !/^refs\/cindy\/migration\/[a-f0-9-]{36}$/.test(git.ref) ||
      (git.headRef !== null && !git.headRef.startsWith('refs/heads/'))
    )
      throw new Error('MIGRATION_INVALID_MANIFEST');
    // Rebuild Git metadata locally; never copy source .git links, hooks, credentials or config.
    await gitExec(['init', '--template=', target], directory);
    await gitExec(
      ['fetch', '--no-tags', path.join(directory, 'repository.bundle'), `${git.ref}:${git.ref}`],
      target,
    );
    if (git.headRef) {
      await gitExec(['check-ref-format', git.headRef], target);
      await gitExec(['update-ref', git.headRef, git.head], target);
      await gitExec(['symbolic-ref', 'HEAD', git.headRef], target);
    } else await gitExec(['update-ref', '--no-deref', 'HEAD', git.head], target);
    // Restore index separately from working files, retaining staged-only and unstaged changes.
    await gitExec(['read-tree', git.indexTree], target);
  }
}
