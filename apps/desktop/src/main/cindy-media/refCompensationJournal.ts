/**
 * Durable compensation journal for staged cindy-media references.
 *
 * A DbClient worker can commit an INSERT and disappear before its RPC ACK is
 * delivered. The caller then knows the reserved reference id, but an immediate
 * DELETE through the same disposed worker can fail as well. A small owner-scoped
 * file journal keeps those exact ids outside the worker lifecycle so the next
 * ready DbClient for the same owner can finish the idempotent compensation.
 *
 * The journal deliberately stores no media hashes, paths, labels or raw owner
 * ids. `.pending` means the ids must be removed; ordinary `.committed` means
 * the ingest completed and only the marker itself may be collected. A
 * committed record carrying `rollbackRequired` is compensated like pending.
 */

import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  activeOwnerScopeKey,
  dataOwnerStorageKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { createLogger } from '../logger.js';
import * as ledger from './ledger.js';
import type { LedgerDb } from './ledger.js';

const log = createLogger('cindy-media-ref-compensation');

const JOURNAL_VERSION = 1 as const;
const JOURNAL_DIRECTORY = 'ref-compensation-v1';
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_REF_IDS = 256;
const MAX_SCAN_ENTRIES = 1_024;
const JOURNAL_LOCK_WAIT_MS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_KEY_PATTERN = /^[0-9a-f]{20}$/;

type JournalState = 'pending' | 'committed';

interface RefCompensationRecord {
  version: typeof JOURNAL_VERSION;
  operationId: string;
  ownerStorageKey: string;
  createdAt: number;
  refIds: string[];
  rollbackRequired?: true;
}

export interface MediaRefCompensationScope {
  readonly journalDir: string;
  readonly ownerStorageKey: string;
  assertStillValid(): void;
}

export interface MediaRefCompensationReconcileResult {
  recoveredPending: number;
  removedCommitted: number;
  busy: number;
  skipped: number;
}

interface JournalPaths {
  operationId: string;
  pending: string;
  committed: string;
  lock: string;
}

function ownerJournalDir(ownerStorageKey: string): string {
  return path.join(
    app.getPath('userData'),
    'owners',
    ownerStorageKey,
    'cindy-media',
    JOURNAL_DIRECTORY,
  );
}

/** Capture the owner identity and path synchronously before any async ingest work. */
export function captureMediaRefCompensationScope(
  expectedOwnerScopeKey: string = activeOwnerScopeKey(),
): MediaRefCompensationScope {
  const session = getActiveAppSession();
  const ownerId = session.dataOwnerId;
  if (
    !ownerId ||
    isAppSessionBoundaryPending() ||
    activeOwnerScopeKey() !== expectedOwnerScopeKey
  ) {
    throw new Error('cindy-media: cannot capture compensation journal outside a stable owner');
  }
  const ownerStorageKey = dataOwnerStorageKey(ownerId);
  return {
    journalDir: ownerJournalDir(ownerStorageKey),
    ownerStorageKey,
    assertStillValid(): void {
      const current = getActiveAppSession();
      if (
        isAppSessionBoundaryPending() ||
        activeOwnerScopeKey() !== expectedOwnerScopeKey ||
        current.dataOwnerId !== ownerId
      ) {
        throw new Error('cindy-media: data owner changed during reference ingest');
      }
    },
  };
}

function pathsFor(journalDir: string, operationId: string): JournalPaths {
  return {
    operationId,
    pending: path.join(journalDir, `${operationId}.pending.json`),
    committed: path.join(journalDir, `${operationId}.committed.json`),
    lock: path.join(journalDir, `${operationId}.lock`),
  };
}

async function assertSafeJournalDirectory(journalDir: string): Promise<void> {
  const info = await lstat(journalDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('cindy-media: reference compensation path is not a safe directory');
  }
}

