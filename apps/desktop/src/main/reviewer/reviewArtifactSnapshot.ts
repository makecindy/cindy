import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isPathWithinReviewWorkspace,
  reviewArtifactFileLinkLayoutIsSafe,
  reviewArtifactPathIdentityMatches,
  ReviewArtifactAuthorizationError,
  type ReviewArtifactPathIdentity,
  type ReviewExplicitArtifactGrant,
} from './reviewArtifactAuthorization.js';
import {
  prepareWithStableReviewArtifacts,
  type ReviewArtifactFileOpener,
} from './reviewArtifactFingerprint.js';
import {
  reviewRunOwnerStatus,
  type ReviewOwnerLivenessProbe,
  type ReviewProcessAliveProbe,
} from './reviewRunRecovery.js';
import { readReviewRunOwner, type ReviewRunOwner } from '../../shared/reviewRun.js';

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 128 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const SNAPSHOT_ROOT_PREFIX = 'cindy-review-artifacts-v2-';
const SNAPSHOT_ROOT_NAME = /^cindy-review-artifacts-v(1|2)-(\d+)-[A-Za-z0-9]{6}$/;
const SNAPSHOT_OWNER_SUFFIX = '.owner.json';
const SNAPSHOT_OWNER_MAX_BYTES = 4 * 1024;
const DEFAULT_UNVERIFIABLE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_SNAPSHOT_ROOTS = new Map<string, string>();

export interface MaterializedReviewArtifacts {
  grant: ReviewExplicitArtifactGrant;
  cleanup(): Promise<void>;
}

export interface PreparedStableReviewArtifacts<T> {
  value: T;
  fingerprint: string;
  grant: ReviewExplicitArtifactGrant;
  cleanup(): Promise<void>;
}

export function reviewArtifactSnapshotStatMatches(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.mode === after.mode
  );
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ReviewArtifactSnapshotOwnerRecord {
  version: 1;
  createdAt: number;
  owner: ReviewRunOwner;
}

function snapshotOwnerPath(snapshotRoot: string): string {
  return `${snapshotRoot}${SNAPSHOT_OWNER_SUFFIX}`;
}

function readSnapshotOwnerRecord(value: unknown): ReviewArtifactSnapshotOwnerRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const owner = readReviewRunOwner(record.owner);
  if (
    record.version !== 1 ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt <= 0 ||
    !owner
  ) {
    return null;
  }
  return { version: 1, createdAt: record.createdAt, owner };
}

