import fs from 'node:fs';
import path from 'node:path';
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
  stage: 'receiving' | 'active';
  workingDir: string;
  workers?: Array<{ sessionId: string; sourceSessionId: string; workingDir: string }>;
  /** Retained failed attempts; never delete or overwrite files a user may have opened. */
  retainedWorkingDirs?: string[];
  /** The copy created a new project folder, registered as a recent project once imported. */
  newProject?: true;
}
export type MigrationRecord = (MigrationHandoff & { kind: 'outgoing' }) | IncomingMigration;
const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function migrationScope() {
  const owner = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath('task-copies');
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
        ? !['receiving', 'active'].includes(record.stage) ||
          !validId(record.sourceSessionId) ||
          (record.retainedWorkingDirs !== undefined &&
            (!Array.isArray(record.retainedWorkingDirs) ||
              record.retainedWorkingDirs.some(
                (dir) => typeof dir !== 'string' || !path.isAbsolute(dir),
              )))
        : !['preparing', 'transferring', 'complete', 'cancelled'].includes(record.stage) ||
          !validId(record.targetDeviceId) ||
          record.targetSessionId !== record.id)
    )
      throw new Error('MIGRATION_JOURNAL_INVALID');
    return record;
  };
  const readIncoming = (id: string) => readRecord(id, true) as IncomingMigration | null;
  const read = (id: string): MigrationRecord | null => readRecord(id) ?? readIncoming(id);
  return {
    root,
    assertCurrent,
    read,
    readIncoming,
    save(record: MigrationRecord) {
      assertCurrent();
      const target = file(record.sessionId, record.kind === 'incoming');
      atomicWriteFileSync(target, JSON.stringify(record));
      // A remote activation must never outrun the persisted source fence.
      const sync = (name: string, flags = 'r') => {
        const fd = fs.openSync(name, flags);
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      };
      // Windows FlushFileBuffers requires a writable handle; r+ preserves contents.
      sync(target, 'r+');
      if (process.platform !== 'win32') {
        sync(path.dirname(target));
        sync(root);
        sync(path.dirname(root));
      }
    },
  };
}
