import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { physicalWorktreeKey, worktreeResourceId } from './resourceLock';
import type { WorktreeMeta } from './types';
import type { WorktreeRecoveryArchive } from './recoveryArchive';
import { createLogger } from '../logger';
import { notifyWorktreeRecycleRecordChanged } from './recycleEvents';

const log = createLogger('worktreeRecycleJournal');

/** Durable deletion intent and recovery evidence, independent of the active task ledger. */
export interface WorktreeRecycleRecord {
  version: 1;
  id: string;
  generation: string;
  meta: WorktreeMeta;
  requestedAt: string;
  phase: 'pending' | 'snapshotted' | 'removing' | 'removed' | 'restoring' | 'restored';
  attempts: number;
  nextAttemptAt: number;
  reason?: string;
  /** null is a durable marker that recovery has reserved a previously absent directory. */
  directoryIdentity?: string | null;
  snapshot?: { head: string; headRef?: string | null; tree: string; indexTree: string; commit: string; ref: string; indexHash: string };
  restoredGeneration?: string;
  /** Temporary checkout used to repair a partially removed worktree. */
  restoreCheckoutPath?: string;
  archive?: WorktreeRecoveryArchive;
}

export function recycleJournalRoot(): string {
  return path.join(app.getPath('userData'), 'worktree-recycle');
}

export function worktreeGeneration(meta: WorktreeMeta): string {
  return meta.generation ?? `${meta.sessionId}:${meta.createdAt}`;
}

function parseRecord(raw: string, id: string): WorktreeRecycleRecord {
  const record = JSON.parse(raw) as WorktreeRecycleRecord;
  if (!record || record.version !== 1 || record.id !== id || !record.meta
    || typeof record.generation !== 'string' || !record.generation
    || typeof record.meta.sessionId !== 'string' || !record.meta.sessionId
    || typeof record.meta.path !== 'string' || !path.isAbsolute(record.meta.path)
    || typeof record.meta.baseRepo !== 'string' || !path.isAbsolute(record.meta.baseRepo)
    || (record.restoreCheckoutPath !== undefined
      && (typeof record.restoreCheckoutPath !== 'string' || !path.isAbsolute(record.restoreCheckoutPath)))
    || typeof record.requestedAt !== 'string' || !Number.isFinite(Date.parse(record.requestedAt))
    || !Number.isInteger(record.attempts) || record.attempts < 0
    || !Number.isFinite(record.nextAttemptAt)
    || !['pending', 'snapshotted', 'removing', 'removed', 'restoring', 'restored'].includes(record.phase)) {
    throw new Error('invalid worktree recycle record');
  }
  return record;
}

export async function readRecycleRecord(value: string, sessionId?: string): Promise<WorktreeRecycleRecord | null> {
  const id = worktreeResourceId(await physicalWorktreeKey(value));
  try {
    const record = parseRecord(await fs.readFile(path.join(recycleJournalRoot(), `${id}.json`), 'utf8'), id);
    if (!sessionId || record.meta.sessionId === sessionId) return record;
    const history = path.join(recycleJournalRoot(), 'history');
    let names: string[];
    try { names = await fs.readdir(history); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const matches: WorktreeRecycleRecord[] = [];
    for (const name of names.filter((name) => name.startsWith(`${id}-`) && name.endsWith('.json'))) {
      const candidate = parseRecord(await fs.readFile(path.join(history, name), 'utf8'), id);
      if (candidate.meta.sessionId === sessionId) matches.push(candidate);
    }
    return matches.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Caller holds the physical resource lock. Atomic per-resource files cannot lose another resource's update. */
export async function writeRecycleRecord(record: WorktreeRecycleRecord): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(record.id)) throw new Error('invalid worktree resource id');
  const root = recycleJournalRoot();
  await fs.mkdir(root, { recursive: true });
  if (record.archive && record.snapshot && record.phase === 'removed') {
    const history = path.join(root, 'history');
    await fs.mkdir(history, { recursive: true });
    const key = createHash('sha256').update(`${record.generation}:${record.requestedAt}:${record.snapshot.commit}`).digest('hex');
    await writeRecordFile(path.join(history, `${record.id}-${key}.json`), record);
  }
  await writeRecordFile(path.join(root, `${record.id}.json`), record);
  notifyWorktreeRecycleRecordChanged(record.id);
}

/** Watch atomic journal replacements, not archive bytes, temporary files or history. */
export async function watchRecycleJournal(onChange: () => void, onError: (error: unknown) => void): Promise<() => void> {
  const root = recycleJournalRoot();
  await fs.mkdir(root, { recursive: true });
  const watcher = watch(root, { persistent: false }, (_event, filename) => {
    if (filename === null || /^[a-f0-9]{64}\.json$/.test(filename.toString())) onChange();
  });
  watcher.on('error', onError);
  return () => watcher.close();
}

async function writeRecordFile(target: string, record: WorktreeRecycleRecord): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function newRecycleRecord(meta: WorktreeMeta): Promise<WorktreeRecycleRecord> {
  return {
    version: 1, id: worktreeResourceId(await physicalWorktreeKey(meta.path)),
    generation: worktreeGeneration(meta), meta, requestedAt: new Date().toISOString(),
    phase: 'pending', attempts: 0, nextAttemptAt: 0,
  };
}

/** Fail closed for a malformed file; callers report the failure without discarding evidence. */
export async function listRecycleRecords(): Promise<WorktreeRecycleRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(recycleJournalRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: WorktreeRecycleRecord[] = [];
  for (const name of names.filter((value) => /^[a-f0-9]{64}\.json$/.test(value))) {
    try {
      records.push(parseRecord(await fs.readFile(path.join(recycleJournalRoot(), name), 'utf8'), name.slice(0, -5)));
    } catch {
      log.warn('invalid worktree recycle request preserved', { resourceId: name.slice(0, -5) });
    }
  }
  return records;
}
