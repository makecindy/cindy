import fs from 'node:fs';
import path from 'node:path';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { createLogger } from '../logger.js';
import type {
  DeferredProjectMoveIntent,
  DeferredProjectMoveScope,
  DeferredProjectMoveTarget,
} from './deferredProjectMove.js';

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const MAX_RECORD_BYTES = 64 * 1024;
const log = createLogger('project-move-journal');
const validTarget = (value: unknown): value is DeferredProjectMoveTarget => {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  return (
    (target.workspaceKind === 'project' || target.workspaceKind === 'dialogue') &&
    (target.workingDir === null ||
      (typeof target.workingDir === 'string' &&
        target.workingDir.length <= 8192 &&
        !target.workingDir.includes('\0') &&
        path.isAbsolute(target.workingDir)))
  );
};
const validDestination = (value: unknown): value is DeferredProjectMoveTarget =>
  validTarget(value) && (value.workspaceKind === 'dialogue' || value.workingDir !== null);

/**
 * Small per-task records in the active account's userData. A completed record
 * is an atomic null tombstone so Windows backup recovery cannot resurrect a
 * cancelled move after a crash between deleting a file and its backup.
 */
export function captureDeferredProjectMoveScope(): DeferredProjectMoveScope {
  const owner = activeOwnerScopeKey();
  const stamp = getActiveDataOwnerPushStamp();
  const root = ownerScopedUserDataPath('deferred-project-moves');
  const assertCurrent = () => {
    const current = getActiveDataOwnerPushStamp();
    if (
      !stamp.dataOwnerId ||
      owner !== activeOwnerScopeKey() ||
      isAppSessionBoundaryPending() ||
      current.dataOwnerId !== stamp.dataOwnerId ||
      current.ownerGeneration !== stamp.ownerGeneration
    ) {
      throw new Error('PROJECT_MOVE_OWNER_CHANGED');
    }
  };
  const file = (sessionId: string) => {
    if (!validId(sessionId)) throw new Error('PROJECT_MOVE_INVALID_SESSION_ID');
    return path.join(root, `${sessionId}.json`);
  };
  const read = (sessionId: string): DeferredProjectMoveIntent | null => {
    assertCurrent();
    const raw = readAtomicFileSync(file(sessionId));
    if (raw === null) return null;
    if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES)
      throw new Error('PROJECT_MOVE_JOURNAL_INVALID');
    const value: unknown = JSON.parse(raw);
    if (value === null) return null;
    if (!value || typeof value !== 'object') throw new Error('PROJECT_MOVE_JOURNAL_INVALID');
    const record = value as Record<string, unknown>;
    if (
      record.sessionId !== sessionId ||
      !validId(record.id) ||
      !validTarget(record.source) ||
      !validDestination(record.target)
    ) {
      throw new Error('PROJECT_MOVE_JOURNAL_INVALID');
    }
    return {
      id: record.id,
      sessionId,
      source: { ...record.source },
      target: { ...record.target },
    };
  };
  const write = (sessionId: string, value: DeferredProjectMoveIntent | null) => {
    assertCurrent();
    const target = file(sessionId);
    atomicWriteFileSync(target, JSON.stringify(value));
    const fd = fs.openSync(target, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') {
      const directory = fs.openSync(root, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  };
  assertCurrent();
  return {
    key: `${owner}:${stamp.ownerGeneration}`,
    assertCurrent,
    read,
    list() {
      assertCurrent();
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const ids = new Set(
        names.flatMap((name) => {
          const match = /^([a-zA-Z0-9_-]{1,128})\.json(?:\.bak)?$/.exec(name);
          return match ? [match[1]!] : [];
        }),
      );
      return [...ids].flatMap((sessionId) => {
        try {
          const intent = read(sessionId);
          return intent ? [intent] : [];
        } catch (error) {
          assertCurrent();
          // One damaged request cannot hide every task or block other moves.
          // Keep its file intact; an explicit send/move for this task still
          // reads it strictly rather than silently losing the user's intent.
          log.warn('could not read deferred project move', { sessionId, error });
          return [];
        }
      });
    },
    save(intent) {
      if (!validId(intent.id) || !validTarget(intent.source) || !validDestination(intent.target)) {
        throw new Error('PROJECT_MOVE_JOURNAL_INVALID');
      }
      write(intent.sessionId, intent);
    },
    remove(sessionId, expectedId) {
      const current = read(sessionId);
      if (current?.id !== expectedId) return false;
      write(sessionId, null);
      return true;
    },
  };
}