async function loadSnapshotOwnerRecord(
  snapshotRoot: string,
  expectedProcessId: number,
  currentUid: number | null,
): Promise<ReviewArtifactSnapshotOwnerRecord | null> {
  const ownerPath = snapshotOwnerPath(snapshotRoot);
  const before = await fs.lstat(ownerPath).catch(() => null);
  if (
    !before ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > SNAPSHOT_OWNER_MAX_BYTES ||
    (currentUid !== null && before.uid !== currentUid)
  ) {
    return null;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(ownerPath, constants.O_RDONLY | NOFOLLOW_FLAG);
    const opened = await handle.stat();
    if (!reviewArtifactSnapshotStatMatches(before, opened)) return null;
    const raw = await handle.readFile({ encoding: 'utf8' });
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(ownerPath).catch(() => null);
    if (
      !reviewArtifactSnapshotStatMatches(opened, afterHandle) ||
      !afterPath ||
      afterPath.isSymbolicLink() ||
      !reviewArtifactSnapshotStatMatches(opened, afterPath)
    ) {
      return null;
    }
    const record = readSnapshotOwnerRecord(JSON.parse(raw) as unknown);
    return record?.owner.processId === expectedProcessId ? record : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function snapshotIsExpired(
  stat: Stats,
  createdAt: number | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  const lastKnownActiveAt = createdAt ?? Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
  return now - lastKnownActiveAt >= maxAgeMs;
}

/**
 * Reclaims snapshot roots left by a terminated Cindy process. The versioned,
 * PID-scoped name and ownership checks deliberately avoid broad temp cleanup.
 */
export async function cleanupOrphanedReviewArtifactSnapshots(options: {
  currentOwner: ReviewRunOwner;
  tempRoot?: string;
  processIsAlive?: ReviewProcessAliveProbe;
  ownerLivenessProbe?: ReviewOwnerLivenessProbe;
  now?: () => number;
  maxUnverifiableAgeMs?: number;
}): Promise<void> {
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const now = options.now?.() ?? Date.now();
  const maxUnverifiableAgeMs =
    options.maxUnverifiableAgeMs ?? DEFAULT_UNVERIFIABLE_SNAPSHOT_MAX_AGE_MS;
  if (!Number.isFinite(maxUnverifiableAgeMs) || maxUnverifiableAgeMs < 0) {
    throw new TypeError('maxUnverifiableAgeMs must be a non-negative finite number');
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = SNAPSHOT_ROOT_NAME.exec(entry.name);
    if (!match) continue;
    const snapshotVersion = Number(match[1]);
    const ownerPid = Number(match[2]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) continue;

    const candidate = path.join(tempRoot, entry.name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (currentUid !== null && stat.uid !== currentUid) continue;

    const ownerRecord =
      snapshotVersion === 2 ? await loadSnapshotOwnerRecord(candidate, ownerPid, currentUid) : null;
    const owner =
      ownerRecord?.owner ??
      ({
        instanceId: `legacy-snapshot:${entry.name}`,
        processId: ownerPid,
      } satisfies ReviewRunOwner);
    const status = await reviewRunOwnerStatus(
      owner,
      options.currentOwner,
      processIsAlive,
      options.ownerLivenessProbe,
    );
    if (status === 'alive') continue;
    if (
      status === 'unknown' &&
      !snapshotIsExpired(stat, ownerRecord?.createdAt, now, maxUnverifiableAgeMs)
    ) {
      continue;
    }

    await fs.rm(candidate, { recursive: true, force: true });
    await fs.rm(snapshotOwnerPath(candidate), { force: true });
  }

  // A crash between root removal and sidecar removal must not leave the exact
  // liveness challenge behind indefinitely in the shared temp directory.
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SNAPSHOT_OWNER_SUFFIX)) continue;
    const rootName = entry.name.slice(0, -SNAPSHOT_OWNER_SUFFIX.length);
    if (!SNAPSHOT_ROOT_NAME.test(rootName)) continue;
    const ownerPath = path.join(tempRoot, entry.name);
    const rootPath = path.join(tempRoot, rootName);
    if (await fs.lstat(rootPath).catch(() => null)) continue;
    const ownerStat = await fs.lstat(ownerPath).catch(() => null);
    if (
      !ownerStat ||
      ownerStat.isSymbolicLink() ||
      !ownerStat.isFile() ||
      (currentUid !== null && ownerStat.uid !== currentUid)
    ) {
      continue;
    }
    await fs.rm(ownerPath, { force: true });
  }
}

async function removeSnapshotRoot(snapshotRoot: string, ownerPath: string): Promise<void> {
  await fs.rm(snapshotRoot, { recursive: true, force: true });
  await fs.rm(ownerPath, { force: true });
  ACTIVE_SNAPSHOT_ROOTS.delete(snapshotRoot);
}

