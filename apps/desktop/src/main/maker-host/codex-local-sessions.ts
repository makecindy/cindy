/**
 * Codex local session bridge.
 *
 * Desktop owns the filesystem / SQLite details for local Codex homes. The
 * renderer only sees normal xdt-maker sessions, while maker-core only gets a
 * "prepare this thread before resume" hook.
 */

import { app } from 'electron';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  allUserDataDirNames,
  brandUserDataDirName,
} from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

import {
  CodexResumePreparationBlockedError,
  finalizeCodexCitationText,
} from '@cindy/maker-core';

import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import { createLogger } from '../logger.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { recordPrRefsForImportedMessages } from '../git-context/prRefsStore.js';
import {
  cacheImportedBase64Image,
  importedUserContent,
  parseImageDataUrl,
  stripCompleteIdeOpenedFileBlocks,
  type ImportedImageRef,
} from './imported-user-content.js';

const log = createLogger('codex-local-sessions');

const LOCAL_SESSION_ID_PREFIX = 'codex-';
const MAX_THREADS_PER_HOME = 1000;
const SQLITE_BUSY_TIMEOUT_MS = 3000;
// Codex can create a rollout before writing session_meta and keep that file at
// zero bytes for several minutes. Recovery must not fork a still-live writer.
const EMPTY_ROLLOUT_RECOVERY_GRACE_MS = 15 * 60_000;
const MAX_RECOVERY_PATH_ATTEMPTS = 8;
const codexMessageImportFileCache = new Map<string, ExternalImportFileCacheEntry>();

function isNonEmptyRolloutFile(filePath: string, threadId: string): boolean {
  const state = readRegularRolloutPathState(filePath);
  if (state === 'unsafe') {
    throw resumePreparationBlocked(threadId, 'the rollout path is not a stable regular file');
  }
  return state === 'non-empty-file';
}

interface EmptyRolloutSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number | null;
}

interface NonEmptyRolloutSnapshot extends EmptyRolloutSnapshot {
  size: number;
}

/** Capture an unchanged zero-byte file so recovery can fail closed around live writers. */
function readEmptyRolloutSnapshot(filePath: string): EmptyRolloutSnapshot | null {
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.size !== 0) return null;
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || stat.size !== 0
      || before.dev !== stat.dev
      || before.ino !== stat.ino
    ) return null;
    return {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: usableBirthtimeMs(stat),
    };
  } catch {
    return null;
  }
}

function isStableEmptyRollout(snapshot: EmptyRolloutSnapshot): boolean {
  const latestIdentityTime = Math.max(
    snapshot.mtimeMs,
    snapshot.ctimeMs,
    snapshot.birthtimeMs ?? 0,
  );
  return Date.now() - latestIdentityTime >= EMPTY_ROLLOUT_RECOVERY_GRACE_MS;
}

function usableBirthtimeMs(stat: fs.Stats): number | null {
  return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
}

function emptyRolloutStillMatches(
  filePath: string,
  expected: EmptyRolloutSnapshot,
): boolean {
  const current = readEmptyRolloutSnapshot(filePath);
  return !!current
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
    && current.birthtimeMs === expected.birthtimeMs;
}

/** Capture an external empty without following a symlink or accepting a replace race. */
function readRegularEmptyRolloutSnapshot(filePath: string): EmptyRolloutSnapshot | null {
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.size !== 0) return null;
    const after = fs.lstatSync(filePath);
    if (
      !after.isFile()
      || after.size !== 0
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) return null;
    return {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      birthtimeMs: usableBirthtimeMs(after),
    };
  } catch {
    return null;
  }
}

function regularEmptyRolloutStillMatches(
  filePath: string,
  expected: EmptyRolloutSnapshot,
): boolean {
  const current = readRegularEmptyRolloutSnapshot(filePath);
  return !!current
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
    && current.birthtimeMs === expected.birthtimeMs;
}

function readNonEmptyRolloutSnapshot(filePath: string): NonEmptyRolloutSnapshot | null {
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.size <= 0) return null;
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || stat.size <= 0
      || before.dev !== stat.dev
      || before.ino !== stat.ino
    ) return null;
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: usableBirthtimeMs(stat),
    };
  } catch {
    return null;
  }
}

function nonEmptyRolloutStillMatches(
  filePath: string,
  expected: NonEmptyRolloutSnapshot,
): boolean {
  const current = readNonEmptyRolloutSnapshot(filePath);
  return !!current
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
    && current.birthtimeMs === expected.birthtimeMs;
}

/** Bounded-memory equality check used only for Cindy-owned immutable candidates. */
function filesHaveSameContents(leftPath: string, rightPath: string): boolean {
  let leftFd: number | null = null;
  let rightFd: number | null = null;
  try {
    const leftStat = fs.statSync(leftPath);
    const rightStat = fs.statSync(rightPath);
    if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
    leftFd = fs.openSync(leftPath, 'r');
    rightFd = fs.openSync(rightPath, 'r');
    const left = Buffer.allocUnsafe(64 * 1024);
    const right = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const leftRead = fs.readSync(leftFd, left, 0, left.length, null);
      const rightRead = fs.readSync(rightFd, right, 0, right.length, null);
      if (leftRead !== rightRead) return false;
      if (leftRead === 0) return true;
      if (!left.subarray(0, leftRead).equals(right.subarray(0, rightRead))) return false;
    }
  } catch {
    return false;
  } finally {
    if (leftFd !== null) {
      try { fs.closeSync(leftFd); } catch { /* best effort */ }
    }
    if (rightFd !== null) {
      try { fs.closeSync(rightFd); } catch { /* best effort */ }
    }
  }
}

/**
 * Read an exact Cindy-owned rollout through a no-follow file descriptor and
 * bind the bytes to one regular-file identity before it is persisted in state.
 */
