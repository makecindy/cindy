import fs from 'node:fs';
import path from 'node:path';
import { createIpcError } from '../../shared/ipc-errors';
import {
  ownerScopedUserDataPath,
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
} from '../appSessionState';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';
import type { MigrationHandoff } from './handoff';

export interface IncomingMigration {
  kind: 'incoming';
  id: string;
  sessionId: string;
  sourceDeviceId: string;
  sourceSessionId: string;
  stage: 'receiving' | 'ready' | 'active';
  workingDir: string;
  workers?: Array<{ sessionId: string; sourceSessionId: string; workingDir: string }>;
  /** Retained failed attempts; never delete or overwrite files a user may have opened. */
  retainedWorkingDirs?: string[];
}
export type MigrationRecord = (MigrationHandoff & { kind: 'outgoing' }) | IncomingMigration;
const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function migrationScope() {
  const owner = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath('task-migrations');
  const assertCurrent = () => {
    if (!owner || owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('MIGRATION_OWNER_CHANGED');
  };
  const file = (sessionId: string, incoming = false) => {
    if (!validId(sessionId)) throw new Error('MIGRATION_INVALID_ID');
    return path.join(root, incoming ? 'receipts' : 'records', `${sessionId}.json`);
  };
  const readRecord = (sessionId: string, incoming = false): MigrationRecord | null => {
    assertCurrent();
    const raw = readAtomicFileSync(file(sessionId, incoming));
    if (!raw) return null;
    const record = JSON.parse(raw) as MigrationRecord;
    if (
      record.sessionId !== sessionId ||
      !['outgoing', 'incoming'].includes(record.kind) ||
      !/^[a-f0-9-]{36}$/.test(record.id) ||
      typeof record.workingDir !== 'string' ||
      !path.isAbsolute(record.workingDir) ||
      !validId(record.sourceDeviceId) ||
      (record.workers !== undefined &&
        (!Array.isArray(record.workers) ||
          record.workers.some(
            (worker) =>
              !validId(worker.sessionId) ||
              typeof worker.workingDir !== 'string' ||
              !path.isAbsolute(worker.workingDir) ||
              ('targetSessionId' in worker
                ? !validId(worker.targetSessionId)
                : !validId(worker.sourceSessionId)),
          ))) ||
      (record.kind === 'incoming'
        ? !['receiving', 'ready', 'active'].includes(record.stage) ||
          !validId(record.sourceSessionId) ||
          (record.retainedWorkingDirs !== undefined &&
            (!Array.isArray(record.retainedWorkingDirs) ||
              record.retainedWorkingDirs.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir))))
        : !['preparing', 'transferring', 'moved', 'complete', 'cancelled'].includes(record.stage) ||
          !validId(record.targetDeviceId) ||
          record.targetSessionId !== record.id)
    )
      throw new Error('MIGRATION_JOURNAL_INVALID');
    return record;
  };
  const readIncoming = (id: string) => readRecord(id, true) as IncomingMigration | null;
  const list = (incoming = false): MigrationRecord[] => {
    assertCurrent();
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, incoming ? 'receipts' : 'records'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // Include backups after an interrupted Windows atomic replacement.
    return [
      ...new Set(
        names
          .filter((name) => /\.json(?:\.bak)?$/.test(name))
          .map((name) => name.replace(/\.json(?:\.bak)?$/, '')),
      ),
    ]
      .map((id) => readRecord(id, incoming))
      .filter((record): record is MigrationRecord => record !== null);
  };
  const read = (id: string): MigrationRecord | null => {
    const own = readRecord(id);
    if (own && own.stage !== 'cancelled') return own;
    return (
      list().find(
        (record) =>
          record.stage !== 'cancelled' && record.workers?.some((worker) => worker.sessionId === id),
      ) ??
      own ??
      readIncoming(id) ??
      list(true).find((record) => record.workers?.some((worker) => worker.sessionId === id)) ??
      null
    );
  };
  return {
    root,
    assertCurrent,
    read,
    readIncoming,
    list,
    save(record: MigrationRecord) {
      assertCurrent();
      const target = file(record.sessionId, record.kind === 'incoming');
      atomicWriteFileSync(target, JSON.stringify(record));
      // A remote activation must never outrun the persisted source fence.
      const sync = (name: string) => {
        const fd = fs.openSync(name, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      };
      sync(target);
      if (process.platform !== 'win32') {
        sync(path.dirname(target));
        sync(root);
        sync(path.dirname(root));
      }
    },
  };
}

/** Kept active DB rows retain media/worktree references; no archive/delete lifecycle is invoked. */
export function assertTaskMigrationWritable(sessionId: string): void {
  const record = migrationScope().read(sessionId);
  if (
    !record ||
    (record.kind === 'incoming' && record.stage === 'active') ||
    (record.kind === 'outgoing' && record.stage === 'cancelled')
  )
    return;
  throw createIpcError(
    'PRECONDITION_FAILED',
    record.kind === 'outgoing' && ['moved', 'complete'].includes(record.stage)
      ? 'MIGRATION_TASK_MOVED'
      : 'MIGRATION_TASK_BUSY',
  );
}