/** Remove every private snapshot still owned by this Main process on clean exit. */
export async function cleanupActiveReviewArtifactSnapshots(): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    [...ACTIVE_SNAPSHOT_ROOTS].map(async ([snapshotRoot, ownerPath]) => {
      try {
        await removeSnapshotRoot(snapshotRoot, ownerPath);
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length > 0) {
    throw new Error(`Failed to clean ${failures.length} active Review artifact snapshot(s)`);
  }
}

function safeSnapshotExtension(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

async function copyOpenFile(
  sourcePath: string,
  destinationPath: string,
  expectedIdentity: ReviewArtifactPathIdentity,
  canonicalWorkingDir: string | null,
  openFile: ReviewArtifactFileOpener,
): Promise<number> {
  const source = await openFile(sourcePath, constants.O_RDONLY | NOFOLLOW_FLAG).catch((error) => {
    throw new ReviewArtifactAuthorizationError(
      'A review artifact changed after permission was granted',
      { cause: error },
    );
  });
  let destination: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const canonicalPath = await fs.realpath(sourcePath);
    if (path.resolve(canonicalPath) !== path.resolve(sourcePath)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed after permission was granted',
      );
    }
    const before = await source.stat();
    if (!reviewArtifactPathIdentityMatches(expectedIdentity, before)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed after permission was granted',
      );
    }
    if (!before.isFile()) {
      throw new ReviewArtifactAuthorizationError('Review only snapshots regular files');
    }
    if (!(await reviewArtifactFileLinkLayoutIsSafe(sourcePath, canonicalWorkingDir, before))) {
      throw new ReviewArtifactAuthorizationError('Review refused a multiply linked artifact file');
    }
    if (before.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact is larger than the 64 MB local snapshot limit',
      );
    }

    destination = await fs.open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let sourceOffset = 0;
    while (sourceOffset < before.size) {
      const requested = Math.min(buffer.length, before.size - sourceOffset);
      const { bytesRead } = await source.read(buffer, 0, requested, sourceOffset);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
      sourceOffset += bytesRead;
    }
    const after = await source.stat();
    const afterPath = await fs.lstat(sourcePath).catch(() => null);
    const afterHandleLayoutIsSafe = await reviewArtifactFileLinkLayoutIsSafe(
      sourcePath,
      canonicalWorkingDir,
      after,
    );
    const afterPathLayoutIsSafe = afterPath
      ? await reviewArtifactFileLinkLayoutIsSafe(sourcePath, canonicalWorkingDir, afterPath)
      : false;
    if (
      sourceOffset !== before.size ||
      !reviewArtifactSnapshotStatMatches(before, after) ||
      !afterHandleLayoutIsSafe ||
      !afterPath ||
      afterPath.isSymbolicLink() ||
      !afterPathLayoutIsSafe ||
      !reviewArtifactPathIdentityMatches(expectedIdentity, afterPath)
    ) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed while its private snapshot was being prepared',
      );
    }
    await destination.sync();
    await destination.chmod(0o600);
    return before.size;
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

/**
 * Copies every explicitly granted file to a per-run private directory. The
 * reviewer and provider receive only these immutable paths, so replacing an
 * approved path after consent cannot change the bytes sent to the model.
 */