function readPrivateExactRolloutSnapshot(
  targetHome: string,
  filePath: string,
  contents: string,
): NonEmptyRolloutSnapshot | null {
  const expected = Buffer.from(contents, 'utf-8');
  if (expected.length === 0 || !isPathInside(targetHome, filePath)) return null;

  let fd: number | null = null;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.size !== expected.length) return null;

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile()
      || opened.size !== expected.length
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) return null;

    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < expected.length) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, expected.length - offset), null);
      if (read <= 0 || !chunk.subarray(0, read).equals(expected.subarray(offset, offset + read))) {
        return null;
      }
      offset += read;
    }
    if (fs.readSync(fd, chunk, 0, 1, null) !== 0) return null;

    const after = fs.lstatSync(filePath);
    if (
      !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || !isPathInside(targetHome, filePath)
    ) return null;
    return {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      birthtimeMs: usableBirthtimeMs(after),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

type SqlScalar = string | number | bigint | Buffer | null;
type SqlRow = Record<string, SqlScalar | undefined>;

interface CodexThreadSummary {
  threadId: string;
  sourceHome: string;
  sourceDbPath: string | null;
  rolloutPath: string;
  title: string;
  cwd: string;
  workspaceKind: 'project' | 'dialogue';
  model: string;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  permissionMode: 'ask' | 'auto' | 'bypassPermissions';
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

interface CodexSessionIndexEntry {
  title: string;
  updatedAt: number | null;
}

interface ExternalImportFileCacheEntry {
  scope: string;
  path: string;
  mtimeMs: number;
  size: number;
}

type ExternalImportFileStat = Pick<ExternalImportFileCacheEntry, 'mtimeMs' | 'size'>;

export interface CodexExternalImportResult {
  homes: number;
  scanned: number;
  inserted: number;
  updated: number;
}

export interface CodexExternalSessionCandidate {
  source: 'codex';
  id: string;
  title: string;
  cwd: string;
  workspaceKind: 'project' | 'dialogue';
  updatedAt: number;
  archived: boolean;
  sourceHome: string;
}

export interface CodexExternalScanResult {
  homes: string[];
  candidates: CodexExternalSessionCandidate[];
  rejectedCount: number;
}

/** 设置导入页使用的只读扫描，不写入 xdt-maker DB。 */
export async function scanExternalCodexSessions(): Promise<CodexExternalScanResult> {
  const homes = await discoverExternalCodexHomes();
  const candidatesById = new Map<string, CodexExternalSessionCandidate>();
  let rejectedCount = 0;
  for (const home of homes) {
    const dbPath = findLatestStateDb(home);
    const projectlessThreadIds = readProjectlessThreadIds(home);
    const dbResult = dbPath ? readThreads(home, dbPath, projectlessThreadIds) : null;
    const knownDbArchivedByThreadId = dbResult
      ? new Map(dbResult.threads.map((thread) => [thread.threadId, thread.archived]))
      : undefined;
    const readResults = [
      ...(dbResult ? [dbResult] : []),
      await readThreadsFromRollouts(home, projectlessThreadIds, knownDbArchivedByThreadId),
    ];
    for (const readResult of readResults) {
      rejectedCount += readResult.rejectedThreadIds.length;
      for (const thread of readResult.threads) {
        const candidate: CodexExternalSessionCandidate = {
          source: 'codex',
          id: thread.threadId,
          title: thread.title,
          cwd: thread.cwd,
          workspaceKind: thread.workspaceKind,
          updatedAt: thread.updatedAt,
          archived: thread.archived,
          sourceHome: thread.sourceHome,
        };
        const existing = candidatesById.get(candidate.id);
        if (!existing) {
          candidatesById.set(candidate.id, candidate);
        } else {
          // 选 updatedAt 更新的那份做"主体"，但 archived 标志 sticky：
          // 同一 thread 同时出现在 sessions/ 和 archived_sessions/ 里，
          // 只要任一份是 archived 就视为 archived（避免按 mtime 判断时
          // 较新的 sessions/ 拷贝把 archived 状态盖掉）。
          const winner = existing.updatedAt < candidate.updatedAt ? candidate : existing;
          const archived = existing.archived || candidate.archived;
          if (winner !== existing || archived !== existing.archived) {
            candidatesById.set(candidate.id, { ...winner, archived });
          }
        }
      }
    }
  }
  return { homes, candidates: [...candidatesById.values()], rejectedCount };
}

/** Import the selected external Codex sessions into xdt-maker's session table. */
export async function importExternalCodexSessions(threadIds: string[]): Promise<CodexExternalImportResult> {
  const out: CodexExternalImportResult = { homes: 0, scanned: 0, inserted: 0, updated: 0 };
  const uniqueIds = [...new Set(threadIds)].filter(isLikelyThreadId);
  out.homes = discoverExternalCodexHomesSync().length;
  out.scanned = uniqueIds.length;
  for (const threadId of uniqueIds) {
    const thread = findExternalThreadById(threadId);
    if (!thread) continue;
    const action = await upsertLocalSession(thread);
    if (action === 'inserted') out.inserted += 1;
    else if (action === 'updated') out.updated += 1;
  }
  return out;
}

/** Ensure a Codex thread from another local CODEX_HOME is visible to xdt-maker's app-server. */
export async function prepareExternalCodexSessionForResume(threadId: string): Promise<string | undefined> {
  if (!isLikelyThreadId(threadId)) return;
  const targetHome = getDesktopCodexHome();
  const targetDbPath = findLatestStateDb(targetHome);
  if (!targetDbPath) {
    log.debug('prepare resume skipped: target Codex state DB missing', { threadId });
    return;
  }

  let targetRollout = readThreadRolloutPath(targetDbPath, threadId);
  if (targetRollout) {
    const recordedTargetRollout = targetRollout;
    const targetIsPrivate = isPathInside(targetHome, targetRollout);

    // A state-pointed private rollout is an irreversible handoff boundary. It may
    // already have native Codex records or a live writer, so later preflights must
    // never replace it from timestamps or the lossy Cindy chat projection.
    if (
      targetIsPrivate
      && readPrivateRolloutPathState(targetHome, targetRollout) === 'non-empty-file'
    ) {
      return targetRollout;
    }

    // Until state points at a private non-empty file, no recovery boundary has
    // committed. Reconcile any native canonical/preserved inode first so a
    // crash after preservation cannot hide that writer on the next retry.
    const nativeWinner = restoreInterruptedNativeCanonicalWithoutState(
      targetHome,
      threadId,
      { requireAllNativePrecursorsConverged: true },
    );
    if (nativeWinner) {
      const snapshot = readPrivateNonEmptyRolloutSnapshot(targetHome, nativeWinner);
      if (!snapshot) {
        throw resumePreparationBlocked(
          threadId,
          'the native private rollout changed before state reconciliation',
        );
      }
      const remainingEmptyGuard = observePendingInterruptedEmptyPreservations(
        targetHome,
        threadId,
      );
      const assertNativeCanonicalNamespaceUnchanged = () => {
        assertNoUnexpectedCanonicalRollouts(
          threadId,
          targetHome,
          [nativeWinner],
        );
      };
      const assertNativeHandoffUnchanged = combineHandoffGuards(
        remainingEmptyGuard,
        assertNativeCanonicalNamespaceUnchanged,
      );
      if (handoffThreadToNativeRollout(
        targetDbPath,
        threadId,
        targetHome,
        targetRollout,
        { path: nativeWinner, created: false, snapshot },
        assertNativeHandoffUnchanged,
      )) {
        return acceptStateBackedWinnerAfterRecovery(
          targetDbPath,
          threadId,
          targetHome,
          nativeWinner,
          { beforeReturn: assertNativeCanonicalNamespaceUnchanged },
        );
      }
      const concurrentWinner = readPrivateNonEmptyRollout(
        targetDbPath,
        threadId,
        targetHome,
      );
      if (concurrentWinner) {
        if (!samePath(concurrentWinner, nativeWinner)) {
          throw resumePreparationBlocked(
            threadId,
            'concurrent state selected a different private winner during native reconciliation',
          );
        }
        return acceptStateBackedWinnerAfterRecovery(
          targetDbPath,
          threadId,
          targetHome,
          concurrentWinner,
          { beforeReturn: assertNativeCanonicalNamespaceUnchanged },
        );
      }
      throw resumePreparationBlocked(
        threadId,
        'state changed before native rollout reconciliation',
      );
    }

    const localCanonicalSet = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
    // A full canonical found here appeared after the initial native preflight.
    // Keep state unchanged so the next attempt can reconcile it through the
    // native-winner CAS instead of letting an external/synthetic handoff hide it.
    if (localCanonicalSet.nonEmpty.length > 0) {
      throw resumePreparationBlocked(
        threadId,
        'a private canonical rollout materialized during recovery planning',
      );
    }
    const canonicalEmptiesToPreserve = targetIsPrivate
      ? localCanonicalSet.empties.filter(
        (candidate) => !samePath(candidate.path, recordedTargetRollout),
      )
      : localCanonicalSet.empties;
    const retainedCanonicalEmpties = targetIsPrivate
      ? localCanonicalSet.empties.filter(
        (candidate) => samePath(candidate.path, recordedTargetRollout),
      )
      : [];
    const assertCanonicalEmptiesUnchanged = preserveAdditionalCanonicalEmptiesBeforeHandoff(
      threadId,
      targetHome,
      canonicalEmptiesToPreserve,
    );
    const assertCanonicalNamespaceUnchanged = createCanonicalNamespaceGuard(
      threadId,
      targetHome,
      retainedCanonicalEmpties,
    );
    assertCanonicalNamespaceUnchanged();
    const assertInterruptedEmptiesUnchanged = observePendingInterruptedEmptyPreservations(
      targetHome,
      threadId,
    );
    const assertExistingStatePrecursorsUnchanged = combineHandoffGuards(
      assertCanonicalEmptiesUnchanged,
      assertInterruptedEmptiesUnchanged,
      assertCanonicalNamespaceUnchanged,
    );

    // #1554: existence is not readability. Codex can create a zero-byte rollout
    // several minutes before writing session_meta, so recent empties must fail
    // closed and stable empties recover without modifying the original file.
    if (readEmptyRolloutSnapshot(targetRollout)) {
      try {
        return await recoverStableEmptyRollout(
          threadId,
          targetDbPath,
          targetHome,
          targetRollout,
          assertExistingStatePrecursorsUnchanged,
          assertCanonicalNamespaceUnchanged,
        );
      } catch (error) {
        failClosedResumePreparation(threadId, 'empty rollout recovery', error);
      }
    }

    // A non-empty external pointer is never a valid hot path: Codex resumes by
    // appending directly to state.rollout_path. Publish a stable private copy,
    // then move the existing row with CAS while preserving all current metadata.
    if (!targetIsPrivate && isNonEmptyRolloutFile(targetRollout, threadId)) {
      try {
        const row = readRawThreadRow(targetDbPath, threadId);
        const preferred = privateRolloutPathForStateRow(targetHome, targetRollout, row);
        const adopted = await copyExternalRolloutAtomically(
          targetRollout,
          preferred,
          threadId,
          {
            allowSibling: true,
            // Keep every new filename Cindy-owned until the guarded state
            // transaction verifies the complete canonical namespace.
            skipPreferred: true,
          },
        );
        if (!adopted) {
          throw resumePreparationBlocked(threadId, 'external rollout changed during private adoption');
        }
        if (handoffThreadToCopiedRollout(
          targetDbPath,
          threadId,
          targetHome,
          targetRollout,
          adopted,
          assertExistingStatePrecursorsUnchanged,
        )) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            adopted.path,
            { beforeReturn: assertCanonicalNamespaceUnchanged },
          );
        }
        const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
        if (winner) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            winner,
            { beforeReturn: assertCanonicalNamespaceUnchanged },
          );
        }
        throw resumePreparationBlocked(threadId, 'external rollout pointer changed during private adoption');
      } catch (error) {
        failClosedResumePreparation(threadId, 'external rollout adoption', error);
      }
    }

    // The recorded file is missing. If the pointer is external, first publish a
    // private synthetic fallback and only then move state; never recreate data in
    // another runtime's CODEX_HOME. A private orphan keeps the established path.
    if (!targetIsPrivate) {
      try {
        return await recoverMissingExternalRollout(
          threadId,
          targetDbPath,
          targetHome,
          targetRollout,
          assertExistingStatePrecursorsUnchanged,
          assertCanonicalNamespaceUnchanged,
        );
      } catch (error) {
        failClosedResumePreparation(threadId, 'missing external rollout recovery', error);
      }
    }

    const expectedMissingPrivateRollout = targetRollout;
    const external = findExternalThreadById(threadId);
    if (external && isNonEmptyRolloutFile(external.rolloutPath, threadId)) {
      try {
        const adopted = await copyExternalRolloutAtomically(
          external.rolloutPath,
          expectedMissingPrivateRollout,
          threadId,
          {
            allowSibling: true,
            // Linking directly at the state-pointed path is itself a commit.
            // Always keep the copy hidden until the namespace-aware CAS.
            skipPreferred: true,
          },
        );
        if (!adopted) {
          throw resumePreparationBlocked(threadId, 'external fallback changed during private adoption');
        }
        if (samePath(adopted.path, expectedMissingPrivateRollout)) {
          if (privateRolloutPublicationOwnsPath(targetHome, adopted)) {
            return acceptStateBackedWinnerAfterRecovery(
              targetDbPath,
              threadId,
              targetHome,
              adopted.path,
              { allowedCanonicalPaths: [adopted.path] },
            );
          }
          throw resumePreparationBlocked(threadId, 'private adoption target changed during publication');
        }
        const assertMissingPrivateHandoffUnchanged = () => {
          assertExistingStatePrecursorsUnchanged?.();
          if (
            readPrivateRolloutPathState(targetHome, expectedMissingPrivateRollout) !== 'missing'
          ) {
            throw resumePreparationBlocked(
              threadId,
              'the missing private rollout materialized before state handoff',
            );
          }
        };
        if (handoffThreadToCopiedRollout(
          targetDbPath,
          threadId,
          targetHome,
          expectedMissingPrivateRollout,
          adopted,
          assertMissingPrivateHandoffUnchanged,
        )) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            adopted.path,
            { beforeReturn: assertCanonicalNamespaceUnchanged },
          );
        }
        const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
        if (winner) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            winner,
            { beforeReturn: assertCanonicalNamespaceUnchanged },
          );
        }
        throw resumePreparationBlocked(threadId, 'private orphan pointer changed during adoption');
      } catch (error) {
        failClosedResumePreparation(threadId, 'external orphan adoption', error);
      }
    }

    try {
      return await recoverMissingPrivateRollout(
        threadId,
        targetDbPath,
        targetHome,
        targetRollout,
        assertExistingStatePrecursorsUnchanged,
        assertCanonicalNamespaceUnchanged,
      );
    } catch (error) {
      failClosedResumePreparation(threadId, 'missing private rollout recovery', error);
    }
  }

  // The state row may be gone while a valid private rollout remains. Codex can
  // scan its own standard directories and hydrate current-schema state, but a
  // Cindy recovery sibling is not discoverable when an empty canonical rollout
  // for the same thread still shadows it. In that shape, continue into the
  // state-backed import paths below or fail closed.
  const interruptedNativeCanonical = restoreInterruptedNativeCanonicalWithoutState(
    targetHome,
    threadId,
  );
  if (interruptedNativeCanonical) return interruptedNativeCanonical;
  const assertInterruptedPreservedEmptiesUnchanged =
    observePendingInterruptedEmptyPreservations(targetHome, threadId);
  const currentHomeCanonicalSet = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  const recentCurrentHomeCanonicalEmpty = currentHomeCanonicalSet.empties.find(
    (candidate) => !isStableEmptyRollout(candidate.snapshot),
  );
  if (recentCurrentHomeCanonicalEmpty) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }
  if (currentHomeCanonicalSet.nonEmpty.length > 1) {
    throw resumePreparationBlocked(threadId, 'multiple private canonical rollouts conflict');
  }
  if (currentHomeCanonicalSet.nonEmpty.length === 1) {
    const existingWinner = currentHomeCanonicalSet.nonEmpty[0];
    preserveStableCanonicalEmptiesBesideWinner(
      threadId,
      targetHome,
      currentHomeCanonicalSet.empties,
    );
    const converged = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
    if (
      converged.empties.length > 0
      || converged.nonEmpty.length !== 1
      || !samePath(converged.nonEmpty[0], existingWinner)
    ) {
      throw resumePreparationBlocked(threadId, 'the private canonical winner changed during handoff');
    }
    return existingWinner;
  }
  const [currentHomeCanonicalEmptyObservation, ...additionalCanonicalEmpties] =
    currentHomeCanonicalSet.empties;
  const assertAdditionalCanonicalEmptiesUnchanged = preserveAdditionalCanonicalEmptiesBeforeHandoff(
    threadId,
    targetHome,
    additionalCanonicalEmpties,
  );
  const assertLocalCanonicalPrecursorsUnchanged = combineHandoffGuards(
    assertInterruptedPreservedEmptiesUnchanged,
    assertAdditionalCanonicalEmptiesUnchanged,
  );
  const currentHomeCanonicalEmpty = currentHomeCanonicalEmptyObservation?.path ?? null;
  const currentHomeCanonicalEmptySnapshot = currentHomeCanonicalEmptyObservation?.snapshot ?? null;
  const currentHomeThread = findExternalThreadByIdFromRollouts(targetHome, threadId);
  if (
    currentHomeThread?.rolloutPath
    && isNonEmptyRolloutFile(currentHomeThread.rolloutPath, threadId)
    && !currentHomeCanonicalEmpty
    && isCanonicalCodexRolloutPath(currentHomeThread.rolloutPath, threadId)
  ) {
    const converged = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
    if (
      converged.empties.length === 0
      && converged.nonEmpty.length === 1
      && samePath(converged.nonEmpty[0], currentHomeThread.rolloutPath)
    ) return currentHomeThread.rolloutPath;
    throw resumePreparationBlocked(
      threadId,
      'the private canonical rollout namespace changed during native discovery',
    );
  }

  // With no target row, a discovered external thread can still be adopted. A
  // sibling is usable only when source state can be copied to point at it;
  // rollout-only sources must publish at the standard preferred path.
  const found = findExternalThreadById(threadId);
  let stateBackedLocalHandoffGuard = assertLocalCanonicalPrecursorsUnchanged;
  let stateBackedCanonicalNamespaceGuard: (() => void) | undefined;
  if (
    found?.sourceDbPath
    && currentHomeCanonicalEmpty
    && currentHomeCanonicalEmptySnapshot
  ) {
    // A state-backed sibling is not discoverable until its row commits. Move
    // the primary empty inode aside first, then keep it in the same safety set
    // as the publication for both transaction validations. A writer waking
    // after commit remains preserved; one waking before commit wins on the
    // next retry through interrupted-preservation restoration.
    const preservation = preserveStableEmptyCanonical(
      threadId,
      targetHome,
      currentHomeCanonicalEmpty,
      currentHomeCanonicalEmptySnapshot,
    );
    if (preservation.kind === 'native-winner') {
      return acceptSoleCanonicalNativeWinner(
        threadId,
        targetHome,
        currentHomeCanonicalEmpty,
        stateBackedLocalHandoffGuard,
      );
    }
    const preservedState = readPrivateRolloutPathState(targetHome, preservation.path);
    if (preservedState === 'non-empty-file') {
      return restoreSoleCanonicalNativeWinner(
        threadId,
        targetHome,
        preservation.path,
        currentHomeCanonicalEmpty,
        stateBackedLocalHandoffGuard,
      );
    }
    const preservedSnapshot = readRegularEmptyRolloutSnapshot(preservation.path);
    if (!preservedSnapshot) {
      if (readPrivateRolloutPathState(targetHome, preservation.path) === 'non-empty-file') {
        return restoreSoleCanonicalNativeWinner(
          threadId,
          targetHome,
          preservation.path,
          currentHomeCanonicalEmpty,
          stateBackedLocalHandoffGuard,
        );
      }
      throw resumePreparationBlocked(
        threadId,
        'the primary private rollout changed before state-backed adoption',
      );
    }
    const assertPrimaryCanonicalUnchanged = () => {
      if (!regularEmptyRolloutStillMatches(preservation.path, preservedSnapshot)) {
        throw resumePreparationBlocked(
          threadId,
          'the primary private rollout changed before state handoff',
        );
      }
    };
    stateBackedLocalHandoffGuard = combineHandoffGuards(
      stateBackedLocalHandoffGuard,
      assertPrimaryCanonicalUnchanged,
    );
  }
  if (found?.sourceDbPath) {
    stateBackedCanonicalNamespaceGuard = createCanonicalNamespaceGuard(
      threadId,
      targetHome,
      [],
    );
    stateBackedCanonicalNamespaceGuard();
    stateBackedLocalHandoffGuard = combineHandoffGuards(
      stateBackedLocalHandoffGuard,
      stateBackedCanonicalNamespaceGuard,
    );
  }
  if (found && isNonEmptyRolloutFile(found.rolloutPath, threadId)) {
    try {
      const preferred = targetRolloutPathForExternalThread(found, targetHome);
      const stateHandoffGuard = found.sourceDbPath
        ? stateBackedLocalHandoffGuard
        : assertLocalCanonicalPrecursorsUnchanged;
      if (
        !found.sourceDbPath
        && currentHomeCanonicalEmpty
        && currentHomeCanonicalEmptySnapshot
      ) {
        return await adoptExternalRolloutOverStableCanonicalWithoutState(
          threadId,
          targetHome,
          found.rolloutPath,
          currentHomeCanonicalEmpty,
          currentHomeCanonicalEmptySnapshot,
          assertLocalCanonicalPrecursorsUnchanged,
        );
      }
      if (
        !found.sourceDbPath
        && isCanonicalCodexRolloutPath(preferred, threadId)
      ) {
        return await adoptExternalRolloutAfterPendingLocalHandoff(
          threadId,
          targetHome,
          found.rolloutPath,
          preferred,
          assertLocalCanonicalPrecursorsUnchanged ?? (() => undefined),
        );
      }
      const adopted = await copyExternalRolloutAtomically(
        found.rolloutPath,
        preferred,
        threadId,
        {
          allowSibling: !!found.sourceDbPath,
          skipPreferred: !!found.sourceDbPath && !!stateHandoffGuard,
        },
      );
      if (!adopted) {
        throw resumePreparationBlocked(threadId, 'external rollout changed during private adoption');
      }

      const copiedState = copyThreadStateToTarget(found, targetDbPath, {
        rolloutPathOverride: adopted.path,
        validateBeforeCopy: () => {
          stateHandoffGuard?.();
          return privateRolloutPublicationStillMatches(targetHome, adopted);
        },
        validateAfterCopy: () => {
          stateHandoffGuard?.();
          return privateRolloutPublicationStillMatches(targetHome, adopted);
        },
      });
      targetRollout = readThreadRolloutPath(targetDbPath, threadId);
      if (targetRollout) {
        if (
          isPathInside(targetHome, targetRollout)
          && readPrivateRolloutPathState(targetHome, targetRollout) === 'non-empty-file'
        ) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            targetRollout,
            { beforeReturn: stateBackedCanonicalNamespaceGuard },
          );
        }
        if (!isPathInside(targetHome, targetRollout) && handoffThreadToCopiedRollout(
          targetDbPath,
          threadId,
          targetHome,
          targetRollout,
          adopted,
          stateHandoffGuard,
        )) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            adopted.path,
            { beforeReturn: stateBackedCanonicalNamespaceGuard },
          );
        }
        throw resumePreparationBlocked(threadId, 'concurrent state prevented safe private adoption');
      }
      if (
        samePath(adopted.path, preferred)
        && isCanonicalCodexRolloutPath(adopted.path, threadId)
        && privateRolloutPublicationOwnsPath(targetHome, adopted)
      ) {
        assertSoleCanonicalPath(threadId, targetHome, adopted.path, true);
        return adopted.path;
      }
      log.warn('external rollout copied to sibling but source state was not available', {
        threadId,
        copiedState,
        adoptedRolloutPath: adopted.path,
      });
      throw resumePreparationBlocked(threadId, 'private rollout sibling is not discoverable without state');
    } catch (error) {
      failClosedResumePreparation(threadId, 'external rollout import', error);
    }
  }
  const externalEmpty = found ? readEmptyRolloutSnapshot(found.rolloutPath) : null;
  if (found && externalEmpty) {
    try {
      return await recoverStableExternalEmptyWithoutTargetState(
        threadId,
        targetDbPath,
        targetHome,
        found,
        externalEmpty,
        stateBackedLocalHandoffGuard,
        stateBackedCanonicalNamespaceGuard,
      );
    } catch (error) {
      failClosedResumePreparation(threadId, 'external empty rollout import', error);
    }
  }
  if (found?.sourceDbPath && rolloutPathIsMissing(found.rolloutPath)) {
    try {
      const sourceRow = readRawThreadRow(found.sourceDbPath, threadId);
      if (sourceRow) {
        const preferred = targetRolloutPathForExternalThread(found, targetHome);
        const published = await publishFreshSyntheticBeforeHandoff(
          preferred,
          threadId,
          sourceRow,
          { skipPreferred: true },
        );
        if (!published) {
          throw resumePreparationBlocked(threadId, 'a private recovery file could not be published safely');
        }
        const assertMissingSourceAndLocalPrecursorsUnchanged = () => {
          stateBackedLocalHandoffGuard?.();
          if (!rolloutPathIsMissing(found.rolloutPath)) {
            throw resumePreparationBlocked(
              threadId,
              'the missing external rollout materialized before state handoff',
            );
          }
        };
        copyThreadStateToTarget(found, targetDbPath, {
          rolloutPathOverride: published.path,
          validateBeforeCopy: () => {
            assertMissingSourceAndLocalPrecursorsUnchanged();
            return syntheticPublicationStillMatches(targetHome, published);
          },
          validateAfterCopy: () => {
            assertMissingSourceAndLocalPrecursorsUnchanged();
            return syntheticPublicationOwnsPath(targetHome, published);
          },
        });
        const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
        if (isAcceptableSyntheticWinner(targetHome, winner, published)) {
          return acceptStateBackedWinnerAfterRecovery(
            targetDbPath,
            threadId,
            targetHome,
            winner!,
            { beforeReturn: stateBackedCanonicalNamespaceGuard },
          );
        }
        throw resumePreparationBlocked(threadId, 'external state could not be copied after recovery');
      }
    } catch (error) {
      failClosedResumePreparation(threadId, 'missing external thread import', error);
    }
  }

  // An unindexed external empty is outside the current Cindy HOME and therefore
  // cannot shadow the app-server's scanner. A recent one may still have a live
  // writer, but a stable one must not permanently poison recovery from Cindy's
  // own persisted history.
  const unindexedExternalEmpties = observeUnindexedExternalEmptyRolloutsById(threadId);
  const recentUnindexedExternalEmpty = unindexedExternalEmpties.find(
    (candidate) => !isStableEmptyRollout(candidate.snapshot),
  );
  if (recentUnindexedExternalEmpty) {
    throw resumePreparationBlocked(threadId, 'external rollout may still be materializing');
  }
  const assertUnindexedExternalEmptiesUnchanged = unindexedExternalEmpties.length > 0
    ? () => assertExternalEmptyObservationsUnchanged(threadId, unindexedExternalEmpties)
    : undefined;
  const assertPrivateRecoverySourcesUnchanged = combineHandoffGuards(
    assertLocalCanonicalPrecursorsUnchanged,
    assertUnindexedExternalEmptiesUnchanged,
  );
  if (unindexedExternalEmpties.length > 0) {
    log.info('ignoring stable unindexed external empty during private recovery', {
      threadId,
      externalRolloutPaths: unindexedExternalEmpties.map((candidate) => candidate.path),
    });
  }

  // Prefer a full-fidelity external source above. Only when no state-backed
  // source can win do we replace a stable local empty from Cindy's projection.
  if (currentHomeCanonicalEmpty && currentHomeCanonicalEmptySnapshot) {
    try {
      const recovered = await recoverStableCanonicalEmptyWithoutTargetState(
        threadId,
        targetHome,
        currentHomeCanonicalEmpty,
        currentHomeCanonicalEmptySnapshot,
        assertPrivateRecoverySourcesUnchanged,
      );
      if (recovered) return recovered;
    } catch (error) {
      failClosedResumePreparation(threadId, 'state-less empty rollout recovery', error);
    }
  }

  if (
    currentHomeThread?.rolloutPath
    && isNonEmptyRolloutFile(currentHomeThread.rolloutPath, threadId)
    && !isCanonicalCodexRolloutPath(currentHomeThread.rolloutPath, threadId)
  ) {
    throw resumePreparationBlocked(threadId, 'private rollout is not discoverable without state');
  }

  // An empty standard rollout is invisible to the parser but may still have a
  // live writer. Do not synthesize a second same-thread file beside it.
  const currentHomeEmpty = collectRolloutFiles(targetHome).find(
    (candidate) => threadIdFromRolloutPath(candidate) === threadId
      && !!readEmptyRolloutSnapshot(candidate),
  );
  if (currentHomeEmpty) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }

  // 孤儿兜底: state DB 有 threads 行、但 rollout 文件已缺失(典型成因: 旧版 codex logout
  // 把整个 sessions/ 目录删光), 且没有外部源可恢复 → 用存活的 threads 行元数据 +
  // xdt-maker localDb 的可读消息历史, 合成一份最小 rollout, 让 thread/resume 能继续。
  // 合成版只含 user/assistant 文本(丢 codex 内部 reasoning/tool 细节, 跨供应商时这些本就
  // 失效), 是 best-effort 恢复, 失败不抛(让 maker-core 走清晰报错路径)。
  if (!targetRollout) {
    // 更深一层的孤儿: Cindy localDb 仍保留 sdk_session_id 与可读聊天历史,但 Codex
    // state 行和 rollout 同时丢失。不要伪造版本敏感的 threads 行;先在当前 HOME 的
    // 标准目录重建 rollout,随后的 thread/resume 会让 app-server 按当前 schema hydrate。
    try {
      const synthesizedPath = await synthesizeRolloutForMissingThreadState(
        threadId,
        targetHome,
        assertPrivateRecoverySourcesUnchanged,
      );
      if (!synthesizedPath) {
        if (unindexedExternalEmpties.length > 0) {
          throw resumePreparationBlocked(
            threadId,
            'the stable external empty rollout has no readable private recovery history',
          );
        }
        log.debug('prepare resume: no localDb recovery source for missing thread state', { threadId });
      } else if (readEmptyRolloutSnapshot(synthesizedPath)) {
        throw resumePreparationBlocked(threadId, 'a same-thread rollout began materializing during recovery');
      } else {
        return synthesizedPath;
      }
    } catch (err) {
      if (err instanceof CodexResumePreparationBlockedError) throw err;
      log.warn('synthesize rollout for missing Codex thread state failed', {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const lateStatePath = readThreadRolloutPath(targetDbPath, threadId);
  if (!lateStatePath) return undefined;
  const preparedRollout = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
  if (!preparedRollout) {
    throw resumePreparationBlocked(
      threadId,
      'late Codex state appeared outside a readable private recovery boundary',
    );
  }
  return acceptStateBackedWinnerAfterRecovery(
    targetDbPath,
    threadId,
    targetHome,
    preparedRollout,
    {
      allowedCanonicalPaths: isCanonicalCodexRolloutPath(preparedRollout, threadId)
        ? [preparedRollout]
        : [],
    },
  );
}

/** 为外部 thread 派生当前 Codex HOME 内的稳定 rollout 路径。 */
function targetRolloutPathForExternalThread(thread: CodexThreadSummary, targetHome: string): string {
  const relative = path.relative(thread.sourceHome, thread.rolloutPath);
  const firstSegment = relative.split(path.sep)[0];
  const isSafeCodexRelativePath = relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && (firstSegment === 'sessions' || firstSegment === 'archived_sessions');
  if (isSafeCodexRelativePath) return path.join(targetHome, relative);

  const directory = thread.archived ? 'archived_sessions' : 'sessions';
  const filename = path.basename(thread.rolloutPath) || `rollout-migrated-${thread.threadId}.jsonl`;
  return path.join(targetHome, directory, filename);
}

/** Resolve a missing path through its nearest existing ancestor, including symlinks. */
function resolvePathForBoundary(candidate: string): string {
  let current = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    const resolved = safeRealpathSync(current);
    if (resolved) return path.join(resolved, ...missingSegments);
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(candidate);
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
}

/** 消除 macOS `/var` 别名与已存在的 symlink ancestor,再做目录边界判断。 */
function isPathInside(parentDir: string, candidate: string): boolean {
  const parent = resolvePathForBoundary(parentDir);
  const child = resolvePathForBoundary(candidate);
  const relative = path.relative(parent, child);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type PrivateRolloutPathState = 'missing' | 'empty-file' | 'non-empty-file' | 'unsafe';

/** Classify one rollout path without following its final symbolic link. */
function readRegularRolloutPathState(candidate: string): PrivateRolloutPathState {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(candidate);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (!before.isFile()) return 'unsafe';
  try {
    const after = fs.lstatSync(candidate);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      return 'unsafe';
    }
    return after.size > 0 ? 'non-empty-file' : 'empty-file';
  } catch {
    return 'unsafe';
  }
}

function rolloutPathIsMissing(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Revalidate a path that was classified as private while it was absent or
 * empty. lstat deliberately rejects symbolic links, and the second identity
 * check closes ordinary replace-between-checks races before a state pointer is
 * restored to the path.
 */
function readPrivateRolloutPathState(targetHome: string, candidate: string): PrivateRolloutPathState {
  try {
    const before = fs.lstatSync(candidate);
    if (!before.isFile() || !isPathInside(targetHome, candidate)) return 'unsafe';
    const after = fs.lstatSync(candidate);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) return 'unsafe';
    return after.size > 0 ? 'non-empty-file' : 'empty-file';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

function sameRegularFileIdentity(leftPath: string, rightPath: string): boolean {
  try {
    const left = fs.lstatSync(leftPath);
    const right = fs.lstatSync(rightPath);
    return left.isFile()
      && right.isFile()
      && left.dev === right.dev
      && left.ino === right.ino;
  } catch {
    return false;
  }
}

function regularFileIdentityMatchesSnapshot(
  filePath: string,
  expected: EmptyRolloutSnapshot,
): boolean {
  try {
    const current = fs.lstatSync(filePath);
    return current.isFile()
      && current.dev === expected.dev
      && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function resumePreparationBlocked(
  threadId: string,
  reason: string,
): CodexResumePreparationBlockedError {
  return new CodexResumePreparationBlockedError(
    `Codex thread ${threadId} is not safe to resume yet: ${reason}. Retry after the current write finishes.`,
  );
}

function failClosedResumePreparation(
  threadId: string,
  operation: string,
  error: unknown,
): never {
  if (error instanceof CodexResumePreparationBlockedError) throw error;
  log.warn('Codex resume preparation failed after detecting unsafe state', {
    threadId,
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
  throw resumePreparationBlocked(threadId, `${operation} failed`);
}

function privateRolloutPathForStateRow(
  targetHome: string,
  recordedPath: string,
  row: SqlRow | null,
): string {
  const directory = numberValue(row?.archived) > 0 ? 'archived_sessions' : 'sessions';
  const filename = path.basename(recordedPath) || 'rollout-cindy-recovered.jsonl';
  return path.join(targetHome, directory, filename);
}

function readPrivateNonEmptyRollout(
  targetDbPath: string,
  threadId: string,
  targetHome: string,
): string | null {
  const current = readThreadRolloutPath(targetDbPath, threadId);
  return current
    && readPrivateRolloutPathState(targetHome, current) === 'non-empty-file'
    ? current
    : null;
}

/** Revalidate a winner selected during recovery before the caller resumes it. */
function acceptStateBackedWinnerAfterRecovery(
  targetDbPath: string,
  threadId: string,
  targetHome: string,
  winner: string,
  opts: {
    beforeReturn?: () => void;
    allowedCanonicalPaths?: readonly string[];
  } = {},
): string {
  const validate = () => {
    opts.beforeReturn?.();
    if (opts.allowedCanonicalPaths) {
      assertNoUnexpectedCanonicalRollouts(
        threadId,
        targetHome,
        opts.allowedCanonicalPaths,
      );
    } else if (!opts.beforeReturn) {
      assertNoUnexpectedCanonicalRollouts(
        threadId,
        targetHome,
        isCanonicalCodexRolloutPath(winner, threadId) ? [winner] : [],
      );
    }
    const stateWinner = readThreadRolloutPath(targetDbPath, threadId);
    if (
      !stateWinner
      || !samePath(stateWinner, winner)
      || readPrivateRolloutPathState(targetHome, winner) !== 'non-empty-file'
    ) {
      throw resumePreparationBlocked(
        threadId,
        'the private state winner changed before recovery could return',
      );
    }
  };
  validate();
  validate();
  return winner;
}

/** 当前区域的全部历史品牌 Codex HOME;不包含当前区域正在使用的 HOME。 */
function legacyBrandedCodexHomes(targetHome: string): string[] {
  const userDataParent = path.dirname(path.dirname(targetHome));
  return allUserDataDirNames(CURRENT_CINDY_REGION)
    .slice(1)
    .map((dirName) => path.join(userDataParent, dirName, 'codex-home'));
}

/**
 * Snapshot an external rollout into Cindy storage and atomically publish it.
 * The source must remain byte/stat stable for the whole copy. Existing private
 * candidates are reused only when byte-identical; different or empty files are
 * preserved and, when state can point at one, bypassed with a deterministic sibling.
 */
interface PrivateRolloutPublication {
  path: string;
  created: boolean;
  snapshot: NonEmptyRolloutSnapshot;
}

function readPrivateNonEmptyRolloutSnapshot(
  targetHome: string,
  candidate: string,
): NonEmptyRolloutSnapshot | null {
  if (!isPathInside(targetHome, candidate)) return null;
  const snapshot = readNonEmptyRolloutSnapshot(candidate);
  return snapshot
    && nonEmptyRolloutStillMatches(candidate, snapshot)
    && isPathInside(targetHome, candidate)
    ? snapshot
    : null;
}

function privateRolloutPublicationOwnsPath(
  targetHome: string,
  publication: PrivateRolloutPublication,
  candidatePath = publication.path,
): boolean {
  const current = readPrivateNonEmptyRolloutSnapshot(targetHome, candidatePath);
  return !!current
    && current.dev === publication.snapshot.dev
    && current.ino === publication.snapshot.ino;
}

function privateRolloutPublicationStillMatches(
  targetHome: string,
  publication: PrivateRolloutPublication,
): boolean {
  const current = readPrivateNonEmptyRolloutSnapshot(targetHome, publication.path);
  return !!current
    && current.dev === publication.snapshot.dev
    && current.ino === publication.snapshot.ino
    && current.size === publication.snapshot.size
    // Removing the temporary hard-link after publication legitimately changes
    // ctime/link-count on the same immutable inode; mtime still binds content.
    && current.mtimeMs === publication.snapshot.mtimeMs;
}

async function copyExternalRolloutAtomically(
  sourcePath: string,
  preferredPath: string,
  threadId: string,
  opts: { allowSibling: boolean; skipPreferred?: boolean },
): Promise<PrivateRolloutPublication | null> {
  if (samePath(sourcePath, preferredPath)) return null;
  const targetHome = getDesktopCodexHome();
  if (!isPathInside(targetHome, preferredPath)) return null;
  const sourceSnapshot = readNonEmptyRolloutSnapshot(sourcePath);
  if (!sourceSnapshot) return null;

  await fsp.mkdir(path.dirname(preferredPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(preferredPath),
    `.${path.basename(preferredPath)}.${randomUUID()}.migration-tmp`,
  );
  try {
    await fsp.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    const tempSnapshot = readNonEmptyRolloutSnapshot(tempPath);
    if (
      !tempSnapshot
      || tempSnapshot.size !== sourceSnapshot.size
      || !nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)
    ) return null;

    const attempts = opts.allowSibling ? MAX_RECOVERY_PATH_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)) return null;
      let candidate = preferredPath;
      if (opts.skipPreferred) {
        candidate = recoveredSiblingRolloutPath(preferredPath, threadId, attempt, 'adopted');
      } else if (attempt > 0) {
        candidate = recoveredSiblingRolloutPath(preferredPath, threadId, attempt - 1, 'adopted');
      }
      if (fs.existsSync(candidate)) {
        const candidateSnapshot = readPrivateNonEmptyRolloutSnapshot(targetHome, candidate);
        if (
          candidateSnapshot
          && filesHaveSameContents(candidate, tempPath)
          && nonEmptyRolloutStillMatches(candidate, candidateSnapshot)
          && nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)
        ) return { path: candidate, created: false, snapshot: candidateSnapshot };
        if (!nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)) return null;
        continue;
      }

      // This is the snapshot boundary: the source was stable for the complete
      // copy and immediately before atomic publication. Bytes appended after
      // this check belong to the still-preserved external runtime, while Cindy
      // intentionally continues from its isolated point-in-time copy (#789).
      if (!nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)) return null;
      try {
        await fsp.link(tempPath, candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const candidateSnapshot = readPrivateNonEmptyRolloutSnapshot(targetHome, candidate);
        if (
          candidateSnapshot
          && filesHaveSameContents(candidate, tempPath)
          && nonEmptyRolloutStillMatches(candidate, candidateSnapshot)
          && nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)
        ) return { path: candidate, created: false, snapshot: candidateSnapshot };
        if (!nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)) return null;
        continue;
      }
      const candidateSnapshot = readPrivateNonEmptyRolloutSnapshot(targetHome, candidate);
      if (
        !candidateSnapshot
        || !sameRegularFileIdentity(tempPath, candidate)
        || !nonEmptyRolloutStillMatches(sourcePath, sourceSnapshot)
      ) return null;
      return { path: candidate, created: true, snapshot: candidateSnapshot };
    }
    return null;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** 会话分享(.xdtshare)导出侧的 Codex thread 状态快照(JSON 可序列化)。 */
export interface CodexThreadStateDump {
  /** state DB 三表中该 thread 的行(列名→值;Buffer 按 base64 包裹,bigint 转 string)。 */
  threads: Array<Record<string, unknown>>;
  threadDynamicTools: Array<Record<string, unknown>>;
  threadSpawnEdges: Array<Record<string, unknown>>;
  /** 磁盘上真实存在的 rollout 文件路径;null = 找不到(导出降级 db-only)。 */
  rolloutPath: string | null;
}

/**
 * 会话分享导出:dump 一个 codex thread 的 state 三表行 + rollout 文件位置。
 * 查找顺序与 resume 恢复链一致:desktop codex home 的 state DB 优先,
 * 缺行/缺文件再回退外部 CODEX_HOME(~/.codex、Codex.app)。全程只读。
 */
export async function dumpCodexThreadStateRows(threadId: string): Promise<CodexThreadStateDump> {
  const empty: CodexThreadStateDump = {
    threads: [],
    threadDynamicTools: [],
    threadSpawnEdges: [],
    rolloutPath: null,
  };
  if (!isLikelyThreadId(threadId)) return empty;

  const dbCandidates: string[] = [];
  const desktopDb = findLatestStateDb(getDesktopCodexHome());
  if (desktopDb) dbCandidates.push(desktopDb);
  const external = findExternalThreadById(threadId);
  if (external?.sourceDbPath) dbCandidates.push(external.sourceDbPath);

  let dump = empty;
  for (const dbPath of dbCandidates) {
    const rows = readThreadStateRows(dbPath, threadId);
    if (rows.threads.length > 0) {
      dump = { ...rows, rolloutPath: null };
      break;
    }
  }

  const recorded = resolveRolloutPath(threadId);
  if (recorded && fs.existsSync(recorded)) {
    dump = { ...dump, rolloutPath: recorded };
  } else if (external?.rolloutPath && fs.existsSync(external.rolloutPath)) {
    dump = { ...dump, rolloutPath: external.rolloutPath };
  }
  return dump;
}

/** 只读取一个 state DB 里该 thread 的三表行并转成 JSON 可序列化形态。 */
function readThreadStateRows(
  dbPath: string,
  threadId: string,
): Pick<CodexThreadStateDump, 'threads' | 'threadDynamicTools' | 'threadSpawnEdges'> {
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDb(dbPath);
    const readTable = (table: string, whereColumn: string): Array<Record<string, unknown>> => {
      if (!db || !tableExists(db, table)) return [];
      const rows = db
        .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereColumn)} = ?`)
        .all(threadId) as SqlRow[];
      return rows.map(serializeSqlRow);
    };
    return {
      threads: readTable('threads', 'id'),
      threadDynamicTools: readTable('thread_dynamic_tools', 'thread_id'),
      threadSpawnEdges: readTable('thread_spawn_edges', 'parent_thread_id'),
    };
  } catch (err) {
    // DB 锁 / 权限 / schema 漂移都会走到这:返回空让导出降档,但必须留痕,
    // 否则"为什么 codex state 没进包"无从排查(review bot 指出)。
    log.warn('readThreadStateRows failed, exporting without codex state', {
      dbPath,
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { threads: [], threadDynamicTools: [], threadSpawnEdges: [] };
  } finally {
    closeDbQuietly(db);
  }
}

/** SqlRow → JSON 可序列化:Buffer 包 base64 标记(导入侧还原),bigint 转 string。 */
function serializeSqlRow(row: SqlRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (Buffer.isBuffer(value)) out[key] = { __xdtshareBlobB64: value.toString('base64') };
    else if (typeof value === 'bigint') out[key] = value.toString();
    else out[key] = value;
  }
  return out;
}

export interface ImportSharedCodexThreadParams {
  threadId: string;
  /** dumpCodexThreadStateRows 的序列化形态(Buffer 已包 base64 标记)。 */
  stateRows: {
    threads: Array<Record<string, unknown>>;
    threadDynamicTools: Array<Record<string, unknown>>;
    threadSpawnEdges: Array<Record<string, unknown>>;
  };
  rolloutBuffer: Buffer | null;
  rolloutFilename: string | null;
  newCwd: string;
  title: string;
  updatedAt: number;
}

export interface ImportSharedCodexThreadResult {
  /** 可用的 rollout 绝对路径(null = 包里没带 rollout 或文件名不安全被跳过)。 */
  rolloutPath: string | null;
  /** rollout 是否为本次真实写入(false = 盘上已有同名文件,复用未覆盖)。回滚只删真写入的。 */
  rolloutWritten: boolean;
  /**
   * state 三表是否有本次新插入的行(INSERT OR IGNORE 全部被忽略时为 false)。
   * 回滚只在 true 时清理,保证「删除后重导」场景不误删既有 state 行。
   */
  stateWritten: boolean;
  /**
   * 复用既有 thread 时，本次刷新前的可变字段快照。后续 Maker DB 事务失败时
   * 必须恢复，不能让失败的覆盖导入把旧任务的 cwd / rollout_path 改到新目录。
   */
  previousState: {
    dbPath: string;
    values: Record<string, SqlScalar>;
  } | null;
  /**
   * 调用结束后该 thread 的 state 行是否在 desktop state DB 里(本次写入或原本
   * 就在都算)。false = B 机无 state DB 或写入失败,调用方据此降档提示——
   * 不能用 stateWritten 判断:复用场景 stateWritten=false 但 state 完好。
   */
  statePresent: boolean;
}

/**
 * 会话分享导入:把包里的 codex thread 落到 desktop codex home。
 * 写三样:rollout jsonl(sessions/ 下,cwd 语义在 state 行里)、state 三表行
 * (threads.cwd / rollout_path 改写为本机新值,列交集 INSERT 容忍 schema 漂移)、
 * session_index.jsonl 追加。B 机无 state DB(从未跑过 codex)时跳过 state 写入,
 * 由调用方降档提示;rollout 仍落盘,用户跑过一次 codex 后 resume 链可自愈。
 * 失败回滚用 removeSharedCodexThread。
 */
export async function importSharedCodexThread(
  params: ImportSharedCodexThreadParams,
): Promise<ImportSharedCodexThreadResult> {
  const home = getDesktopCodexHome();
  let rolloutPath: string | null = null;
  let rolloutWritten = false;
  if (params.rolloutBuffer) {
    const candidate = params.rolloutFilename && /^[\w.-]+\.jsonl$/.test(params.rolloutFilename)
      ? params.rolloutFilename
      : `rollout-imported-${params.threadId}.jsonl`;
    // 落位层第二道闸(审查 P0):threadId / rolloutFilename 均源自不可信 .xdtshare,
    // 兜底分支拼出的 filename 必须整体再过单段白名单——只信参数 regex 会让
    // threadId 里的路径分隔符经兜底逃出 sessions 目录(编排层已校验,双闸防漂移)。
    if (/^[\w.-]+\.jsonl$/.test(candidate) && !candidate.includes('..')) {
      rolloutPath = path.join(home, 'sessions', candidate);
      await fsp.mkdir(path.dirname(rolloutPath), { recursive: true });
      // wx 独占写:同名 rollout 已在盘上(典型是删除 Maker 会话后重导同一分享包)
      // 时不覆盖、直接复用——盘上副本可能包含删除前 resume 产生的更新内容。
      try {
        await fsp.writeFile(rolloutPath, params.rolloutBuffer, { flag: 'wx' });
        rolloutWritten = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        log.info('import shared codex thread: rollout already on disk, reusing', {
          threadId: params.threadId,
        });
      }
    } else {
      log.warn('import shared codex thread: unsafe rollout filename, skip rollout write', {
        threadId: params.threadId,
      });
    }
  }

  let stateWritten = false;
  let previousState: ImportSharedCodexThreadResult['previousState'] = null;
  const dbPath = findLatestStateDb(home);
  if (dbPath && params.stateRows.threads.length > 0) {
    // thread 行已存在(典型是删除 Maker 会话后重导同一分享包——软删不清 state)时
    // 不重插三表:threads 有 PK 会被 IGNORE,但 thread_dynamic_tools /
    // thread_spawn_edges 无唯一约束,重复 INSERT 会翻倍;stateWritten 保持 false,
    // 让回滚不去误删既有行。但既有 threads 行的可变字段(cwd / rollout_path)必须
    // 刷新为本次导入值——codex resume 从 state DB 读这两列,不刷新会让重导会话
    // 跑回旧目录 / 指向失效 rollout(review bot P2)。UPDATE 前保留原值，若后续
    // Maker DB 事务失败则由 removeSharedCodexThread 恢复，避免失败导入污染旧任务。
    const preExisting = readRawThreadRow(dbPath, params.threadId) !== null;
    let db: Database.Database | null = null;
    try {
      db = createBetterSqliteDatabase(dbPath);
      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      const targetDb = db;
      if (preExisting) {
        if (tableExists(targetDb, 'threads')) {
          const columns = getTableColumns(targetDb, 'threads');
          const sets: string[] = [];
          const args: Record<string, SqlScalar> = { id: params.threadId };
          if (columns.includes('cwd')) {
            sets.push('cwd = @cwd');
            args.cwd = params.newCwd;
          }
          if (rolloutPath && columns.includes('rollout_path')) {
            sets.push('rollout_path = @rollout_path');
            args.rollout_path = rolloutPath;
          }
          if (sets.length > 0) {
            const previousRow = targetDb
              .prepare(
                `SELECT ${sets.map((set) => quoteIdent(set.slice(0, set.indexOf(' =')))).join(', ')} FROM threads WHERE id = @id`,
              )
              .get({ id: params.threadId }) as SqlRow | undefined;
            if (previousRow) {
              previousState = {
                dbPath,
                values: Object.fromEntries(
                  Object.entries(previousRow).filter(
                    (entry): entry is [string, SqlScalar] => entry[1] !== undefined,
                  ),
                ),
              };
            }
            targetDb.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = @id`).run(args);
          }
        }
      } else {
        const insertRows = (table: string, rows: Array<Record<string, unknown>>, overrides: Record<string, SqlScalar>) => {
          if (rows.length === 0 || !tableExists(targetDb, table)) return;
          const targetColumns = getTableColumns(targetDb, table);
          for (const raw of rows) {
            const row = deserializeSqlRow(raw);
            const columns = targetColumns.filter((c) => c in row || c in overrides);
            if (columns.length === 0) continue;
            const colsSql = columns.map(quoteIdent).join(', ');
            const placeholders = columns.map((c) => `@${c}`).join(', ');
            targetDb
              .prepare(`INSERT OR IGNORE INTO ${quoteIdent(table)} (${colsSql}) VALUES (${placeholders})`)
              .run({ ...pickColumns(row, columns), ...overrides });
          }
        };
        targetDb.transaction(() => {
          insertRows('threads', params.stateRows.threads, {
            cwd: params.newCwd,
            ...(rolloutPath ? { rollout_path: rolloutPath } : {}),
          });
          insertRows('thread_dynamic_tools', params.stateRows.threadDynamicTools, {});
          insertRows('thread_spawn_edges', params.stateRows.threadSpawnEdges, {});
        })();
        stateWritten = true;
      }
    } catch (err) {
      log.warn('import shared codex thread: state write failed', {
        threadId: params.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      closeDbQuietly(db);
    }
  }

  await appendSessionIndexEntry(home, {
    threadId: params.threadId,
    title: params.title,
    updatedAt: params.updatedAt,
  } as CodexThreadSummary);

  const statePresent = dbPath ? readRawThreadRow(dbPath, params.threadId) !== null : false;
  return { rolloutPath, rolloutWritten, stateWritten, previousState, statePresent };
}