async function syncDirectory(journalDir: string): Promise<void> {
  // Windows does not support opening directories for fsync. The simulator
  // producer is macOS-only, while other guarded media paths remain portable.
  if (process.platform === 'win32') return;
  const directory = await open(journalDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writePendingRecord(
  scope: MediaRefCompensationScope,
  paths: JournalPaths,
  refIds: readonly string[],
): Promise<RefCompensationRecord> {
  await mkdir(scope.journalDir, { recursive: true, mode: 0o700 });
  await assertSafeJournalDirectory(scope.journalDir);
  scope.assertStillValid();

  const record: RefCompensationRecord = {
    version: JOURNAL_VERSION,
    operationId: paths.operationId,
    ownerStorageKey: scope.ownerStorageKey,
    createdAt: Date.now(),
    refIds: [...refIds],
  };
  const temporary = path.join(
    scope.journalDir,
    `.${paths.operationId}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, paths.pending);
    await syncDirectory(scope.journalDir);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return record;
}

async function removeMarker(markerPath: string, journalDir: string): Promise<void> {
  await rm(markerPath, { force: true });
  await syncDirectory(journalDir);
}

async function markRollbackRequired(
  paths: JournalPaths,
  record: RefCompensationRecord,
): Promise<void> {
  const handle = await open(paths.committed, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...record, rollbackRequired: true })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(paths.committed));
}

async function removeOperationMarkers(paths: JournalPaths, journalDir: string): Promise<void> {
  await Promise.all([rm(paths.pending, { force: true }), rm(paths.committed, { force: true })]);
  await syncDirectory(journalDir);
}

async function commitRecord(
  scope: MediaRefCompensationScope,
  paths: JournalPaths,
  record: RefCompensationRecord,
): Promise<void> {
  await rename(paths.pending, paths.committed);

  // The rename is not a crash-durable commit until the parent directory is
  // synced. If durability cannot be confirmed, fail the ingest so the caller's
  // exact-id compensation runs; returning success could later resurrect the
  // pre-rename `.pending` state after a power loss and make startup delete a ref
  // already handed to the caller. Keep the visible `.committed` marker as a
  // harmless GC marker while propagating the uncertainty.
  try {
    await syncDirectory(scope.journalDir);
  } catch (error) {
    log.warn('Failed to sync a committed media reference journal', {
      operationId: paths.operationId,
      error: String(error),
    });
    // If recovery sees the old name it is already pending. If it sees the new
    // name, this fsynced inode flag makes committed compensate as well.
    await markRollbackRequired(paths, record).catch((markError) => {
      log.warn('Failed to mark an uncertain media reference commit for rollback', {
        operationId: paths.operationId,
        error: String(markError),
      });
    });
    throw Object.assign(
      new Error('cindy-media: reference journal commit durability is uncertain'),
      { code: 'REF_JOURNAL_COMMIT_UNCERTAIN', cause: error },
    );
  }
}

/**
 * Run staged ref INSERTs behind a durable pending marker. `compensate` must be
 * idempotent and delete only the supplied reserved id.
 */
export async function withMediaRefCompensation<T>(params: {
  scope: MediaRefCompensationScope;
  refIds: readonly string[];
  perform: () => Promise<T>;
  compensate: (refId: string) => Promise<unknown>;
}): Promise<T> {
  if (params.refIds.length === 0 || params.refIds.length > MAX_REF_IDS) {
    throw new Error('cindy-media: invalid reference compensation batch size');
  }
  if (!params.refIds.every((id) => UUID_PATTERN.test(id))) {
    throw new Error('cindy-media: invalid staged reference id');
  }
  if (!OWNER_KEY_PATTERN.test(params.scope.ownerStorageKey)) {
    throw new Error('cindy-media: invalid compensation owner namespace');
  }

  params.scope.assertStillValid();
  await mkdir(params.scope.journalDir, { recursive: true, mode: 0o700 });
  await assertSafeJournalDirectory(params.scope.journalDir);
  const paths = pathsFor(params.scope.journalDir, randomUUID());

  return withCrossProcessLock(
    paths.lock,
    { label: 'cindy-media-ref-compensation', waitMs: JOURNAL_LOCK_WAIT_MS },
    async (status) => {
      if (!status.held) {
        throw new Error('cindy-media: reference compensation journal lock unavailable');
      }

      const record = await writePendingRecord(params.scope, paths, params.refIds);
      let recordCommitted = false;
      try {
        params.scope.assertStillValid();
        const result = await params.perform();
        params.scope.assertStillValid();
        await commitRecord(params.scope, paths, record);
        recordCommitted = true;
        params.scope.assertStillValid();
        await removeMarker(paths.committed, params.scope.journalDir).catch((error) => {
          log.warn('Failed to collect a committed media reference journal', {
            operationId: paths.operationId,
            error: String(error),
          });
        });
        params.scope.assertStillValid();
        return result;
      } catch (error) {
        if (recordCommitted) {
          await markRollbackRequired(paths, record).catch((markError) => {
            log.warn('Failed to preserve an invalidated media reference commit for rollback', {
              operationId: paths.operationId,
              error: String(markError),
            });
          });
        }
        const rollback = await Promise.allSettled(params.refIds.map(params.compensate));
        const rollbackFailed = rollback.some((result) => result.status === 'rejected');
        rollback.forEach((result, index) => {
          if (result.status === 'rejected') {
            log.warn('Failed to compensate a staged media reference', {
              operationId: paths.operationId,
              refId: params.refIds[index],
              error: String(result.reason),
            });
          }
        });
        if (!rollbackFailed) {
          await removeOperationMarkers(paths, params.scope.journalDir).catch((cleanupError) => {
            // Keeping a pending marker is safe: startup will repeat idempotent
            // exact-id deletes. Never replace the original ingest error.
            log.warn('Failed to collect a compensated media reference journal', {
              operationId: paths.operationId,
              error: String(cleanupError),
            });
          });
        }
        throw error;
      }
    },
  );
}

function parseJournalRecord(
  raw: string,
  operationId: string,
  ownerStorageKey: string,
): RefCompensationRecord | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Partial<RefCompensationRecord>;
  if (
    record.version !== JOURNAL_VERSION ||
    record.operationId !== operationId ||
    record.ownerStorageKey !== ownerStorageKey ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt ?? 0) <= 0 ||
    !Array.isArray(record.refIds) ||
    record.refIds.length === 0 ||
    record.refIds.length > MAX_REF_IDS ||
    !record.refIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id)) ||
    new Set(record.refIds).size !== record.refIds.length ||
    (record.rollbackRequired !== undefined && record.rollbackRequired !== true)
  ) {
    return null;
  }
  return record as RefCompensationRecord;
}

async function readJournalRecord(
  filePath: string,
  operationId: string,
  ownerStorageKey: string,
): Promise<RefCompensationRecord | null> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JOURNAL_BYTES) return null;
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(filePath, flags);
  let raw: string;
  let opened: Awaited<ReturnType<typeof handle.stat>>;
  try {
    opened = await handle.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.size > MAX_JOURNAL_BYTES
    ) {
      return null;
    }
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_JOURNAL_BYTES) return null;
  return parseJournalRecord(raw, operationId, ownerStorageKey);
}

function parseJournalName(name: string): { operationId: string; state: JournalState } | null {
  const match = /^([0-9a-f-]+)\.(pending|committed)\.json$/i.exec(name);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  return { operationId: match[1], state: match[2] as JournalState };
}

/** Replay journals only for the explicitly supplied, currently ready owner DB. */
export async function reconcileMediaRefCompensationsForOwner(params: {
  ownerId: string;
  db: LedgerDb;
  isOwnerCurrent: () => boolean;
}): Promise<MediaRefCompensationReconcileResult> {
  const ownerStorageKey = dataOwnerStorageKey(params.ownerId);
  const journalDir = ownerJournalDir(ownerStorageKey);
  const result: MediaRefCompensationReconcileResult = {
    recoveredPending: 0,
    removedCommitted: 0,
    busy: 0,
    skipped: 0,
  };

  if (!params.isOwnerCurrent()) return result;
  const entries = await (async () => {
    try {
      return await readdir(journalDir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (!entries) return result;
  if (!params.isOwnerCurrent()) return result;

  const candidates = entries
    .map((entry) => ({ entry, parsed: parseJournalName(entry.name) }))
    .filter(
      (
        candidate,
      ): candidate is {
        entry: (typeof entries)[number];
        parsed: NonNullable<ReturnType<typeof parseJournalName>>;
      } => candidate.parsed !== null,
    );
  const stateCountByOperation = new Map<string, number>();
  for (const { parsed } of candidates) {
    stateCountByOperation.set(
      parsed.operationId,
      (stateCountByOperation.get(parsed.operationId) ?? 0) + 1,
    );
  }

  for (const { entry, parsed } of candidates.slice(0, MAX_SCAN_ENTRIES)) {
    if ((stateCountByOperation.get(parsed.operationId) ?? 0) !== 1) {
      // A valid atomic rename can never leave both states. Preserve both
      // instead of guessing and potentially deleting refs from a committed op.
      result.skipped += 1;
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      result.skipped += 1;
      continue;
    }
    if (!params.isOwnerCurrent()) break;
    const paths = pathsFor(journalDir, parsed.operationId);
    const markerPath = parsed.state === 'pending' ? paths.pending : paths.committed;
    await withCrossProcessLock(
      paths.lock,
      { label: 'cindy-media-ref-compensation-reconcile', waitMs: JOURNAL_LOCK_WAIT_MS },
      async (status) => {
        if (!status.held) {
          result.busy += 1;
          return;
        }
        if (!params.isOwnerCurrent()) return;
        let record: RefCompensationRecord | null;
        try {
          record = await readJournalRecord(markerPath, parsed.operationId, ownerStorageKey);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          log.warn('Failed to read a media reference compensation journal', {
            operationId: parsed.operationId,
            state: parsed.state,
            error: String(error),
          });
          result.skipped += 1;
          return;
        }
        if (!record) {
          log.warn('Refusing malformed media reference compensation journal', {
            operationId: parsed.operationId,
            state: parsed.state,
          });
          result.skipped += 1;
          return;
        }

        if (parsed.state === 'committed' && record.rollbackRequired !== true) {
          await removeMarker(markerPath, journalDir);
          result.removedCommitted += 1;
          return;
        }

        try {
          for (const refId of record.refIds) {
            if (!params.isOwnerCurrent()) {
              throw new Error('data owner changed during media reference compensation');
            }
            await ledger.removeRefById(refId, params.db);
            if (!params.isOwnerCurrent()) {
              throw new Error('data owner changed during media reference compensation');
            }
          }
          await removeMarker(markerPath, journalDir);
          result.recoveredPending += 1;
        } catch (error) {
          // Exact-id deletes are idempotent. Preserve the pending marker so a
          // later ready DbClient for this owner can repeat the entire batch.
          log.warn('Media reference compensation remains pending', {
            operationId: parsed.operationId,
            error: String(error),
          });
          result.skipped += 1;
        }
      },
    );
  }
  if (candidates.length > MAX_SCAN_ENTRIES) {
    log.warn('Media reference compensation scan was capped', {
      ownerStorageKey,
      entries: candidates.length,
      cap: MAX_SCAN_ENTRIES,
    });
  }
  return result;
}