export async function materializeReviewArtifactSnapshots(input: {
  workingDir: string;
  grant: ReviewExplicitArtifactGrant;
  owner: ReviewRunOwner;
  /** Test seam for deterministic lstat/open replacement coverage. */
  openFile?: ReviewArtifactFileOpener;
}): Promise<MaterializedReviewArtifacts> {
  if (
    !readReviewRunOwner(input.owner) ||
    input.owner.processId !== process.pid ||
    !input.owner.liveness
  ) {
    throw new Error('Review artifact snapshot owner is not ready');
  }
  const canonicalWorkingDir = await fs.realpath(input.workingDir).catch(() => null);
  const snapshotPaths = new Map<string, string>();
  const liveDirectoryPaths: string[] = [];
  let snapshotRoot: string | null = null;
  let ownerPath: string | null = null;
  let cleaned = false;
  let cleanupPromise: Promise<void> | null = null;
  let totalBytes = 0;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    if (!snapshotRoot) {
      cleaned = true;
      return;
    }
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await removeSnapshotRoot(snapshotRoot!, ownerPath!);
        cleaned = true;
      })();
    }
    try {
      await cleanupPromise;
    } finally {
      cleanupPromise = null;
    }
  };

  try {
    for (const [index, sourcePath] of [...new Set(input.grant.paths)].entries()) {
      const expectedIdentity = input.grant.pathIdentities.get(sourcePath);
      if (!expectedIdentity) {
        throw new ReviewArtifactAuthorizationError(
          'A review artifact has no permission-time identity',
        );
      }
      const entry = await fs.lstat(sourcePath).catch(() => null);
      if (
        !entry ||
        entry.isSymbolicLink() ||
        !reviewArtifactPathIdentityMatches(expectedIdentity, entry)
      ) {
        throw new ReviewArtifactAuthorizationError(
          'A review artifact changed after permission was granted',
        );
      }
      if (entry.isDirectory()) {
        if (!canonicalWorkingDir || !isPathWithinReviewWorkspace(canonicalWorkingDir, sourcePath)) {
          throw new ReviewArtifactAuthorizationError(
            'Review external directories one file at a time',
          );
        }
        liveDirectoryPaths.push(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ReviewArtifactAuthorizationError('Review only snapshots regular files');
      }
      if (!(await reviewArtifactFileLinkLayoutIsSafe(sourcePath, canonicalWorkingDir, entry))) {
        throw new ReviewArtifactAuthorizationError(
          'Review refused a multiply linked artifact file',
        );
      }

      if (!snapshotRoot) {
        snapshotRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), `${SNAPSHOT_ROOT_PREFIX}${input.owner.processId}-`),
        );
        ownerPath = snapshotOwnerPath(snapshotRoot);
        try {
          await fs.chmod(snapshotRoot, 0o700);
          const ownerRecord: ReviewArtifactSnapshotOwnerRecord = {
            version: 1,
            createdAt: Date.now(),
            owner: input.owner,
          };
          await fs.writeFile(ownerPath, JSON.stringify(ownerRecord), {
            encoding: 'utf8',
            flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
            mode: 0o600,
          });
          ACTIVE_SNAPSHOT_ROOTS.set(snapshotRoot, ownerPath);
        } catch (error) {
          await fs.rm(snapshotRoot, { recursive: true, force: true });
          await fs.rm(ownerPath, { force: true });
          snapshotRoot = null;
          ownerPath = null;
          throw error;
        }
      }
      const key = createHash('sha256').update(sourcePath, 'utf8').digest('hex').slice(0, 16);
      const destinationPath = path.join(
        snapshotRoot,
        `${String(index + 1).padStart(2, '0')}-${key}${safeSnapshotExtension(sourcePath)}`,
      );
      totalBytes += await copyOpenFile(
        sourcePath,
        destinationPath,
        expectedIdentity,
        canonicalWorkingDir,
        input.openFile ?? ((filePath, flags) => fs.open(filePath, flags)),
      );
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new ReviewArtifactAuthorizationError(
          'Review artifacts exceed the 128 MB local snapshot limit',
        );
      }
      snapshotPaths.set(sourcePath, destinationPath);
    }

    return {
      grant: {
        ...input.grant,
        snapshotPaths,
        liveDirectoryPaths,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Fingerprints live files before snapshotting and again after evidence has
 * been extracted from the private copies. This prevents a stale snapshot from
 * being paired with a newer publish baseline.
 */
export async function prepareStableReviewArtifactSnapshots<T>(input: {
  workingDir: string;
  grant: ReviewExplicitArtifactGrant;
  owner: ReviewRunOwner;
  prepare: (snapshotGrant: ReviewExplicitArtifactGrant) => Promise<T>;
}): Promise<PreparedStableReviewArtifacts<T>> {
  const holder: { materialized?: MaterializedReviewArtifacts } = {};
  try {
    const stable = await prepareWithStableReviewArtifacts(
      input.grant.paths,
      async () => {
        holder.materialized = await materializeReviewArtifactSnapshots({
          workingDir: input.workingDir,
          grant: input.grant,
          owner: input.owner,
        });
        return input.prepare(holder.materialized.grant);
      },
      { linkConfinementRoot: input.workingDir },
    );
    const ready = holder.materialized;
    if (!ready) throw new Error('Review artifact snapshots were not prepared');
    return {
      ...stable,
      grant: ready.grant,
      cleanup: ready.cleanup,
    };
  } catch (error) {
    await holder.materialized?.cleanup();
    throw error;
  }
}