/** 会话分享导入失败的回滚:删本次真实写入的 rollout/state 行，或恢复复用 thread 的可变字段。 */
export async function removeSharedCodexThread(
  threadId: string,
  written: ImportSharedCodexThreadResult,
): Promise<void> {
  if (written.rolloutPath && written.rolloutWritten) {
    await fsp.rm(written.rolloutPath, { force: true }).catch(() => undefined);
  }
  if (written.previousState) {
    let db: Database.Database | null = null;
    try {
      db = createBetterSqliteDatabase(written.previousState.dbPath);
      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      const entries = Object.entries(written.previousState.values);
      if (entries.length > 0 && tableExists(db, 'threads')) {
        const sets = entries.map(([column]) => `${quoteIdent(column)} = @${column}`);
        db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = @id`).run({
          id: threadId,
          ...written.previousState.values,
        });
      }
    } catch (err) {
      log.warn('restore shared codex thread state failed', {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      closeDbQuietly(db);
    }
  }
  if (!written.stateWritten) return;
  const dbPath = findLatestStateDb(getDesktopCodexHome());
  if (!dbPath) return;
  let db: Database.Database | null = null;
  try {
    db = createBetterSqliteDatabase(dbPath);
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    const targetDb = db;
    targetDb.transaction(() => {
      if (tableExists(targetDb, 'threads')) {
        targetDb.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      }
      if (tableExists(targetDb, 'thread_dynamic_tools')) {
        targetDb.prepare('DELETE FROM thread_dynamic_tools WHERE thread_id = ?').run(threadId);
      }
      if (tableExists(targetDb, 'thread_spawn_edges')) {
        targetDb.prepare('DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?').run(threadId);
      }
    })();
  } catch (err) {
    log.warn('remove shared codex thread failed', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    closeDbQuietly(db);
  }
}

/** serializeSqlRow 的逆向:还原 base64 Buffer 标记;其余值原样。 */
function deserializeSqlRow(raw: Record<string, unknown>): Record<string, SqlScalar> {
  const out: Record<string, SqlScalar> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { __xdtshareBlobB64?: unknown }).__xdtshareBlobB64 === 'string'
    ) {
      out[key] = Buffer.from((value as { __xdtshareBlobB64: string }).__xdtshareBlobB64, 'base64');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value === null
    ) {
      out[key] = value;
    }
    // 其它类型(嵌套对象等)丢弃:state 表列都是标量,非标量说明包数据异常
  }
  return out;
}

function pickColumns(row: Record<string, SqlScalar>, columns: string[]): Record<string, SqlScalar> {
  const out: Record<string, SqlScalar> = {};
  for (const c of columns) out[c] = c in row ? row[c] : null;
  return out;
}

/** Recover a missing private pointer without writing into the recorded path. */
async function recoverMissingPrivateRollout(
  threadId: string,
  targetDbPath: string,
  targetHome: string,
  recordedPath: string,
  beforeHandoff?: () => void,
  beforeReturn?: () => void,
): Promise<string | undefined> {
  const row = readRawThreadRow(targetDbPath, threadId);
  if (!row) throw resumePreparationBlocked(threadId, 'target state disappeared during recovery');

  const published = await publishFreshSyntheticBeforeHandoff(
    recordedPath,
    threadId,
    row,
    { skipPreferred: true },
  );
  if (!published) {
    if ((await readXdtMessagesByThreadId(threadId)).length === 0) {
      log.debug('private orphan recovery skipped: no readable localDb messages', { threadId });
      return undefined;
    }
    throw resumePreparationBlocked(threadId, 'a private recovery file could not be published safely');
  }

  // The absent path can still belong to a live Codex writer. It remains
  // authoritative until the state pointer is handed to the synthetic sibling.
  const materializedBeforeCas = readPrivateRolloutPathState(targetHome, recordedPath);
  if (materializedBeforeCas === 'non-empty-file') {
    return acceptStateBackedWinnerAfterRecovery(
      targetDbPath,
      threadId,
      targetHome,
      recordedPath,
      { allowedCanonicalPaths: [recordedPath] },
    );
  }
  if (materializedBeforeCas === 'empty-file') {
    throw resumePreparationBlocked(threadId, 'the private orphan began materializing during recovery');
  }
  if (materializedBeforeCas === 'unsafe') {
    throw resumePreparationBlocked(
      threadId,
      'the private orphan materialized outside Cindy storage or as a non-file',
    );
  }

  handoffThreadToSyntheticRollout(
    targetDbPath,
    threadId,
    targetHome,
    recordedPath,
    published,
    () => {
      beforeHandoff?.();
      return readPrivateRolloutPathState(targetHome, recordedPath) === 'missing';
    },
  );

  // Missing-path validation ran inside the write transaction. Once that
  // transaction commits, the synthetic path is irreversible; a writer that
  // wakes afterward is preserved but cannot pull state away from a live winner.
  const stateWinnerPath = readThreadRolloutPath(targetDbPath, threadId);
  const materializedAfterCas = readPrivateRolloutPathState(targetHome, recordedPath);
  if (stateWinnerPath === recordedPath) {
    if (materializedAfterCas === 'non-empty-file') {
      return acceptStateBackedWinnerAfterRecovery(
        targetDbPath,
        threadId,
        targetHome,
        recordedPath,
        { allowedCanonicalPaths: [recordedPath] },
      );
    }
    if (materializedAfterCas === 'empty-file') {
      throw resumePreparationBlocked(threadId, 'the private orphan began materializing during recovery');
    }
    if (materializedAfterCas === 'unsafe') {
      throw resumePreparationBlocked(
        threadId,
        'the private orphan materialized outside Cindy storage or as a non-file',
      );
    }
  } else if (materializedAfterCas !== 'missing') {
    log.warn('late private orphan was preserved after committed recovery handoff', {
      threadId,
      originalRolloutPath: recordedPath,
      recoveredRolloutPath: published.path,
    });
  }

  const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
  if (!isAcceptableSyntheticWinner(targetHome, winner, published)) {
    throw resumePreparationBlocked(threadId, 'target state changed during private orphan recovery');
  }
  log.info('recovered missing private Codex rollout from Cindy history', {
    threadId,
    originalRolloutPath: recordedPath,
    recoveredRolloutPath: winner,
    messageCount: published.messageCount,
    created: published.created,
  });
  return acceptStateBackedWinnerAfterRecovery(
    targetDbPath,
    threadId,
    targetHome,
    winner!,
    { beforeReturn },
  );
}

/** Recover a missing external pointer without ever recreating data outside Cindy storage. */
async function recoverMissingExternalRollout(
  threadId: string,
  targetDbPath: string,
  targetHome: string,
  recordedPath: string,
  beforeHandoff?: () => void,
  beforeReturn?: () => void,
): Promise<string> {
  const row = readRawThreadRow(targetDbPath, threadId);
  if (!row) throw resumePreparationBlocked(threadId, 'target state disappeared during recovery');

  const preferred = privateRolloutPathForStateRow(targetHome, recordedPath, row);
  const published = await publishFreshSyntheticBeforeHandoff(
    preferred,
    threadId,
    row,
    { skipPreferred: true },
  );
  if (!published) {
    throw resumePreparationBlocked(
      threadId,
      'the external rollout is missing and no fresh readable history could be published safely',
    );
  }
  handoffThreadToSyntheticRollout(
    targetDbPath,
    threadId,
    targetHome,
    recordedPath,
    published,
    () => {
      beforeHandoff?.();
      return rolloutPathIsMissing(recordedPath);
    },
  );
  const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
  if (!isAcceptableSyntheticWinner(targetHome, winner, published)) {
    throw resumePreparationBlocked(threadId, 'target state changed during missing-rollout recovery');
  }
  return acceptStateBackedWinnerAfterRecovery(
    targetDbPath,
    threadId,
    targetHome,
    winner!,
    { beforeReturn },
  );
}

/**
 * No target row exists, but an external current-schema row still identifies a
 * stably empty rollout. Publish a private synthetic history first, then copy the
 * source row with its rollout pointer overridden. The external empty is never
 * modified and an unindexed empty is intentionally not recoverable here.
 */
async function recoverStableExternalEmptyWithoutTargetState(
  threadId: string,
  targetDbPath: string,
  targetHome: string,
  external: CodexThreadSummary,
  originalEmpty: EmptyRolloutSnapshot,
  beforeHandoff?: () => void,
  beforeReturn?: () => void,
): Promise<string> {
  if (!isStableEmptyRollout(originalEmpty)) {
    throw resumePreparationBlocked(threadId, 'external rollout may still be materializing');
  }
  if (!external.sourceDbPath) {
    throw resumePreparationBlocked(threadId, 'external empty rollout has no state metadata');
  }

  const sourceRow = readRawThreadRow(external.sourceDbPath, threadId);
  if (!sourceRow) {
    throw resumePreparationBlocked(threadId, 'external thread state disappeared during recovery');
  }

  const preferred = targetRolloutPathForExternalThread(external, targetHome);
  const published = await publishFreshSyntheticBeforeHandoff(
    preferred,
    threadId,
    sourceRow,
    // Keep an unpublished partial result visibly Cindy-owned. If the external
    // writer wakes before state handoff, the next attempt must adopt that source
    // instead of mistaking this orphan for a canonical Codex rollout.
    { skipPreferred: true },
  );
  if (!published) {
    throw resumePreparationBlocked(threadId, 'a private recovery file could not be published safely');
  }

  if (!emptyRolloutStillMatches(external.rolloutPath, originalEmpty)) {
    throw resumePreparationBlocked(threadId, 'external rollout changed before private state handoff');
  }

  const assertRecoverySourcesUnchanged = () => {
    beforeHandoff?.();
    if (!emptyRolloutStillMatches(external.rolloutPath, originalEmpty)) {
      throw resumePreparationBlocked(
        threadId,
        'external rollout changed before private state handoff',
      );
    }
  };
  const copiedState = copyThreadStateToTarget(external, targetDbPath, {
    rolloutPathOverride: published.path,
    validateBeforeCopy: () => {
      assertRecoverySourcesUnchanged();
      return syntheticPublicationStillMatches(targetHome, published);
    },
    validateAfterCopy: () => {
      assertRecoverySourcesUnchanged();
      return syntheticPublicationOwnsPath(targetHome, published);
    },
  });
  const winner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
  if (!winner) {
    log.warn('external empty rollout recovery could not establish private state', {
      threadId,
      copiedState,
      recoveredRolloutPath: published.path,
    });
    throw resumePreparationBlocked(threadId, 'external state could not be copied after recovery');
  }
  if (!isAcceptableSyntheticWinner(targetHome, winner, published)) {
    throw resumePreparationBlocked(threadId, 'a concurrent state handoff selected a different recovery');
  }

  if (!emptyRolloutStillMatches(external.rolloutPath, originalEmpty)) {
    log.warn('external rollout changed after private state handoff; preserved outside Cindy append boundary', {
      threadId,
      externalRolloutPath: external.rolloutPath,
      recoveredRolloutPath: winner,
    });
  }
  log.info('recovered stable external empty rollout with source state', {
    threadId,
    externalRolloutPath: external.rolloutPath,
    recoveredRolloutPath: winner,
    messageCount: published.messageCount,
    created: published.created,
  });
  return acceptStateBackedWinnerAfterRecovery(
    targetDbPath,
    threadId,
    targetHome,
    winner,
    { beforeReturn },
  );
}

/**
 * Repair the #1554 shape: an existing state row points at a stably empty
 * rollout. The original is preserved, a private recovery is published first,
 * and the state pointer moves transactionally. Private writers detected before
 * commit remain authoritative; writers waking after commit are preserved but
 * never pull state away from the recovered append target.
 */
async function recoverStableEmptyRollout(
  threadId: string,
  targetDbPath: string,
  targetHome: string,
  rolloutPath: string,
  beforeHandoff?: () => void,
  beforeReturn?: () => void,
): Promise<string | undefined> {
  const originalEmpty = readEmptyRolloutSnapshot(rolloutPath);
  if (!originalEmpty || !isStableEmptyRollout(originalEmpty)) {
    log.debug('empty rollout recovery deferred: file may still be materializing', {
      threadId,
      rolloutPath,
    });
    throw resumePreparationBlocked(threadId, 'the rollout may still be materializing');
  }

  const row = readRawThreadRow(targetDbPath, threadId);
  if (!row) throw resumePreparationBlocked(threadId, 'target state disappeared during recovery');

  const originalIsPrivate = isPathInside(targetHome, rolloutPath);
  const preferredPrivatePath = originalIsPrivate
    ? rolloutPath
    : privateRolloutPathForStateRow(targetHome, rolloutPath, row);
  const published = await publishFreshSyntheticBeforeHandoff(
    preferredPrivatePath,
    threadId,
    row,
    { skipPreferred: true },
  );
  if (!published) {
    throw resumePreparationBlocked(threadId, 'a private recovery file could not be published safely');
  }

  const originalChangedBeforeCas = !emptyRolloutStillMatches(rolloutPath, originalEmpty);
  if (originalChangedBeforeCas && originalIsPrivate) {
    const current = readPrivateRolloutPathState(targetHome, rolloutPath);
    if (current === 'non-empty-file') {
      return acceptStateBackedWinnerAfterRecovery(
        targetDbPath,
        threadId,
        targetHome,
        rolloutPath,
        { allowedCanonicalPaths: [rolloutPath] },
      );
    }
    if (current === 'empty-file') {
      throw resumePreparationBlocked(threadId, 'the private rollout changed during recovery');
    }
    throw resumePreparationBlocked(
      threadId,
      'the private rollout changed outside its safe storage boundary during recovery',
    );
  }

  handoffThreadToSyntheticRollout(
    targetDbPath,
    threadId,
    targetHome,
    rolloutPath,
    published,
    () => {
      beforeHandoff?.();
      return emptyRolloutStillMatches(rolloutPath, originalEmpty);
    },
  );
  let recoveredWinner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);

  const originalChangedAfterCas = !emptyRolloutStillMatches(rolloutPath, originalEmpty);
  if (originalChangedAfterCas && originalIsPrivate) {
    const current = readPrivateRolloutPathState(targetHome, rolloutPath);
    const stateWinner = readThreadRolloutPath(targetDbPath, threadId);
    if (stateWinner === rolloutPath) {
      if (current === 'non-empty-file') {
        return acceptStateBackedWinnerAfterRecovery(
          targetDbPath,
          threadId,
          targetHome,
          rolloutPath,
          { allowedCanonicalPaths: [rolloutPath] },
        );
      }
      if (current === 'empty-file') {
        throw resumePreparationBlocked(threadId, 'the private rollout began materializing during recovery');
      }
      throw resumePreparationBlocked(
        threadId,
        'the private rollout changed outside its safe storage boundary during recovery',
      );
    } else {
      log.warn('late private rollout was preserved after committed recovery handoff', {
        threadId,
        originalRolloutPath: rolloutPath,
        recoveredRolloutPath: published.path,
      });
    }
  }
  if ((originalChangedBeforeCas || originalChangedAfterCas) && !originalIsPrivate) {
    log.warn('external rollout changed during recovery; preserved outside Cindy append boundary', {
      threadId,
      externalRolloutPath: rolloutPath,
      recoveredRolloutPath: published.path,
    });
  }
  recoveredWinner = readPrivateNonEmptyRollout(targetDbPath, threadId, targetHome);
  if (!recoveredWinner) {
    throw resumePreparationBlocked(threadId, 'the rollout pointer changed during recovery');
  }

  // A concurrent recovery may win CAS with a different path. Accept it only
  // when it is byte-identical to the snapshot verified immediately pre-handoff.
  if (!isAcceptableSyntheticWinner(targetHome, recoveredWinner, published)) {
    throw resumePreparationBlocked(threadId, 'a concurrent state handoff selected a different recovery');
  }

  log.info('recovered stable empty Codex rollout from Cindy history', {
    threadId,
    originalRolloutPath: rolloutPath,
    recoveredRolloutPath: recoveredWinner,
    messageCount: published.messageCount,
    created: published.created,
  });
  return acceptStateBackedWinnerAfterRecovery(
    targetDbPath,
    threadId,
    targetHome,
    recoveredWinner,
    { beforeReturn },
  );
}

function syntheticPublicationStillMatches(
  targetHome: string,
  publication: FreshSyntheticPublication,
): boolean {
  const current = readPrivateExactRolloutSnapshot(
    targetHome,
    publication.path,
    publication.contents,
  );
  return !!current
    && current.dev === publication.snapshot.dev
    && current.ino === publication.snapshot.ino
    && current.size === publication.snapshot.size
    && current.mtimeMs === publication.snapshot.mtimeMs
    && current.ctimeMs === publication.snapshot.ctimeMs
    && current.birthtimeMs === publication.snapshot.birthtimeMs;
}

/** Same published inode is still private and regular; native appends are valid. */
function syntheticPublicationOwnsPath(
  targetHome: string,
  publication: FreshSyntheticPublication,
  candidatePath: string = publication.path,
): boolean {
  if (!isPathInside(targetHome, candidatePath)) return false;
  try {
    const before = fs.lstatSync(candidatePath);
    if (
      !before.isFile()
      || before.size <= 0
      || before.dev !== publication.snapshot.dev
      || before.ino !== publication.snapshot.ino
    ) return false;
    const after = fs.lstatSync(candidatePath);
    return after.isFile()
      && after.size > 0
      && after.dev === before.dev
      && after.ino === before.ino
      && isPathInside(targetHome, candidatePath);
  } catch {
    return false;
  }
}

function isAcceptableSyntheticWinner(
  targetHome: string,
  winner: string | null,
  publication: FreshSyntheticPublication,
): boolean {
  if (!winner) return false;
  if (samePath(winner, publication.path)) {
    // Once a transaction commits this private regular path, native Codex may
    // immediately append or another validated recovery may reuse the same name.
    return readPrivateRolloutPathState(targetHome, winner) === 'non-empty-file';
  }
  return !!readPrivateExactRolloutSnapshot(targetHome, winner, publication.contents);
}

/**
 * Reconcile an invalid external state pointer to an already-native private
 * rollout. Identity, rather than size, is the boundary because Codex may keep
 * appending to this inode while the IMMEDIATE transaction commits.
 */
function handoffThreadToNativeRollout(
  targetDbPath: string,
  threadId: string,
  targetHome: string,
  expectedRolloutPath: string,
  publication: PrivateRolloutPublication,
  expectedPathGuard?: () => void,
): boolean {
  let db: Database.Database | null = null;
  const rollback = new Error('native rollout identity changed during state reconciliation');
  try {
    db = createBetterSqliteDatabase(targetDbPath);
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (!tableExists(db, 'threads')) return false;
    const targetDb = db;
    const handoff = targetDb.transaction(() => {
      const current = targetDb
        .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1')
        .get(threadId) as { rolloutPath?: unknown } | undefined;
      if (current?.rolloutPath === publication.path) {
        return privateRolloutPublicationOwnsPath(targetHome, publication);
      }
      if (current?.rolloutPath !== expectedRolloutPath) return false;
      expectedPathGuard?.();
      if (!privateRolloutPublicationOwnsPath(targetHome, publication)) return false;
      const updated = targetDb.prepare(
        'UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?',
      ).run(publication.path, threadId, expectedRolloutPath);
      if (updated.changes === 0) return false;
      if (!privateRolloutPublicationOwnsPath(targetHome, publication)) throw rollback;
      expectedPathGuard?.();
      return true;
    });
    return handoff.immediate();
  } catch (error) {
    if (error !== rollback) {
      log.warn('failed to reconcile Codex thread to native rollout', {
        threadId,
        rolloutPath: publication.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    closeDbQuietly(db);
  }
}

function handoffThreadToCopiedRollout(
  targetDbPath: string,
  threadId: string,
  targetHome: string,
  expectedRolloutPath: string,
  publication: PrivateRolloutPublication,
  expectedPathGuard?: () => void,
): boolean {
  let db: Database.Database | null = null;
  const rollback = new Error('copied rollout identity changed during state handoff');
  try {
    db = createBetterSqliteDatabase(targetDbPath);
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (!tableExists(db, 'threads')) return false;
    const targetDb = db;
    const handoff = targetDb.transaction(() => {
      const current = targetDb
        .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1')
        .get(threadId) as { rolloutPath?: unknown } | undefined;
      if (current?.rolloutPath === publication.path) {
        return readPrivateRolloutPathState(targetHome, publication.path) === 'non-empty-file';
      }
      if (current?.rolloutPath !== expectedRolloutPath) return false;
      expectedPathGuard?.();
      if (!privateRolloutPublicationStillMatches(targetHome, publication)) return false;
      const updated = targetDb.prepare(
        'UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?',
      ).run(publication.path, threadId, expectedRolloutPath);
      if (updated.changes === 0) return false;
      if (!privateRolloutPublicationStillMatches(targetHome, publication)) throw rollback;
      expectedPathGuard?.();
      return true;
    });
    return handoff.immediate();
  } catch (error) {
    if (error !== rollback) {
      log.warn('failed to hand off Codex thread to copied rollout', {
        threadId,
        rolloutPath: publication.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    closeDbQuietly(db);
  }
}

/**
 * Persist an existing-row handoff only while the exact staged snapshot is
 * current. If the path is swapped during CAS, roll back only our pointer. A
 * same-inode append after CAS is authoritative native progress and is retained.
 */
function handoffThreadToSyntheticRollout(
  targetDbPath: string,
  threadId: string,
  targetHome: string,
  expectedRolloutPath: string,
  publication: FreshSyntheticPublication,
  expectedPathStillOwns?: () => boolean,
): boolean {
  let db: Database.Database | null = null;
  const rollback = new Error('synthetic rollout identity changed during state handoff');
  try {
    db = createBetterSqliteDatabase(targetDbPath);
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (!tableExists(db, 'threads')) return false;
    const targetDb = db;
    const handoff = targetDb.transaction(() => {
      const current = targetDb
        .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1')
        .get(threadId) as { rolloutPath?: unknown } | undefined;
      if (current?.rolloutPath === publication.path) {
        return readPrivateRolloutPathState(targetHome, publication.path) === 'non-empty-file';
      }
      if (current?.rolloutPath !== expectedRolloutPath) return false;
      if (expectedPathStillOwns && !expectedPathStillOwns()) return false;
      if (!syntheticPublicationStillMatches(targetHome, publication)) return false;

      const updated = targetDb.prepare(
        'UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?',
      ).run(publication.path, threadId, expectedRolloutPath);
      if (updated.changes === 0) return false;
      // Throwing here rolls back the still-uncommitted pointer. No other
      // recovery can commit a same-path handoff while this write tx is open.
      if (
        !syntheticPublicationOwnsPath(targetHome, publication)
        || (expectedPathStillOwns && !expectedPathStillOwns())
      ) throw rollback;
      return true;
    });
    return handoff.immediate();
  } catch (error) {
    if (error !== rollback) {
      log.warn('failed to hand off Codex thread to synthetic rollout', {
        threadId,
        rolloutPath: publication.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    closeDbQuietly(db);
  }
}

/** Cindy 会话仍在、Codex state 与 rollout 都丢失时用于重建 session_meta 的最小元数据。 */
interface LocalCodexRecoverySession {
  id: string;
  workingDir: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 一条可用于合成 rollout 的 Cindy 会话及其已过滤历史。 */
interface LocalCodexRecoverySource {
  session: LocalCodexRecoverySession;
  messages: SyntheticRolloutMessage[];
  recoveryCreatedAt: number;
}

interface FreshLocalSyntheticPublication extends FreshSyntheticPublication {
  source: LocalCodexRecoverySource;
}

/**
 * Stage a state-less recovery under a Cindy-only filename. Codex's UUID lookup
 * returns the first canonical filename yielded by read_dir, not the newest one,
 * so H1/H2 convergence must finish before any canonical candidate is visible.
 */
async function publishFreshLocalSyntheticBeforeHandoff(
  preferredPath: string,
  threadId: string,
): Promise<FreshLocalSyntheticPublication | null> {
  for (let attempt = 0; attempt < MAX_RECOVERY_PATH_ATTEMPTS; attempt += 1) {
    const source = await readBestLocalCodexRecoverySource(threadId);
    if (!source) return null;
    const contents = buildSyntheticRollout(
      threadId,
      syntheticRowForLocalRecoverySource(source),
      source.messages,
    );
    const published = await publishSyntheticRollout(
      preferredPath,
      threadId,
      contents,
      { skipPreferred: true, siblingKind: 'state-less-stage' },
    );
    if (!published) return null;

    const latestSource = await readBestLocalCodexRecoverySource(threadId);
    if (!latestSource) {
      throw resumePreparationBlocked(threadId, 'local recovery history disappeared before handoff');
    }
    const latestContents = buildSyntheticRollout(
      threadId,
      syntheticRowForLocalRecoverySource(latestSource),
      latestSource.messages,
    );
    const latestSnapshot = readPrivateExactRolloutSnapshot(
      getDesktopCodexHome(),
      published.path,
      latestContents,
    );
    if (latestSnapshot) {
      return {
        ...published,
        snapshot: latestSnapshot,
        contents: latestContents,
        messageCount: latestSource.messages.length,
        source: latestSource,
      };
    }
  }
  throw resumePreparationBlocked(threadId, 'local recovery history did not stabilize before handoff');
}

interface CanonicalSyntheticPublication {
  path: string;
  created: boolean;
  synthetic: boolean;
}

/** Atomically expose one exact synthetic candidate under Codex's canonical filename. */
function publishStagedSyntheticAtCanonical(
  threadId: string,
  targetHome: string,
  staged: FreshLocalSyntheticPublication,
  canonicalPath: string,
  expectedCanonicalStillAvailable?: () => boolean,
): CanonicalSyntheticPublication {
  if (
    !isCanonicalCodexRolloutPath(canonicalPath, threadId)
    || !isPathInside(targetHome, canonicalPath)
  ) {
    throw resumePreparationBlocked(threadId, 'the recovery target is outside the canonical private layout');
  }
  if (!syntheticPublicationStillMatches(targetHome, staged)) {
    throw resumePreparationBlocked(threadId, 'the staged recovery changed outside its safe boundary');
  }
  if (expectedCanonicalStillAvailable && !expectedCanonicalStillAvailable()) {
    throw resumePreparationBlocked(threadId, 'the preserved rollout materialized before canonical handoff');
  }
  try {
    fs.linkSync(staged.path, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readPrivateRolloutPathState(targetHome, canonicalPath);
    if (
      winner === 'non-empty-file'
      && syntheticPublicationOwnsPath(targetHome, staged, canonicalPath)
    ) {
      assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
      return { path: canonicalPath, created: false, synthetic: true };
    }
    if (
      winner === 'non-empty-file'
      && syntheticPublicationStillMatches(targetHome, staged)
      && readPrivateExactRolloutSnapshot(targetHome, canonicalPath, staged.contents)
    ) {
      assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
      return { path: canonicalPath, created: false, synthetic: true };
    }
    if (winner === 'non-empty-file') {
      assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
      return { path: canonicalPath, created: false, synthetic: false };
    }
    if (winner === 'empty-file') {
      throw resumePreparationBlocked(threadId, 'a same-thread rollout began materializing during recovery');
    }
    throw resumePreparationBlocked(threadId, 'the canonical recovery path changed outside its safe boundary');
  }
  if (syntheticPublicationOwnsPath(targetHome, staged, canonicalPath)) {
    assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
    return { path: canonicalPath, created: true, synthetic: true };
  }

  // We created this name from a Cindy-only staging path. If that staging name
  // was replaced with another inode during link(), remove only the hard-link
  // we just created; a same-inode native append is accepted above and retained.
  if (
    readPrivateRolloutPathState(targetHome, staged.path) === 'non-empty-file'
    && readPrivateRolloutPathState(targetHome, canonicalPath) === 'non-empty-file'
    && sameRegularFileIdentity(staged.path, canonicalPath)
  ) {
    fs.unlinkSync(canonicalPath);
  }
  throw resumePreparationBlocked(threadId, 'the canonical recovery publication changed before handoff');
}

type EmptyCanonicalPreservation =
  | { kind: 'native-winner' }
  | { kind: 'preserved'; path: string };

/**
 * Move a stable empty canonical name aside without overwriting anything. A
 * hard-link followed by unlink preserves the original inode even when a late
 * Codex writer still has it open.
 */
function preserveStableEmptyCanonical(
  threadId: string,
  targetHome: string,
  canonicalPath: string,
  originalEmpty: EmptyRolloutSnapshot,
  opts: { preserveLateNativeAsArtifact?: boolean } = {},
): EmptyCanonicalPreservation {
  const current = readPrivateRolloutPathState(targetHome, canonicalPath);
  if (current === 'non-empty-file' && !opts.preserveLateNativeAsArtifact) {
    return { kind: 'native-winner' };
  }
  const unchangedEmpty = current === 'empty-file'
    && emptyRolloutStillMatches(canonicalPath, originalEmpty);
  const sameInodeLateNative = current === 'non-empty-file'
    && opts.preserveLateNativeAsArtifact
    && regularFileIdentityMatchesSnapshot(canonicalPath, originalEmpty);
  if (!unchangedEmpty && !sameInodeLateNative) {
    throw resumePreparationBlocked(threadId, 'the stable empty canonical changed before preservation');
  }

  for (let attempt = 0; attempt < MAX_RECOVERY_PATH_ATTEMPTS; attempt += 1) {
    const preservedPath = recoveredSiblingRolloutPath(
      canonicalPath,
      threadId,
      attempt,
      opts.preserveLateNativeAsArtifact ? 'retired-empty' : 'preserved-empty',
    );
    try {
      fs.linkSync(canonicalPath, preservedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A prior publication failure or process exit can leave both names linked
      // to the same empty inode. Reuse that recoverable checkpoint instead of
      // turning it into a permanent blocker.
      if (!sameRegularFileIdentity(canonicalPath, preservedPath)) continue;
    }

    if (
      !sameRegularFileIdentity(canonicalPath, preservedPath)
      || readPrivateRolloutPathState(targetHome, preservedPath) === 'unsafe'
    ) {
      throw resumePreparationBlocked(threadId, 'the preserved empty rollout crossed its safe boundary');
    }
    const originalAfterLink = readPrivateRolloutPathState(targetHome, canonicalPath);
    if (originalAfterLink === 'non-empty-file' && !opts.preserveLateNativeAsArtifact) {
      try {
        if (sameRegularFileIdentity(canonicalPath, preservedPath)) fs.unlinkSync(preservedPath);
      } catch {
        // The duplicate Cindy-only name is harmless; the canonical remains authoritative.
      }
      return { kind: 'native-winner' };
    }
    if (originalAfterLink !== 'empty-file' && originalAfterLink !== 'non-empty-file') {
      throw resumePreparationBlocked(threadId, 'the canonical rollout changed during preservation');
    }
    try {
      fs.unlinkSync(canonicalPath);
    } catch (error) {
      if (!opts.preserveLateNativeAsArtifact) {
        try {
          if (sameRegularFileIdentity(canonicalPath, preservedPath)) fs.unlinkSync(preservedPath);
        } catch {
          // Best effort rollback of the duplicate link; never remove the canonical.
        }
      }
      throw resumePreparationBlocked(
        threadId,
        `the empty canonical could not be moved aside (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }
    return { kind: 'preserved', path: preservedPath };
  }
  throw resumePreparationBlocked(threadId, 'no safe preservation path was available for the empty rollout');
}

function restorePreservedCanonical(
  threadId: string,
  targetHome: string,
  preservedPath: string,
  canonicalPath: string,
): string {
  const preserved = readPrivateRolloutPathState(targetHome, preservedPath);
  if (preserved !== 'empty-file' && preserved !== 'non-empty-file') {
    throw resumePreparationBlocked(threadId, 'the preserved rollout changed outside its safe boundary');
  }
  try {
    fs.linkSync(preservedPath, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!sameRegularFileIdentity(preservedPath, canonicalPath)) {
      throw resumePreparationBlocked(threadId, 'another writer occupied the canonical rollout path');
    }
  }
  const restored = readPrivateRolloutPathState(targetHome, canonicalPath);
  if (restored !== preserved || !sameRegularFileIdentity(preservedPath, canonicalPath)) {
    throw resumePreparationBlocked(threadId, 'the preserved rollout could not be restored safely');
  }
  return canonicalPath;
}

/** Accept one native canonical only after every pre-handoff source still matches. */
function acceptSoleCanonicalNativeWinner(
  threadId: string,
  targetHome: string,
  canonicalPath: string,
  beforeReturn?: () => void,
): string {
  beforeReturn?.();
  assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
  return canonicalPath;
}

function assertSoleCanonicalPath(
  threadId: string,
  targetHome: string,
  canonicalPath: string,
  requireNonEmpty: boolean,
): void {
  const current = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  const allCanonical = [
    ...current.empties.map((candidate) => candidate.path),
    ...current.nonEmpty,
  ];
  if (
    allCanonical.length !== 1
    || !samePath(allCanonical[0], canonicalPath)
    || (requireNonEmpty && current.nonEmpty.length !== 1)
  ) {
    throw resumePreparationBlocked(
      threadId,
      'the private canonical rollout namespace changed before completing the handoff',
    );
  }
}

/** Restore a preserved native inode only while its canonical name is still unopposed. */
function restoreSoleCanonicalNativeWinner(
  threadId: string,
  targetHome: string,
  preservedPath: string,
  canonicalPath: string,
  beforeReturn?: () => void,
): string {
  beforeReturn?.();
  assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [canonicalPath]);
  const restored = restorePreservedCanonical(
    threadId,
    targetHome,
    preservedPath,
    canonicalPath,
  );
  // The canonical link is an irreversible handoff: Codex may already have
  // opened it or hydrated state even when this post-link check fails.
  return acceptSoleCanonicalNativeWinner(
    threadId,
    targetHome,
    restored,
    beforeReturn,
  );
}

/** Restore an empty/native precursor after a failed publication only if it remains the sole history. */
function restorePreservedCanonicalAfterFailedHandoff(
  threadId: string,
  targetHome: string,
  preservedPath: string,
  canonicalPath: string,
  beforeRestore?: () => void,
): void {
  beforeRestore?.();
  assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [canonicalPath]);
  if (readPrivateRolloutPathState(targetHome, canonicalPath) !== 'missing') return;
  restorePreservedCanonical(threadId, targetHome, preservedPath, canonicalPath);
  beforeRestore?.();
  assertSoleCanonicalPath(threadId, targetHome, canonicalPath, false);
  if (sameRegularFileIdentity(preservedPath, canonicalPath)) {
    fs.unlinkSync(preservedPath);
  }
}

/**
 * Recover a stable canonical empty when the Codex state row is gone. The empty
 * inode is retained under a Cindy-only name and exactly one canonical filename
 * is exposed, so Codex's unordered first-match UUID scan cannot pick the empty.
 */
async function recoverStableCanonicalEmptyWithoutTargetState(
  threadId: string,
  targetHome: string,
  canonicalPath: string,
  originalEmpty: EmptyRolloutSnapshot,
  beforeHandoff?: () => void,
): Promise<string | null> {
  if (!isStableEmptyRollout(originalEmpty)) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }
  if (
    !isCanonicalCodexRolloutPath(canonicalPath, threadId)
    || readPrivateRolloutPathState(targetHome, canonicalPath) !== 'empty-file'
  ) {
    throw resumePreparationBlocked(threadId, 'the empty rollout is not a regular private canonical file');
  }

  const staged = await publishFreshLocalSyntheticBeforeHandoff(canonicalPath, threadId);
  if (!staged) return null;
  const preservation = preserveStableEmptyCanonical(
    threadId,
    targetHome,
    canonicalPath,
    originalEmpty,
  );
  if (preservation.kind === 'native-winner') {
    return acceptSoleCanonicalNativeWinner(
      threadId,
      targetHome,
      canonicalPath,
      beforeHandoff,
    );
  }

  const preservedBeforePublication = readPrivateRolloutPathState(targetHome, preservation.path);
  if (preservedBeforePublication === 'non-empty-file') {
    return restoreSoleCanonicalNativeWinner(
      threadId,
      targetHome,
      preservation.path,
      canonicalPath,
      beforeHandoff,
    );
  }
  if (preservedBeforePublication !== 'empty-file') {
    throw resumePreparationBlocked(threadId, 'the preserved empty rollout changed before handoff');
  }

  let published: CanonicalSyntheticPublication;
  try {
    published = publishStagedSyntheticAtCanonical(
      threadId,
      targetHome,
      staged,
      canonicalPath,
      () => {
        beforeHandoff?.();
        assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [canonicalPath]);
        return readPrivateRolloutPathState(targetHome, preservation.path) === 'empty-file';
      },
    );
  } catch (error) {
    if (readPrivateRolloutPathState(targetHome, canonicalPath) === 'missing') {
      try {
        restorePreservedCanonicalAfterFailedHandoff(
          threadId,
          targetHome,
          preservation.path,
          canonicalPath,
          beforeHandoff,
        );
      } catch {
        // Preserve the original exception; both files remain inside Cindy storage.
      }
    }
    throw error;
  }
  if (!published.synthetic) return published.path;

  // link(canonical) is the no-state commit point: Codex's scanner may open it
  // immediately. A retained writer waking afterward stays preserved under the
  // Cindy-only name and must never pull canonical away from that live inode.
  if (readPrivateRolloutPathState(targetHome, preservation.path) === 'non-empty-file') {
    log.warn('late native rollout was preserved after canonical recovery handoff', {
      threadId,
      preservedRolloutPath: preservation.path,
      recoveredRolloutPath: canonicalPath,
    });
  }

  log.info('recovered stable canonical empty Codex rollout without target state', {
    threadId,
    originalRolloutPath: canonicalPath,
    preservedRolloutPath: preservation.path,
    recoveredRolloutPath: published.path,
    messageCount: staged.messageCount,
    created: published.created,
  });
  return published.path;
}

interface CanonicalFullRolloutPublication {
  path: string;
  created: boolean;
  staged: boolean;
}

function publishStagedFullRolloutAtCanonical(
  threadId: string,
  targetHome: string,
  staged: PrivateRolloutPublication,
  canonicalPath: string,
  expectedCanonicalStillAvailable?: () => boolean,
): CanonicalFullRolloutPublication {
  if (
    !isCanonicalCodexRolloutPath(canonicalPath, threadId)
    || !isPathInside(targetHome, canonicalPath)
  ) {
    throw resumePreparationBlocked(threadId, 'the external adoption target is outside private storage');
  }
  if (!privateRolloutPublicationStillMatches(targetHome, staged)) {
    throw resumePreparationBlocked(threadId, 'the staged external rollout changed outside private storage');
  }
  if (expectedCanonicalStillAvailable && !expectedCanonicalStillAvailable()) {
    throw resumePreparationBlocked(threadId, 'the preserved rollout materialized before external handoff');
  }
  try {
    fs.linkSync(staged.path, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readPrivateRolloutPathState(targetHome, canonicalPath);
    if (
      winner === 'non-empty-file'
      && privateRolloutPublicationOwnsPath(targetHome, staged, canonicalPath)
    ) {
      assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
      return { path: canonicalPath, created: false, staged: true };
    }
    if (winner === 'non-empty-file') {
      assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
      return { path: canonicalPath, created: false, staged: false };
    }
    if (winner === 'empty-file') {
      throw resumePreparationBlocked(threadId, 'a same-thread rollout began materializing during adoption');
    }
    throw resumePreparationBlocked(threadId, 'the external adoption target changed outside its safe boundary');
  }
  if (privateRolloutPublicationOwnsPath(targetHome, staged, canonicalPath)) {
    assertSoleCanonicalPath(threadId, targetHome, canonicalPath, true);
    return { path: canonicalPath, created: true, staged: true };
  }

  // We created this canonical name, but link() may have opened a swapped
  // staging inode after the captured publication was validated. Remove only
  // that just-linked current staging inode; never unlink an unrelated winner.
  if (
    readPrivateRolloutPathState(targetHome, staged.path) === 'non-empty-file'
    && readPrivateRolloutPathState(targetHome, canonicalPath) === 'non-empty-file'
    && sameRegularFileIdentity(staged.path, canonicalPath)
  ) {
    fs.unlinkSync(canonicalPath);
  }
  throw resumePreparationBlocked(threadId, 'the external rollout publication changed before handoff');
}

/**
 * A rollout-only external source has no state row that can point at a sibling.
 * Preserve a stable private empty, then atomically expose the verified external
 * snapshot under its sole canonical name. A local native writer still wins up
 * to that handoff; later external writes remain isolated in the source HOME.
 */
async function adoptExternalRolloutOverStableCanonicalWithoutState(
  threadId: string,
  targetHome: string,
  sourcePath: string,
  canonicalPath: string,
  originalEmpty: EmptyRolloutSnapshot,
  beforeHandoff?: () => void,
): Promise<string> {
  if (!isStableEmptyRollout(originalEmpty)) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }
  const staged = await copyExternalRolloutAtomically(
    sourcePath,
    canonicalPath,
    threadId,
    { allowSibling: true, skipPreferred: true },
  );
  if (!staged) {
    throw resumePreparationBlocked(threadId, 'external rollout changed during private adoption');
  }
  const preservation = preserveStableEmptyCanonical(
    threadId,
    targetHome,
    canonicalPath,
    originalEmpty,
  );
  if (preservation.kind === 'native-winner') {
    return acceptSoleCanonicalNativeWinner(
      threadId,
      targetHome,
      canonicalPath,
      beforeHandoff,
    );
  }
  const preservedBeforePublication = readPrivateRolloutPathState(targetHome, preservation.path);
  if (preservedBeforePublication === 'non-empty-file') {
    return restoreSoleCanonicalNativeWinner(
      threadId,
      targetHome,
      preservation.path,
      canonicalPath,
      beforeHandoff,
    );
  }
  if (preservedBeforePublication !== 'empty-file') {
    throw resumePreparationBlocked(threadId, 'the preserved empty rollout changed before adoption');
  }

  let published: CanonicalFullRolloutPublication;
  try {
    published = publishStagedFullRolloutAtCanonical(
      threadId,
      targetHome,
      staged,
      canonicalPath,
      () => {
        beforeHandoff?.();
        assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [canonicalPath]);
        return readPrivateRolloutPathState(targetHome, preservation.path) === 'empty-file';
      },
    );
  } catch (error) {
    if (readPrivateRolloutPathState(targetHome, canonicalPath) === 'missing') {
      try {
        restorePreservedCanonicalAfterFailedHandoff(
          threadId,
          targetHome,
          preservation.path,
          canonicalPath,
          beforeHandoff,
        );
      } catch {
        // Preserve the original error and every recoverable private artifact.
      }
    }
    throw error;
  }
  if (!published.staged) return published.path;

  if (readPrivateRolloutPathState(targetHome, preservation.path) === 'non-empty-file') {
    log.warn('late native rollout was preserved after external canonical handoff', {
      threadId,
      preservedRolloutPath: preservation.path,
      recoveredRolloutPath: canonicalPath,
    });
  }

  log.info('adopted rollout-only external history over stable private empty', {
    threadId,
    sourceRolloutPath: sourcePath,
    preservedRolloutPath: preservation.path,
    recoveredRolloutPath: published.path,
    created: published.created,
  });
  return published.path;
}

async function adoptExternalRolloutAfterPendingLocalHandoff(
  threadId: string,
  targetHome: string,
  sourcePath: string,
  canonicalPath: string,
  beforeHandoff: () => void,
): Promise<string> {
  const staged = await copyExternalRolloutAtomically(
    sourcePath,
    canonicalPath,
    threadId,
    { allowSibling: true, skipPreferred: true },
  );
  if (!staged) {
    throw resumePreparationBlocked(threadId, 'external rollout changed during guarded adoption');
  }
  const published = publishStagedFullRolloutAtCanonical(
    threadId,
    targetHome,
    staged,
    canonicalPath,
    () => {
      beforeHandoff();
      assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [canonicalPath]);
      return true;
    },
  );
  log.info('adopted rollout-only external history after pending local handoff', {
    threadId,
    sourceRolloutPath: sourcePath,
    recoveredRolloutPath: published.path,
    created: published.created,
  });
  return published.path;
}

/**
 * 双缺失恢复:在标准目录发布 rollout,让 app-server thread/resume 重新生成当前版本的
 * state 行。H1/H2 只发布到 Cindy staging sibling；历史稳定后才原子暴露唯一的
 * canonical 文件。返回是无 state 场景的不可逆 handoff，此后不再跨调用替换它。
 */
async function synthesizeRolloutForMissingThreadState(
  threadId: string,
  targetHome: string,
  beforeHandoff?: () => void,
): Promise<string | null> {
  const source = await readBestLocalCodexRecoverySource(threadId);
  if (!source) return null;
  const rolloutPath = recoveredRolloutPath(targetHome, threadId, source.recoveryCreatedAt);
  const staged = await publishFreshLocalSyntheticBeforeHandoff(rolloutPath, threadId);
  if (!staged) return null;
  const published = publishStagedSyntheticAtCanonical(
    threadId,
    targetHome,
    staged,
    rolloutPath,
    () => {
      beforeHandoff?.();
      assertNoUnexpectedCanonicalRollouts(threadId, targetHome, [rolloutPath]);
      return true;
    },
  );
  log.info('synthesized rollout for missing Codex thread state', {
    threadId,
    rolloutPath: published.path,
    messageCount: staged.messageCount,
    created: published.created,
  });
  return published.path;
}

function syntheticRowForLocalRecoverySource(source: LocalCodexRecoverySource): SqlRow {
  return {
    created_at_ms: source.recoveryCreatedAt,
    cwd: source.session.workingDir,
    originator: 'xdt-maker',
    source: 'cli',
    model: source.session.model,
  };
}

/**
 * 同一 Codex thread 可能被复制或 rewind 成多条 Cindy 会话。恢复时逐条读取可见历史，
 * 优先选择消息最完整的一条；其余字段只负责确定性打破平局，不合并可能分叉的历史。
 */
async function readBestLocalCodexRecoverySource(threadId: string): Promise<LocalCodexRecoverySource | null> {
  const sessions = await getDbClient().query<LocalCodexRecoverySession>(`
    SELECT
      id,
      working_dir AS workingDir,
      model,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM sessions
    WHERE agent_kind = 'codex' AND sdk_session_id = ? AND status <> 'deleted'
  `, [threadId]);

  let best: LocalCodexRecoverySource | null = null;
  for (const session of sessions) {
    const messages = await readXdtMessagesBySessionId(session.id);
    if (messages.length === 0) continue;
    const sessionCreatedAt = numberValue(session.createdAt);
    const firstPositiveMessageAt = messages.find((message) => message.createdAt > 0)?.createdAt ?? 0;
    const candidate: LocalCodexRecoverySource = {
      session,
      messages,
      recoveryCreatedAt: sessionCreatedAt > 0 ? sessionCreatedAt : firstPositiveMessageAt,
    };
    if (!best || isPreferredRecoverySource(candidate, best)) best = candidate;
  }
  return best;
}

function isPreferredRecoverySource(
  candidate: LocalCodexRecoverySource,
  current: LocalCodexRecoverySource,
): boolean {
  if (candidate.messages.length !== current.messages.length) {
    return candidate.messages.length > current.messages.length;
  }
  const candidateUpdatedAt = numberValue(candidate.session.updatedAt);
  const currentUpdatedAt = numberValue(current.session.updatedAt);
  if (candidateUpdatedAt !== currentUpdatedAt) return candidateUpdatedAt > currentUpdatedAt;

  const candidateCreatedAt = numberValue(candidate.session.createdAt);
  const currentCreatedAt = numberValue(current.session.createdAt);
  if (candidateCreatedAt !== currentCreatedAt) return candidateCreatedAt > currentCreatedAt;
  return candidate.session.id < current.session.id;
}

function recoveredRolloutPath(targetHome: string, threadId: string, createdAt: number): string {
  const created = new Date(Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0);
  const year = String(created.getUTCFullYear()).padStart(4, '0');
  const month = String(created.getUTCMonth() + 1).padStart(2, '0');
  const day = String(created.getUTCDate()).padStart(2, '0');
  const timestamp = created.toISOString().slice(0, 19).replaceAll(':', '-');
  return path.join(
    targetHome,
    'sessions',
    year,
    month,
    day,
    `rollout-${timestamp}-${threadId}.jsonl`,
  );
}

/** Stable siblings used when an unreadable private rollout must be preserved. */
function recoveredSiblingRolloutPath(
  unreadablePath: string,
  threadId: string,
  attempt: number,
  kind: 'adopted' | 'empty-recovery' | 'preserved-empty' | 'retired-empty' | 'state-less-stage' | 'synthetic',
): string {
  const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
  const originalName = path.basename(unreadablePath) || `rollout-${threadId}.jsonl`;
  if (kind === 'state-less-stage') {
    return path.join(
      path.dirname(unreadablePath),
      `.cindy-state-less-recovery${suffix}-${originalName}.stage`,
    );
  }
  return path.join(
    path.dirname(unreadablePath),
    `rollout-cindy-${kind}${suffix}-${originalName}`,
  );
}

type PublishedSyntheticRollout = PrivateRolloutPublication;

interface FreshSyntheticPublication extends PublishedSyntheticRollout {
  contents: string;
  messageCount: number;
}

/**
 * Publish a synthetic candidate while the old state pointer still owns the
 * session, then verify it against one final localDb snapshot before handoff.
 * If H1 advances to H2 during publication, preserve H1 and retry with H2.
 */
async function publishFreshSyntheticBeforeHandoff(
  preferredPath: string,
  threadId: string,
  row: SqlRow,
  opts: { skipPreferred: boolean },
): Promise<FreshSyntheticPublication | null> {
  for (let attempt = 0; attempt < MAX_RECOVERY_PATH_ATTEMPTS; attempt += 1) {
    const messages = await readXdtMessagesByThreadId(threadId);
    if (messages.length === 0) return null;
    const contents = buildSyntheticRollout(threadId, row, messages);
    const published = await publishSyntheticRollout(
      preferredPath,
      threadId,
      contents,
      opts,
    );
    if (!published) return null;

    const latestMessages = await readXdtMessagesByThreadId(threadId);
    if (latestMessages.length === 0) return null;
    const latestContents = buildSyntheticRollout(threadId, row, latestMessages);
    const latestSnapshot = readPrivateExactRolloutSnapshot(
      getDesktopCodexHome(),
      published.path,
      latestContents,
    );
    if (latestSnapshot) {
      return {
        ...published,
        snapshot: latestSnapshot,
        contents: latestContents,
        messageCount: latestMessages.length,
      };
    }
  }
  return null;
}

/** Atomically publish into the first usable deterministic private candidate. */
async function publishSyntheticRollout(
  preferredPath: string,
  threadId: string,
  contents: string,
  opts: { skipPreferred: boolean; siblingKind?: 'empty-recovery' | 'state-less-stage' },
): Promise<PublishedSyntheticRollout | null> {
  const targetHome = getDesktopCodexHome();
  if (!isPathInside(targetHome, preferredPath)) return null;

  for (let attempt = 0; attempt < MAX_RECOVERY_PATH_ATTEMPTS; attempt += 1) {
    const candidate = !opts.skipPreferred && attempt === 0
      ? preferredPath
      : recoveredSiblingRolloutPath(
        preferredPath,
        threadId,
        opts.skipPreferred ? attempt : attempt - 1,
        opts.skipPreferred ? (opts.siblingKind ?? 'empty-recovery') : 'synthetic',
      );
    // Resolve the boundary before every read or write. In particular, a
    // symlinked sessions ancestor must not redirect recovery into another HOME.
    if (!isPathInside(targetHome, candidate)) return null;
    const candidateState = readPrivateRolloutPathState(targetHome, candidate);
    if (candidateState === 'unsafe') return null;
    if (candidateState === 'non-empty-file') {
      // A prior crash may have published H1 before localDb advanced to H2. Reuse
      // only the exact current synthetic history; otherwise preserve H1 and move on.
      const snapshot = readPrivateExactRolloutSnapshot(targetHome, candidate, contents);
      if (snapshot) {
        return { path: candidate, created: false, snapshot };
      }
      continue;
    }

    if (candidateState === 'empty-file') {
      const empty = readEmptyRolloutSnapshot(candidate);
      if (!empty || !isStableEmptyRollout(empty)) return null;
      continue;
    }

    const created = await writeFileAtomicallyIfAbsent(targetHome, candidate, contents);
    const snapshot = readPrivateExactRolloutSnapshot(targetHome, candidate, contents);
    if (snapshot) return { path: candidate, created, snapshot };
    if (readPrivateRolloutPathState(targetHome, candidate) === 'unsafe') return null;
    const racedEmpty = readEmptyRolloutSnapshot(candidate);
    if (!racedEmpty || !isStableEmptyRollout(racedEmpty)) return null;
  }
  return null;
}

/** 同目录临时文件 + hard-link 发布:不覆盖既有 rollout,并避免并发 resume 读到半截文件。 */
async function writeFileAtomicallyIfAbsent(
  targetHome: string,
  targetPath: string,
  contents: string,
): Promise<boolean> {
  if (!isPathInside(targetHome, targetPath)) return false;
  if (fs.existsSync(targetPath)) return false;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.recovery-tmp`,
  );
  if (
    !isPathInside(targetHome, targetPath)
    || !isPathInside(targetHome, tempPath)
  ) return false;
  try {
    await fsp.writeFile(tempPath, contents, { encoding: 'utf-8', flag: 'wx' });
    if (
      readPrivateRolloutPathState(targetHome, tempPath) !== 'non-empty-file'
      || !isPathInside(targetHome, targetPath)
    ) return false;
    try {
      await fsp.link(tempPath, targetPath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    if (isPathInside(targetHome, tempPath)) {
      await fsp.unlink(tempPath).catch(() => undefined);
    }
  }
}

/** 读 state DB threads 表的原始整行(用于重建 session_meta)。 */
function readRawThreadRow(dbPath: string, threadId: string): SqlRow | null {
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDb(dbPath);
    if (!tableExists(db, 'threads')) return null;
    const row = db.prepare('SELECT * FROM threads WHERE id = ? LIMIT 1').get(threadId) as SqlRow | undefined;
    return row ?? null;
  } catch {
    return null;
  } finally {
    closeDbQuietly(db);
  }
}

/** 合成 rollout 用的可读消息条目。 */
interface SyntheticRolloutMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

/**
 * 从 xdt-maker localDb 读某 codex thread 对应会话的可读历史(仅 user/assistant 文本,
 * 跳过 thinking/tool —— 合成 rollout 不重建 codex 内部 reasoning/tool 项)。
 */
async function readXdtMessagesByThreadId(threadId: string): Promise<SyntheticRolloutMessage[]> {
  return (await readBestLocalCodexRecoverySource(threadId))?.messages ?? [];
}

async function readXdtMessagesBySessionId(sessionId: string): Promise<SyntheticRolloutMessage[]> {
  const rows = await getDbClient().query<{ role: string; content: string | null; createdAt: number }>(`
    SELECT role, content, created_at AS createdAt
    FROM messages
    WHERE session_id = ? AND rewind_at IS NULL AND role IN ('user', 'assistant')
    ORDER BY created_at ASC, id ASC
  `, [sessionId]);
  const out: SyntheticRolloutMessage[] = [];
  for (const r of rows) {
    const text = extractXdtMessageText(r.content).trim();
    if (!text) continue;
    out.push({ role: r.role === 'assistant' ? 'assistant' : 'user', text, createdAt: numberValue(r.createdAt) });
  }
  return out;
}

/**
 * 从 localDb message.content 抽纯文本。user 是 `{"text","images","files"}`,
 * assistant 多为纯文本串(也兼容被 JSON 包裹的情况)。
 */
function extractXdtMessageText(content: string | null): string {
  if (!content) return '';
  try {
    const o: unknown = JSON.parse(content);
    if (typeof o === 'string') return o;
    if (isRecord(o) && typeof o.text === 'string') return o.text;
  } catch {
    /* 非 JSON → 当纯文本 */
  }
  return content;
}

/**
 * 合成最小 rollout .jsonl 文本: 第一行 session_meta(从存活的 threads 行重建元数据),
 * 后续每条消息一行 response_item/message。格式对齐 codex 真实 rollout 的可解析子集
 * (见 readRolloutThreadRow / parseCodexRolloutMessageLine)。
 */
function buildSyntheticRollout(threadId: string, row: SqlRow, messages: SyntheticRolloutMessage[]): string {
  const createdMs = timestampMs(row.created_at_ms, row.created_at) ?? messages[0]?.createdAt ?? 0;
  const metaIso = isoFromMs(createdMs);
  const sessionMeta = {
    timestamp: metaIso,
    type: 'session_meta',
    payload: dropUndefined({
      session_id: threadId,
      id: threadId,
      timestamp: metaIso,
      cwd: stringValue(row.cwd) || os.homedir(),
      originator: stringValue(row.originator) || 'xdt-maker',
      // 当前 Codex SessionMeta 反序列化要求这三项存在;未知版本用 0.0.0 明确标记
      // 为恢复生成,provider / base instructions 则用合法的空 Option。
      cli_version: stringValue(row.cli_version) || '0.0.0',
      source: stringValue(row.source) || 'cli',
      model_provider: stringValue(row.model_provider) || null,
      base_instructions: null,
      model: stringValue(row.model) || undefined,
    }),
  };
  const lines = [JSON.stringify(sessionMeta)];
  for (const m of messages) {
    const isAsst = m.role === 'assistant';
    lines.push(JSON.stringify({
      timestamp: isoFromMs(m.createdAt),
      type: 'response_item',
      payload: {
        type: 'message',
        role: isAsst ? 'assistant' : 'user',
        content: [{ type: isAsst ? 'output_text' : 'input_text', text: m.text }],
      },
    }));
  }
  return `${lines.join('\n')}\n`;
}

function isoFromMs(ms: number): string {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Date(n).toISOString();
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

/**
 * 为外部 Codex thread 创建的本地会话按需导入可读消息。
 * 源 rollout 文件未变化时直接短路；文件变化后按行号 upsert，刷新已导入行并追加新行。
 */
export async function importExternalCodexMessagesForSession(sessionId: string): Promise<void> {
  const session = await getDbClient().queryOne<{
    id: string;
    agentKind: string;
    sdkSessionId: string | null;
    model: string;
  }>(`
    SELECT id, agent_kind AS agentKind, sdk_session_id AS sdkSessionId, model
    FROM sessions
    WHERE id = ?
    LIMIT 1
  `, [sessionId]);
  if (session?.agentKind !== 'codex') return;
  if (!session.sdkSessionId) return;
  if (!session.id.startsWith(LOCAL_SESSION_ID_PREFIX)) return;

  const importClientIdPrefix = `codex-import:${session.sdkSessionId}:`;
  const cacheScope = getCurrentDbClientUserId();
  const cachedImportFile = codexMessageImportFileCache.get(sessionId);
  if (cacheScope && cachedImportFile?.scope === cacheScope) {
    const cachedStat = await statImportFile(cachedImportFile.path);
    if (cachedStat && isCachedImportFileUnchanged(cachedImportFile, cachedStat)) return;
    codexMessageImportFileCache.delete(sessionId);
  } else if (cachedImportFile) {
    codexMessageImportFileCache.delete(sessionId);
  }

  const rolloutPath = resolveRolloutPath(session.sdkSessionId);
  const rolloutStat = rolloutPath ? await statImportFile(rolloutPath) : null;
  if (!rolloutPath || !rolloutStat) {
    log.debug('message import skipped: rollout path missing', {
      sessionId,
      threadId: session.sdkSessionId,
    });
    return;
  }

  const imported = await readCodexRolloutMessages(rolloutPath, session.id);
  if (imported.length === 0) {
    if (cacheScope) {
      codexMessageImportFileCache.set(sessionId, { scope: cacheScope, path: rolloutPath, ...rolloutStat });
    }
    return;
  }
  const { changed } = await getDbClient().tx('codex.importMessages', {
    sessionId,
    importClientIdPrefix,
    sdkSessionId: session.sdkSessionId,
    model: session.model,
    rows: imported.map((row) => ({
      lineNo: row.lineNo,
      role: row.role,
      text: row.text,
      content: row.content,
      createdAt: row.createdAt,
    })),
  });
  if (cacheScope) {
    codexMessageImportFileCache.set(sessionId, { scope: cacheScope, path: rolloutPath, ...rolloutStat });
  }
  if (changed === 0) return;
  log.info('imported external Codex messages', {
    sessionId,
    threadId: session.sdkSessionId,
    count: changed,
  });
  // session-git-pr-context:导入消息不经 createMessage,在这里补 PR 链接提取
  // (fire-and-forget;upsert 幂等,重复导入刷新无副作用)。
  void recordPrRefsForImportedMessages(
    sessionId,
    imported.map((row) => ({
      role: row.role,
      content: row.content ?? row.text,
      createdAt: row.createdAt,
    })),
  ).catch(() => undefined);
}

async function discoverExternalCodexHomes(): Promise<string[]> {
  const targetHome = getDesktopCodexHome();
  const candidates = externalCodexHomeCandidates(targetHome);

  const targetReal = await realpathOrNull(targetHome);
  const out: string[] = [];
  const seenReal = new Set<string>();
  for (const candidate of candidates) {
    const real = await realpathOrNull(candidate);
    if (!real) continue;
    if (targetReal && real === targetReal) continue;
    if (seenReal.has(real)) continue;
    if (!hasCodexSessionArtifactsSync(real)) continue;
    seenReal.add(real);
    out.push(real);
  }
  return out;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function statImportFile(file: string): Promise<ExternalImportFileStat | null> {
  const stat = await fsp.stat(file).catch(() => null);
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
}

function isCachedImportFileUnchanged(
  cached: ExternalImportFileCacheEntry,
  stat: ExternalImportFileStat,
): boolean {
  return cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
}

function findLatestStateDb(home: string): string | null {
  try {
    const entries = fs.readdirSync(home, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const m = entry.name.match(/^state_(\d+)\.sqlite$/);
        return m ? { n: Number(m[1]), file: path.join(home, entry.name) } : null;
      })
      .filter((x): x is { n: number; file: string } => !!x)
      .sort((a, b) => b.n - a.n);
    return matches[0]?.file ?? null;
  } catch {
    return null;
  }
}

function hasCodexSessionArtifactsSync(home: string): boolean {
  if (findLatestStateDb(home)) return true;
  if (fs.existsSync(path.join(home, 'session_index.jsonl'))) return true;
  if (fs.existsSync(path.join(home, 'sessions'))) return true;
  if (fs.existsSync(path.join(home, 'archived_sessions'))) return true;
  return false;
}

function getDesktopCodexHome(): string {
  try {
    const userData = app?.getPath?.('userData');
    if (userData) return path.join(userData, 'codex-home');
  } catch {
    /* fallback for non-Electron test runners */
  }

  // 兜底路径按现有区域目录映射取值(global=CindyGlobal,cn=Cindy，同机双装分库)。
  const dirName = brandUserDataDirName(CURRENT_CINDY_REGION);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', dirName, 'codex-home');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), dirName, 'codex-home');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), dirName, 'codex-home');
}

interface CodexThreadReadResult {
  threads: CodexThreadSummary[];
  rejectedThreadIds: string[];
}

function readThreads(
  home: string,
  dbPath: string,
  projectlessThreadIds: ReadonlySet<string>,
): CodexThreadReadResult | null {
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDb(dbPath);
    if (!tableExists(db, 'threads')) return null;
    const orderSql = buildThreadOrderSql(db);
    const rows = db.prepare(`
      SELECT *
      FROM threads
      ${orderSql}
    `).all() as SqlRow[];
    const threads: CodexThreadSummary[] = [];
    const rejectedThreadIds = new Set<string>();
    for (const row of rows) {
      if (!isTopLevelThreadRow(row)) {
        addRejectedThreadId(row, rejectedThreadIds);
        continue;
      }
      if (threads.length >= MAX_THREADS_PER_HOME) continue;
      const thread = normalizeThreadRow(home, dbPath, row, projectlessThreadIds);
      if (thread) threads.push(thread);
    }
    return { threads, rejectedThreadIds: [...rejectedThreadIds] };
  } catch (err) {
    log.warn('failed to read external Codex threads', {
      dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    closeDbQuietly(db);
  }
}

// 扫描路径专用:异步枚举 + 异步首行读取,避免在 main 事件循环里做同步 IO
// (设置页「会话导入」扫描直接跑在 main 进程,冷缓存下同步版会卡死窗口)。
// 导入路径的同步 helper(collectRolloutFiles / readFirstLineSync)保留给
// findExternalThreadById 等同步调用链。
async function readThreadsFromRollouts(
  home: string,
  projectlessThreadIds: ReadonlySet<string>,
  knownDbArchivedByThreadId?: ReadonlyMap<string, boolean>,
): Promise<CodexThreadReadResult> {
  const index = readSessionIndex(home);
  const files = await collectRolloutFilesAsync(home);
  const out: CodexThreadSummary[] = [];
  const rejectedThreadIds = new Set<string>();
  for (const { file, mtime } of files) {
    const fileThreadId = threadIdFromRolloutPath(file);
    const knownDbArchived = fileThreadId ? knownDbArchivedByThreadId?.get(fileThreadId) : undefined;
    if (knownDbArchived === true || (knownDbArchived === false && !isArchivedRolloutPath(file))) continue;

    const row = rolloutThreadRowFromFirstLine(file, await readFirstLineAsync(file), index, mtime);
    if (!row) continue;
    if (!isTopLevelThreadRow(row)) {
      addRejectedThreadId(row, rejectedThreadIds);
      continue;
    }
    if (out.length >= MAX_THREADS_PER_HOME) continue;
    const thread = normalizeThreadRow(home, null, row, projectlessThreadIds);
    if (thread) out.push(thread);
  }
  return { threads: out, rejectedThreadIds: [...rejectedThreadIds] };
}

function readSessionIndex(home: string): Map<string, CodexSessionIndexEntry> {
  const indexPath = path.join(home, 'session_index.jsonl');
  const out = new Map<string, CodexSessionIndexEntry>();
  if (!fs.existsSync(indexPath)) return out;
  try {
    const lines = fs.readFileSync(indexPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      const id = stringValue(obj.id);
      if (!isLikelyThreadId(id)) continue;
      out.set(id, {
        title: firstNonEmpty(stringValue(obj.thread_name), stringValue(obj.title), 'Codex Session'),
        updatedAt: timestampFromAny(obj.updated_at),
      });
    }
  } catch (err) {
    log.debug('failed to read Codex session_index.jsonl', {
      home,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

function readProjectlessThreadIds(home: string): Set<string> {
  // Codex Desktop does not model projectless threads as `cwd = null`.
  // Every thread still has an execution cwd, while the product-level
  // "not a project" decision lives in this global state list.
  const statePath = path.join(home, '.codex-global-state.json');
  try {
    if (!fs.existsSync(statePath)) return new Set();
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
    if (!isRecord(raw)) return new Set();
    const ids = raw['projectless-thread-ids'];
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((id): id is string => typeof id === 'string' && isLikelyThreadId(id)));
  } catch (err) {
    log.debug('failed to read Codex projectless thread ids', {
      home,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

async function appendSessionIndexEntry(home: string, thread: CodexThreadSummary): Promise<void> {
  const indexPath = path.join(home, 'session_index.jsonl');
  try {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.appendFile(
      indexPath,
      `${JSON.stringify({
        id: thread.threadId,
        thread_name: thread.title,
        updated_at: new Date(thread.updatedAt).toISOString(),
      })}\n`,
      'utf-8',
    );
  } catch (err) {
    log.debug('failed to append Codex session_index.jsonl', {
      home,
      threadId: thread.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isCindyRolloutArtifactFileName(name: string): boolean {
  return name.startsWith('rollout-cindy-')
    || name.startsWith('.cindy-state-less-recovery');
}

function collectRolloutFiles(home: string): string[] {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const files: Array<{ file: string; mtime: number }> = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && entry.name.includes('rollout-')
        && !isCindyRolloutArtifactFileName(entry.name)
      ) {
        try {
          files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* ignore unreadable rollout */
        }
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime).map((x) => x.file);
}

// collectRolloutFiles 的异步版(扫描路径用),额外带回 mtime 供 updated_at
// 兜底,免去每文件二次 stat。
async function collectRolloutFilesAsync(home: string): Promise<Array<{ file: string; mtime: number }>> {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const files: Array<{ file: string; mtime: number }> = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && entry.name.includes('rollout-')
        && !isCindyRolloutArtifactFileName(entry.name)
      ) {
        try {
          files.push({ file: full, mtime: (await fsp.stat(full)).mtimeMs });
        } catch {
          /* ignore unreadable rollout */
        }
      }
    }
  };
  for (const root of roots) await visit(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime);
}

function normalizeRolloutFile(
  home: string,
  file: string,
  index: Map<string, CodexSessionIndexEntry>,
  projectlessThreadIds: ReadonlySet<string> = readProjectlessThreadIds(home),
): CodexThreadSummary | null {
  const row = readRolloutThreadRow(file, index);
  if (!row || !isTopLevelThreadRow(row)) return null;
  return normalizeThreadRow(home, null, row, projectlessThreadIds);
}

function readRolloutThreadRow(
  file: string,
  index: Map<string, CodexSessionIndexEntry>,
): SqlRow | null {
  return rolloutThreadRowFromFirstLine(file, readFirstLineSync(file), index);
}

function rolloutThreadRowFromFirstLine(
  file: string,
  line: string | null,
  index: Map<string, CodexSessionIndexEntry>,
  fallbackMtime?: number,
): SqlRow | null {
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== 'session_meta' || !isRecord(obj.payload)) return null;
  const payload = obj.payload;
  const threadId = stringValue(payload.id) || threadIdFromRolloutPath(file);
  if (!isLikelyThreadId(threadId)) return null;
  return {
    id: threadId,
    rollout_path: file,
    created_at: stringValue(payload.timestamp) || stringValue(obj.timestamp),
    updated_at: index.get(threadId)?.updatedAt ?? fallbackMtime ?? safeStatMtime(file),
    source: stringValue(payload.source),
    originator: stringValue(payload.originator),
    thread_source: stringValue(payload.thread_source),
    cwd: stringValue(payload.cwd),
    title: index.get(threadId)?.title ?? '',
    model: stringValue(payload.model),
    reasoning_effort: stringValue(payload.reasoning_effort),
    approval_mode: stringValue(payload.approval_mode),
    archived: isArchivedRolloutPath(file) ? 1 : 0,
  };
}

function readFirstLineSync(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < 2 * 1024 * 1024) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const newline = buf.subarray(0, n).indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf-8');
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* no-op */
      }
    }
  }
}

// readFirstLineSync 的异步版(扫描路径用):同样最多读 2MB 找首行。
async function readFirstLineAsync(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    fh = await fsp.open(file, 'r');
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    let position = 0;
    while (total < 2 * 1024 * 1024) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const newline = buf.subarray(0, bytesRead).indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf-8');
      }
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

function threadIdFromRolloutPath(file: string): string {
  const m = path.basename(file).match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
  return m?.[1] ?? '';
}

/** Match the filename contract used by Codex's state-less rollout scanner. */
function isCanonicalCodexRolloutPath(file: string, threadId: string): boolean {
  return threadIdFromRolloutPath(file) === threadId
    && /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-fA-F-]{36}\.jsonl$/
      .test(path.basename(file));
}

interface InterruptedEmptyPreservation {
  preservedPath: string;
  canonicalPath: string;
}

function collectInterruptedEmptyPreservations(
  home: string,
  threadId: string,
): InterruptedEmptyPreservation[] {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const found: InterruptedEmptyPreservation[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      const match = entry.name.match(
        /^rollout-cindy-preserved-empty(?:-\d+)?-(rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-fA-F-]{36}\.jsonl)$/,
      );
      if (!match) continue;
      const canonicalPath = path.join(dir, match[1]);
      if (!isCanonicalCodexRolloutPath(canonicalPath, threadId)) continue;
      found.push({ preservedPath: candidate, canonicalPath });
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

function observePendingInterruptedEmptyPreservations(
  targetHome: string,
  threadId: string,
): (() => void) | undefined {
  const pending: Array<{ path: string; snapshot: EmptyRolloutSnapshot }> = [];
  for (const preservation of collectInterruptedEmptyPreservations(targetHome, threadId)) {
    if (readPrivateRolloutPathState(targetHome, preservation.canonicalPath) !== 'missing') {
      continue;
    }
    const snapshot = readRegularEmptyRolloutSnapshot(preservation.preservedPath);
    if (!snapshot) {
      throw resumePreparationBlocked(
        threadId,
        'an interrupted preserved rollout changed before recovery planning',
      );
    }
    pending.push({ path: preservation.preservedPath, snapshot });
  }
  if (pending.length === 0) return undefined;
  return () => {
    for (const candidate of pending) {
      if (!regularEmptyRolloutStillMatches(candidate.path, candidate.snapshot)) {
        throw resumePreparationBlocked(
          threadId,
          'an interrupted preserved rollout changed before canonical handoff',
        );
      }
    }
  };
}

function collectInterruptedCanonicalRetirements(
  home: string,
  threadId: string,
): InterruptedEmptyPreservation[] {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const found: InterruptedEmptyPreservation[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      const match = entry.name.match(
        /^rollout-cindy-retired-empty(?:-\d+)?-(rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-fA-F-]{36}\.jsonl)$/,
      );
      if (!match) continue;
      const canonicalPath = path.join(dir, match[1]);
      if (!isCanonicalCodexRolloutPath(canonicalPath, threadId)) continue;
      found.push({ preservedPath: candidate, canonicalPath });
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

function reconcileInterruptedCanonicalRetirements(
  targetHome: string,
  threadId: string,
  canonicalSet: { empties: CanonicalEmptyObservation[]; nonEmpty: string[] },
): { empties: CanonicalEmptyObservation[]; nonEmpty: string[] } {
  if (canonicalSet.nonEmpty.length <= 1) return canonicalSet;
  const retirements = collectInterruptedCanonicalRetirements(targetHome, threadId);
  const checkpointByCanonical = new Map<string, string>();
  for (const canonicalPath of canonicalSet.nonEmpty) {
    const checkpoint = retirements.find((candidate) => (
      samePath(candidate.canonicalPath, canonicalPath)
      && readPrivateRolloutPathState(targetHome, candidate.preservedPath) === 'non-empty-file'
      && sameRegularFileIdentity(candidate.preservedPath, canonicalPath)
    ));
    if (checkpoint) checkpointByCanonical.set(canonicalPath, checkpoint.preservedPath);
  }
  const establishedWinners = canonicalSet.nonEmpty.filter(
    (canonicalPath) => !checkpointByCanonical.has(canonicalPath),
  );
  if (establishedWinners.length !== 1) return canonicalSet;
  const establishedWinner = establishedWinners[0];

  for (const [canonicalPath, checkpointPath] of checkpointByCanonical) {
    if (
      readPrivateRolloutPathState(targetHome, canonicalPath) !== 'non-empty-file'
      || readPrivateRolloutPathState(targetHome, checkpointPath) !== 'non-empty-file'
      || !sameRegularFileIdentity(canonicalPath, checkpointPath)
    ) {
      throw resumePreparationBlocked(threadId, 'an interrupted canonical retirement changed');
    }
    try {
      fs.unlinkSync(canonicalPath);
    } catch (error) {
      throw resumePreparationBlocked(
        threadId,
        `an interrupted canonical could not be retired (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }
  }

  const converged = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  if (
    converged.nonEmpty.length !== 1
    || !samePath(converged.nonEmpty[0], establishedWinner)
  ) {
    throw resumePreparationBlocked(threadId, 'interrupted canonical retirement did not converge');
  }
  log.info('completed interrupted canonical rollout retirement', {
    threadId,
    retainedRolloutPath: establishedWinner,
    retiredRolloutPaths: [...checkpointByCanonical.keys()],
  });
  return converged;
}

/**
 * A process exit can happen after the empty canonical name is moved aside but
 * before a synthetic handoff. If the retained native writer then appends to
 * that preserved inode, restore it as the authoritative canonical history.
 */
function restoreInterruptedNativeCanonicalWithoutState(
  targetHome: string,
  threadId: string,
  opts: { requireAllNativePrecursorsConverged?: boolean } = {},
): string | null {
  let canonicalSet = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  canonicalSet = reconcileInterruptedCanonicalRetirements(targetHome, threadId, canonicalSet);
  if (canonicalSet.empties.some((candidate) => !isStableEmptyRollout(candidate.snapshot))) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }
  if (canonicalSet.nonEmpty.length > 1) {
    throw resumePreparationBlocked(threadId, 'multiple private canonical rollouts conflict');
  }
  if (canonicalSet.nonEmpty.length === 1) {
    const existingWinner = canonicalSet.nonEmpty[0];
    if (opts.requireAllNativePrecursorsConverged) {
      for (const preservation of collectInterruptedEmptyPreservations(targetHome, threadId)) {
        if (readPrivateRolloutPathState(targetHome, preservation.preservedPath) !== 'non-empty-file') {
          continue;
        }
        if (
          !samePath(preservation.canonicalPath, existingWinner)
          || !sameRegularFileIdentity(preservation.preservedPath, existingWinner)
        ) {
          throw resumePreparationBlocked(
            threadId,
            'multiple native private rollouts conflict before state handoff',
          );
        }
      }
    }
    preserveStableCanonicalEmptiesBesideWinner(
      threadId,
      targetHome,
      canonicalSet.empties,
    );
    const converged = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
    if (
      converged.empties.length > 0
      || converged.nonEmpty.length !== 1
      || !samePath(converged.nonEmpty[0], existingWinner)
    ) {
      throw resumePreparationBlocked(threadId, 'the private canonical winner changed during handoff');
    }
    return existingWinner;
  }

  let nativeWinner: InterruptedEmptyPreservation | null = null;
  for (const preservation of collectInterruptedEmptyPreservations(targetHome, threadId)) {
    const canonicalState = readPrivateRolloutPathState(targetHome, preservation.canonicalPath);
    if (canonicalState === 'non-empty-file') continue;
    const preservedState = readPrivateRolloutPathState(targetHome, preservation.preservedPath);
    if (preservedState === 'empty-file') continue;
    if (preservedState !== 'non-empty-file') {
      throw resumePreparationBlocked(threadId, 'an interrupted preserved rollout became unsafe');
    }
    if (canonicalState !== 'missing') {
      throw resumePreparationBlocked(
        threadId,
        'an interrupted native rollout conflicts with the canonical path',
      );
    }
    if (nativeWinner) {
      if (
        !samePath(nativeWinner.canonicalPath, preservation.canonicalPath)
        || !sameRegularFileIdentity(nativeWinner.preservedPath, preservation.preservedPath)
      ) {
        throw resumePreparationBlocked(threadId, 'multiple interrupted native rollouts conflict');
      }
      continue;
    }
    nativeWinner = preservation;
  }
  if (!nativeWinner) return null;
  preserveStableCanonicalEmptiesBesideWinner(
    threadId,
    targetHome,
    canonicalSet.empties,
  );
  const restored = restorePreservedCanonical(
    threadId,
    targetHome,
    nativeWinner.preservedPath,
    nativeWinner.canonicalPath,
  );
  const restoredSet = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  if (
    restoredSet.empties.length > 0
    || restoredSet.nonEmpty.length !== 1
    || !samePath(restoredSet.nonEmpty[0], restored)
  ) {
    throw resumePreparationBlocked(threadId, 'interrupted native recovery did not converge');
  }
  log.info('restored native Codex rollout after interrupted state-less recovery', {
    threadId,
    preservedRolloutPath: nativeWinner.preservedPath,
    restoredRolloutPath: restored,
  });
  return restored;
}

interface CanonicalEmptyObservation {
  path: string;
  snapshot: EmptyRolloutSnapshot;
}

function observeCurrentHomeCanonicalRollouts(
  targetHome: string,
  threadId: string,
): { empties: CanonicalEmptyObservation[]; nonEmpty: string[] } {
  const empties: CanonicalEmptyObservation[] = [];
  const nonEmpty: string[] = [];
  const candidates = collectNamedRolloutPaths(targetHome, threadId)
    .filter((candidate) => isCanonicalCodexRolloutPath(candidate, threadId))
    .sort();
  for (const candidate of candidates) {
    const state = readPrivateRolloutPathState(targetHome, candidate);
    if (state === 'non-empty-file') {
      nonEmpty.push(candidate);
      continue;
    }
    if (state === 'empty-file') {
      const snapshot = readEmptyRolloutSnapshot(candidate);
      if (!snapshot) {
        throw resumePreparationBlocked(threadId, 'a private canonical rollout changed during discovery');
      }
      empties.push({ path: candidate, snapshot });
      continue;
    }
    throw resumePreparationBlocked(threadId, 'a private canonical rollout crossed its safe boundary');
  }
  return { empties, nonEmpty };
}

function createCanonicalNamespaceGuard(
  threadId: string,
  targetHome: string,
  retainedEmpties: readonly CanonicalEmptyObservation[],
): () => void {
  return () => {
    const current = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
    const matchesPlan = current.nonEmpty.length === 0
      && current.empties.length === retainedEmpties.length
      && retainedEmpties.every((expected) => current.empties.some((candidate) => (
        samePath(candidate.path, expected.path)
        && emptyRolloutStillMatches(candidate.path, expected.snapshot)
      )));
    if (!matchesPlan) {
      throw resumePreparationBlocked(
        threadId,
        'the private canonical rollout namespace changed during recovery handoff',
      );
    }
  };
}

/** Fail closed if a same-thread canonical name appeared after recovery planning. */
function assertNoUnexpectedCanonicalRollouts(
  threadId: string,
  targetHome: string,
  allowedPaths: readonly string[],
): void {
  const current = observeCurrentHomeCanonicalRollouts(targetHome, threadId);
  const unexpected = [
    ...current.empties.map((candidate) => candidate.path),
    ...current.nonEmpty,
  ].find((candidate) => !allowedPaths.some((allowed) => samePath(candidate, allowed)));
  if (unexpected) {
    throw resumePreparationBlocked(
      threadId,
      'the private canonical rollout namespace changed during recovery handoff',
    );
  }
}

function preserveStableCanonicalEmptiesBesideWinner(
  threadId: string,
  targetHome: string,
  empties: readonly CanonicalEmptyObservation[],
): void {
  for (const empty of empties) {
    const preservation = preserveStableEmptyCanonical(
      threadId,
      targetHome,
      empty.path,
      empty.snapshot,
      { preserveLateNativeAsArtifact: true },
    );
    if (preservation.kind === 'native-winner') {
      throw resumePreparationBlocked(
        threadId,
        'a private empty canonical materialized beside another winner',
      );
    }
  }
}

function preserveAdditionalCanonicalEmptiesBeforeHandoff(
  threadId: string,
  targetHome: string,
  empties: readonly CanonicalEmptyObservation[],
): (() => void) | undefined {
  // This batch can come from a second scan after the initial recovery preflight.
  // Validate every candidate before moving any canonical name so a newly opened
  // Codex writer keeps its discoverable path and a later recent candidate cannot
  // leave earlier stable candidates partially preserved.
  if (empties.some((candidate) => !isStableEmptyRollout(candidate.snapshot))) {
    throw resumePreparationBlocked(threadId, 'private rollout may still be materializing');
  }
  const preserved: Array<{ path: string; snapshot: EmptyRolloutSnapshot }> = [];
  for (const empty of empties) {
    const preservation = preserveStableEmptyCanonical(
      threadId,
      targetHome,
      empty.path,
      empty.snapshot,
    );
    if (preservation.kind === 'native-winner') {
      throw resumePreparationBlocked(
        threadId,
        'an additional private empty canonical materialized before handoff',
      );
    }
    const snapshot = readRegularEmptyRolloutSnapshot(preservation.path);
    if (!snapshot) {
      throw resumePreparationBlocked(
        threadId,
        'an additional private empty canonical changed before handoff',
      );
    }
    preserved.push({ path: preservation.path, snapshot });
  }
  if (preserved.length === 0) return undefined;
  return () => {
    for (const candidate of preserved) {
      if (!regularEmptyRolloutStillMatches(candidate.path, candidate.snapshot)) {
        throw resumePreparationBlocked(
          threadId,
          'an additional private rollout changed before canonical handoff',
        );
      }
    }
  };
}

function combineHandoffGuards(
  ...guards: Array<(() => void) | undefined>
): (() => void) | undefined {
  const active = guards.filter((guard): guard is () => void => !!guard);
  if (active.length === 0) return undefined;
  return () => {
    for (const guard of active) guard();
  };
}

function isArchivedRolloutPath(file: string): boolean {
  return file.includes(`${path.sep}archived_sessions${path.sep}`);
}

function safeStatMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

function findExternalThreadById(threadId: string): CodexThreadSummary | null {
  const homes = discoverExternalCodexHomesSync();
  let best: CodexThreadSummary | null = null;
  for (const home of homes) {
    const found = findThreadByIdInHome(home, threadId);
    if (found && (!best || best.updatedAt < found.updatedAt)) best = found;
  }
  return best;
}

interface ExternalEmptyObservation {
  path: string;
  snapshot: EmptyRolloutSnapshot;
}

/**
 * Enumerate same-thread rollout names without following file symlinks. This is
 * intentionally separate from the normal parser scan: a zero-byte rollout has
 * no session_meta yet, while a replaced symlink/non-file must fail closed.
 */
function collectNamedRolloutPaths(home: string, threadId: string): string[] {
  const roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
      } else if (
        entry.name.endsWith('.jsonl')
        && entry.name.includes('rollout-')
        && !isCindyRolloutArtifactFileName(entry.name)
        && threadIdFromRolloutPath(candidate) === threadId
      ) {
        found.push(candidate);
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

/** Capture raw external empties that cannot be normalized without session_meta/state. */
function observeUnindexedExternalEmptyRolloutsById(
  threadId: string,
): ExternalEmptyObservation[] {
  const observations: ExternalEmptyObservation[] = [];
  for (const home of discoverExternalCodexHomesSync()) {
    for (const candidate of collectNamedRolloutPaths(home, threadId)) {
      const snapshot = readRegularEmptyRolloutSnapshot(candidate);
      if (!snapshot) {
        throw resumePreparationBlocked(
          threadId,
          'an external rollout changed during recovery discovery',
        );
      }
      observations.push({ path: candidate, snapshot });
    }
  }
  return observations;
}

function assertExternalEmptyObservationsUnchanged(
  threadId: string,
  observations: readonly ExternalEmptyObservation[],
): void {
  for (const observation of observations) {
    if (!regularEmptyRolloutStillMatches(observation.path, observation.snapshot)) {
      throw resumePreparationBlocked(
        threadId,
        'an external rollout changed before private recovery handoff',
      );
    }
  }
}

function findThreadByIdInHome(home: string, threadId: string): CodexThreadSummary | null {
  const dbPath = findLatestStateDb(home);
  const projectlessThreadIds = readProjectlessThreadIds(home);
  if (!dbPath) return findExternalThreadByIdFromRollouts(home, threadId);
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDb(dbPath);
    if (!tableExists(db, 'threads')) return findExternalThreadByIdFromRollouts(home, threadId);
    const row = db.prepare('SELECT * FROM threads WHERE id = ? LIMIT 1').get(threadId) as SqlRow | undefined;
    if (!row || !isTopLevelThreadRow(row)) return findExternalThreadByIdFromRollouts(home, threadId);
    return normalizeThreadRow(home, dbPath, row, projectlessThreadIds) ?? findExternalThreadByIdFromRollouts(home, threadId);
  } catch {
    return findExternalThreadByIdFromRollouts(home, threadId);
  } finally {
    closeDbQuietly(db);
  }
}

function findExternalThreadByIdFromRollouts(home: string, threadId: string): CodexThreadSummary | null {
  const index = readSessionIndex(home);
  const projectlessThreadIds = readProjectlessThreadIds(home);
  const file = collectRolloutFiles(home).find((candidate) => threadIdFromRolloutPath(candidate) === threadId);
  if (!file) return null;
  return normalizeRolloutFile(home, file, index, projectlessThreadIds);
}

function discoverExternalCodexHomesSync(): string[] {
  const targetHome = getDesktopCodexHome();
  const candidates = externalCodexHomeCandidates(targetHome);

  const targetReal = safeRealpathSync(targetHome);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const real = safeRealpathSync(candidate);
    if (!real || real === targetReal || seen.has(real) || !hasCodexSessionArtifactsSync(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** 统一生成异步扫描与 resume 热路径共享的外部 Codex HOME 候选。 */
function externalCodexHomeCandidates(targetHome: string): Set<string> {
  const candidates = new Set<string>();
  const add = (p: string | undefined) => {
    if (p) candidates.add(path.resolve(p));
  };

  add(process.env.CODEX_HOME);
  add(path.join(os.homedir(), '.codex'));

  // 身份翻转只迁了主库,历史 sessions.sdk_session_id 仍可能指向旧品牌 HOME。
  // 从统一品牌身份表取 legacy 名称,未来再次改名只需扩表,此处无需再追补字面量。
  for (const legacyHome of legacyBrandedCodexHomes(targetHome)) add(legacyHome);

  if (process.platform === 'darwin') {
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    add(path.join(appSupport, 'Codex', 'codex-home'));
    add(path.join(appSupport, 'Codex'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    add(appData ? path.join(appData, 'Codex', 'codex-home') : undefined);
    add(appData ? path.join(appData, 'Codex') : undefined);
  } else {
    add(path.join(os.homedir(), '.config', 'codex'));
  }
  return candidates;
}

function safeRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isTopLevelThreadRow(row: SqlRow): boolean {
  if (!stringValue(row.id)) return false;
  return threadRejectionReason(row) === null;
}

function threadRejectionReason(row: SqlRow): 'thread-source' | 'internal-source' | null {
  const threadSource = stringValue(row.thread_source).trim();
  if (threadSource && threadSource !== 'user') return 'thread-source';
  if (isInternalCodexSource(row)) return 'internal-source';
  return null;
}

function addRejectedThreadId(row: SqlRow, out: Set<string>): void {
  const id = stringValue(row.id);
  if (isLikelyThreadId(id) && threadRejectionReason(row) !== null) out.add(id);
}

function isInternalCodexSource(row: SqlRow): boolean {
  const source = stringValue(row.source).trim();
  const originator = stringValue(row.originator).trim();
  return isInternalSourceValue(source) || isInternalSourceValue(originator);
}

function isInternalSourceValue(value: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'exec' || normalized === 'codex_exec' || normalized === 'subagent') return true;
  if (!normalized.startsWith('{') && !normalized.startsWith('[')) return false;
  return jsonContainsInternalSource(value);
}

function jsonContainsInternalSource(value: string): boolean {
  try {
    return unknownContainsInternalSource(JSON.parse(value));
  } catch {
    return value.includes('"subagent"') || value.includes('"codex_exec"') || value.includes('"exec"');
  }
}

function unknownContainsInternalSource(value: unknown): boolean {
  if (typeof value === 'string') return isInternalSourceValue(value);
  if (Array.isArray(value)) return value.some(unknownContainsInternalSource);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    isInternalSourceValue(key) || unknownContainsInternalSource(nested)
  ));
}

function normalizeThreadRow(
  home: string,
  dbPath: string | null,
  row: SqlRow,
  projectlessThreadIds: ReadonlySet<string>,
): CodexThreadSummary | null {
  const threadId = stringValue(row.id);
  if (!isLikelyThreadId(threadId)) return null;
  const archived = numberValue(row.archived) === 1;
  const baseUpdatedAt = timestampMs(row.updated_at_ms, row.updated_at) ?? Date.now();
  const archivedAt = timestampFromAny(row.archived_at);
  const updatedAt = archived && archivedAt ? Math.max(baseUpdatedAt, archivedAt) : baseUpdatedAt;
  const createdAt = timestampMs(row.created_at_ms, row.created_at) ?? updatedAt;
  const cwd = stringValue(row.cwd) || os.homedir();
  const rolloutPath = stringValue(row.rollout_path);
  const title = firstNonEmpty(
    stringValue(row.title),
    stringValue(row.preview),
    stringValue(row.first_user_message).split(/\r?\n/)[0],
    'Codex Session',
  );
  return {
    threadId,
    sourceHome: home,
    sourceDbPath: dbPath,
    rolloutPath,
    title,
    cwd,
    workspaceKind: projectlessThreadIds.has(threadId) ? 'dialogue' : 'project',
    model: stringValue(row.model) || 'gpt-5.4-mini',
    effort: normalizeEffort(stringValue(row.reasoning_effort)),
    permissionMode: normalizeApprovalMode(stringValue(row.approval_mode)),
    tokensUsed: numberValue(row.tokens_used),
    createdAt,
    updatedAt,
    archived,
  };
}

async function upsertLocalSession(thread: CodexThreadSummary): Promise<'inserted' | 'updated' | 'skipped'> {
  const existingBySdkRows = await getDbClient().query<{ id: string; updatedAt: number; status: string }>(`
    SELECT id, updated_at AS updatedAt, status
    FROM sessions
    WHERE agent_kind = 'codex' AND sdk_session_id = ?
  `, [thread.threadId]);
  // skip 只认「存活」的非本地行(与 claude 侧 upsertLocalSession 同一口径,
  // 理由见彼处注释):软删残留不该挡 CLI 导入。
  if (existingBySdkRows.some((row) => row.status !== 'deleted' && !row.id.startsWith(LOCAL_SESSION_ID_PREFIX))) {
    return 'skipped';
  }
  const existingBySdk = existingBySdkRows.find((row) => row.id.startsWith(LOCAL_SESSION_ID_PREFIX));

  const localId = existingBySdk?.id ?? `${LOCAL_SESSION_ID_PREFIX}${thread.threadId}`;
  const existingById = await getDbClient().queryOne<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ? LIMIT 1',
    [localId],
  );
  const existed = !!existingBySdk || !!existingById;
  const result = await getDbClient().exec(`
    INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status, sdk_session_id,
      total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode,
      cleared_at, pinned_at, user_send_at, agent_kind, parent_session_id,
      forked_at_message_id, worktree_path, source, feishu_open_id, feishu_bot_app_id,
      used_project_context, extra_dirs, workspace_kind, created_at, updated_at
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, 0, 0, 0, 0,
      NULL, NULL, ?, 'codex', NULL,
      NULL, NULL, 'desktop', NULL, NULL,
      0, '[]', ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.title ELSE sessions.title END,
      working_dir = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.working_dir ELSE sessions.working_dir END,
      -- Classification follows Codex global state, not local edit recency.
      -- This lets a re-import fix rows previously misclassified as projects
      -- while preserving newer local title/metadata via the CASE clauses.
      workspace_kind = excluded.workspace_kind,
      model = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.model ELSE sessions.model END,
      effort = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.effort ELSE sessions.effort END,
      permission_mode = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.permission_mode ELSE sessions.permission_mode END,
      status = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.status ELSE sessions.status END,
      sdk_session_id = excluded.sdk_session_id,
      total_token_usage = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.total_token_usage ELSE sessions.total_token_usage END,
      user_send_at = COALESCE(sessions.user_send_at, excluded.user_send_at),
      updated_at = MAX(sessions.updated_at, excluded.updated_at)
  `, [
    localId,
    thread.title,
    // 存储级归一(#537):Codex rollout 里的 cwd 在 Windows 上是反斜杠,直接入库会与
    // sessions:create 归一后的正斜杠写法并存,同一物理目录裂成两种 workingDir。
    normalizeWorkingDirForStorage(thread.cwd) ?? thread.cwd,
    thread.model,
    thread.effort,
    thread.permissionMode,
    thread.archived ? 'archived' : 'active',
    thread.threadId,
    thread.tokensUsed,
    thread.updatedAt,
    thread.workspaceKind,
    thread.createdAt,
    thread.updatedAt,
  ]);
  if (!existed && result.changes > 0) return 'inserted';
  if (existed && result.changes > 0) return 'updated';
  return 'skipped';
}

interface CopyThreadStateOptions {
  replaceExisting?: boolean;
  rolloutPathOverride?: string;
  validateBeforeCopy?: () => boolean;
  validateAfterCopy?: () => boolean;
}

function copyThreadStateToTarget(
  thread: CodexThreadSummary,
  targetDbPath: string,
  opts: CopyThreadStateOptions = {},
): boolean {
  if (!thread.sourceDbPath || samePath(thread.sourceDbPath, targetDbPath)) return false;
  let source: Database.Database | null = null;
  let target: Database.Database | null = null;
  try {
    source = openReadonlyDb(thread.sourceDbPath);
    target = createBetterSqliteDatabase(targetDbPath);
    target.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (!tableExists(source, 'threads') || !tableExists(target, 'threads')) return false;
    const sourceDb = source;
    const targetDb = target;
    const copy = targetDb.transaction(() => {
      const existing = targetDb
        .prepare('SELECT id FROM threads WHERE id = ? LIMIT 1')
        .get(thread.threadId);
      if (existing && !opts.replaceExisting) return false;
      if (opts.validateBeforeCopy && !opts.validateBeforeCopy()) {
        throw new Error('rollout handoff validation failed before state copy');
      }
      if (opts.replaceExisting) {
        upsertRowsByColumn(sourceDb, targetDb, 'threads', 'id', thread.threadId, {
          ...(opts.rolloutPathOverride ? { rollout_path: opts.rolloutPathOverride } : {}),
        });
        replaceRowsByColumn(sourceDb, targetDb, 'thread_dynamic_tools', 'thread_id', thread.threadId);
        replaceRowsByColumn(sourceDb, targetDb, 'thread_spawn_edges', 'parent_thread_id', thread.threadId);
      } else {
        copyRowsByColumn(sourceDb, targetDb, 'threads', 'id', thread.threadId, {
          ...(opts.rolloutPathOverride ? { rollout_path: opts.rolloutPathOverride } : {}),
        });
        copyRowsByColumn(sourceDb, targetDb, 'thread_dynamic_tools', 'thread_id', thread.threadId);
        copyRowsByColumn(sourceDb, targetDb, 'thread_spawn_edges', 'parent_thread_id', thread.threadId);
      }
      if (opts.validateAfterCopy && !opts.validateAfterCopy()) {
        throw new Error('rollout handoff validation failed after state copy');
      }
      return true;
    });
    return copy.immediate();
  } catch (err) {
    if (err instanceof CodexResumePreparationBlockedError) throw err;
    log.warn('failed to copy Codex thread state', {
      threadId: thread.threadId,
      targetDbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    closeDbQuietly(source);
    closeDbQuietly(target);
  }
}

function copyRowsByColumn(
  source: Database.Database,
  target: Database.Database,
  table: string,
  whereColumn: string,
  whereValue: string,
  overrides: Record<string, SqlScalar> = {},
): void {
  if (!tableExists(source, table) || !tableExists(target, table)) return;
  const commonColumns = intersectColumns(getTableColumns(source, table), getTableColumns(target, table));
  if (commonColumns.length === 0 || !commonColumns.includes(whereColumn)) return;
  const colsSql = commonColumns.map(quoteIdent).join(', ');
  const rows = source.prepare(`SELECT ${colsSql} FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereColumn)} = ?`).all(whereValue) as SqlRow[];
  if (rows.length === 0) return;
  const placeholders = commonColumns.map((c) => `@${c}`).join(', ');
  const insert = target.prepare(`INSERT OR IGNORE INTO ${quoteIdent(table)} (${colsSql}) VALUES (${placeholders})`);
  for (const row of rows) insert.run({ ...row, ...overrides });
}

function upsertRowsByColumn(
  source: Database.Database,
  target: Database.Database,
  table: string,
  whereColumn: string,
  whereValue: string,
  overrides: Record<string, SqlScalar> = {},
): void {
  if (!tableExists(source, table) || !tableExists(target, table)) return;
  const commonColumns = intersectColumns(getTableColumns(source, table), getTableColumns(target, table));
  if (commonColumns.length === 0 || !commonColumns.includes(whereColumn)) return;
  const colsSql = commonColumns.map(quoteIdent).join(', ');
  const rows = source.prepare(`SELECT ${colsSql} FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereColumn)} = ?`).all(whereValue) as SqlRow[];
  if (rows.length === 0) return;
  const placeholders = commonColumns.map((c) => `@${c}`).join(', ');
  const assignments = commonColumns
    .filter((c) => c !== whereColumn)
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ');
  const insert = target.prepare(`
    INSERT INTO ${quoteIdent(table)} (${colsSql})
    VALUES (${placeholders})
    ON CONFLICT(${quoteIdent(whereColumn)}) DO UPDATE SET ${assignments}
  `);
  for (const row of rows) insert.run({ ...row, ...overrides });
}

function replaceRowsByColumn(
  source: Database.Database,
  target: Database.Database,
  table: string,
  whereColumn: string,
  whereValue: string,
): void {
  if (!tableExists(source, table) || !tableExists(target, table)) return;
  const commonColumns = intersectColumns(getTableColumns(source, table), getTableColumns(target, table));
  if (commonColumns.length === 0 || !commonColumns.includes(whereColumn)) return;
  const colsSql = commonColumns.map(quoteIdent).join(', ');
  const rows = source.prepare(`SELECT ${colsSql} FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereColumn)} = ?`).all(whereValue) as SqlRow[];
  target.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(whereColumn)} = ?`).run(whereValue);
  if (rows.length === 0) return;
  const placeholders = commonColumns.map((c) => `@${c}`).join(', ');
  const insert = target.prepare(`INSERT OR IGNORE INTO ${quoteIdent(table)} (${colsSql}) VALUES (${placeholders})`);
  for (const row of rows) insert.run(row);
}

function readThreadRolloutPath(dbPath: string, threadId: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDb(dbPath);
    if (!tableExists(db, 'threads')) return null;
    const row = db.prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1')
      .get(threadId) as { rolloutPath?: string } | undefined;
    return row?.rolloutPath ?? null;
  } catch {
    return null;
  } finally {
    closeDbQuietly(db);
  }
}

function resolveRolloutPath(threadId: string): string | null {
  const targetDb = findLatestStateDb(getDesktopCodexHome());
  if (targetDb) {
    const targetPath = readThreadRolloutPath(targetDb, threadId);
    if (targetPath) return targetPath;
  }
  return findExternalThreadById(threadId)?.rolloutPath ?? null;
}

interface ImportedCodexMessage {
  lineNo: number;
  role: 'user' | 'assistant';
  text: string;
  content: unknown;
  createdAt: number;
}

async function readCodexRolloutMessages(
  rolloutPath: string,
  sessionId: string,
): Promise<ImportedCodexMessage[]> {
  const input = createReadStream(rolloutPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const out: ImportedCodexMessage[] = [];
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const msg = await parseCodexRolloutMessageLineForImport(line, lineNo, sessionId);
    if (msg) out.push(msg);
  }
  return out;
}

export function parseCodexRolloutMessageLine(
  line: string,
  lineNo: number,
): ImportedCodexMessage | null {
  if (!line.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj.type !== 'response_item' || !isRecord(obj.payload)) return null;
  const payload = obj.payload;
  if (payload.type !== 'message') return null;
  const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
  if (!role) return null;
  const rawText = extractContentText(payload.content);
  // assistant 正文与流式 completed 同口径:剥截断残尾 + citation 归一化——rollout
  // 存的是含 `:codex-file-citation{...}` 内部语法的原文(生成被打断时还带未闭合
  // 残尾),直接入库会把它漏给用户(#785)。
  const text = (
    role === 'user'
      ? stripCompleteIdeOpenedFileBlocks(rawText)
      : finalizeCodexCitationText(rawText)
  ).trim();
  if (!text) return null;
  return {
    lineNo,
    role,
    text,
    content: text,
    createdAt: timestampFromIso(stringValue(obj.timestamp)) + lineNo,
  };
}

async function parseCodexRolloutMessageLineForImport(
  line: string,
  lineNo: number,
  sessionId: string,
): Promise<ImportedCodexMessage | null> {
  if (!line.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj.type !== 'response_item' || !isRecord(obj.payload)) return null;
  const payload = obj.payload;
  if (payload.type !== 'message') return null;
  const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
  if (!role) return null;

  const rawText = extractContentText(payload.content);
  // assistant 正文与流式 completed 同口径:剥截断残尾 + citation 归一化——rollout
  // 存的是含 `:codex-file-citation{...}` 内部语法的原文(生成被打断时还带未闭合
  // 残尾),直接入库会把它漏给用户(#785)。
  const text = (
    role === 'user'
      ? stripCompleteIdeOpenedFileBlocks(rawText)
      : finalizeCodexCitationText(rawText)
  ).trim();
  const images = role === 'user'
    ? await extractCodexUserImages(payload.content, sessionId, lineNo)
    : [];
  if (!text && images.length === 0) return null;
  return {
    lineNo,
    role,
    text,
    content: role === 'user' ? importedUserContent(text, images) : text,
    createdAt: timestampFromIso(stringValue(obj.timestamp)) + lineNo,
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

async function extractCodexUserImages(
  content: unknown,
  sessionId: string,
  lineNo: number,
): Promise<ImportedImageRef[]> {
  if (!Array.isArray(content)) return [];
  const out: ImportedImageRef[] = [];
  let imageIndex = 0;
  for (const block of content) {
    if (!isRecord(block) || stringValue(block.type) !== 'input_image') continue;
    const imageUrl = stringValue(block.image_url);
    const payload = imageUrl ? parseImageDataUrl(imageUrl) : null;
    if (!payload) continue;
    const ref = await cacheImportedBase64Image({
      sessionId,
      source: 'codex',
      lineNo,
      partIndex: 0,
      imageIndex,
      mimeType: payload.mimeType,
      base64Data: payload.base64Data,
    });
    imageIndex += 1;
    if (ref) out.push(ref);
  }
  return out;
}

function openReadonlyDb(file: string): Database.Database {
  const db = createBetterSqliteDatabase(file, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

function closeDbQuietly(db: Database.Database | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* no-op */
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table);
  return !!row;
}

function getTableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function buildThreadOrderSql(db: Database.Database): string {
  const cols = new Set(getTableColumns(db, 'threads'));
  if (cols.has('updated_at_ms') && cols.has('updated_at')) {
    return 'ORDER BY COALESCE("updated_at_ms", "updated_at" * 1000) DESC';
  }
  if (cols.has('updated_at_ms')) return 'ORDER BY "updated_at_ms" DESC';
  if (cols.has('updated_at')) return 'ORDER BY "updated_at" DESC';
  if (cols.has('created_at_ms')) return 'ORDER BY "created_at_ms" DESC';
  if (cols.has('created_at')) return 'ORDER BY "created_at" DESC';
  return '';
}

function intersectColumns(source: string[], target: string[]): string[] {
  const targetSet = new Set(target);
  return source.filter((col) => targetSet.has(col));
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function samePath(a: string, b: string): boolean {
  const ar = safeRealpathSync(a);
  const br = safeRealpathSync(b);
  return !!ar && !!br && ar === br;
}

function isLikelyThreadId(id: string): boolean {
  return /^[0-9a-fA-F-]{20,}$/.test(id);
}

function normalizeEffort(raw: string): CodexThreadSummary['effort'] {
  if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max' || raw === 'ultra') {
    return raw;
  }
  return 'high';
}

function normalizeApprovalMode(raw: string): CodexThreadSummary['permissionMode'] {
  if (raw === 'never') return 'bypassPermissions';
  if (raw === 'on-failure') return 'auto';
  return 'ask';
}

function timestampMs(msValue: SqlScalar | undefined, secValue: SqlScalar | undefined): number | null {
  const ms = numberValue(msValue);
  if (ms > 0) return Math.floor(ms);
  return timestampFromAny(secValue);
}

function timestampFromIso(raw: string): number {
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : Date.now();
}

function timestampFromAny(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === 'bigint' && value > 0) {
    const n = Number(value);
    return n > 10_000_000_000 ? Math.floor(n) : Math.floor(n * 1000);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return 'Codex Session';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
