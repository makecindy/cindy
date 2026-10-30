/**
 * Owner-scoped restart records for Agent-approved app updates: `{ records: [...] }`,
 * one entry per attempted restart whose result is not yet written back. Entries
 * are appended, never replaced, and removed one by one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createLogger, maskPath } from '../logger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { AgentAppUpdateMarker } from './agentAppUpdateService.js';

const log = createLogger('agent-app-update');

function parseRecord(value: unknown): AgentAppUpdateMarker | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<AgentAppUpdateMarker>;
  if (
    typeof record.requestId !== 'string' ||
    typeof record.sessionId !== 'string' ||
    typeof record.fromVersion !== 'string' ||
    typeof record.requestedAt !== 'number' ||
    typeof record.pid !== 'number'
  )
    return null;
  return {
    requestId: record.requestId,
    sessionId: record.sessionId,
    fromVersion: record.fromVersion,
    ...(typeof record.targetVersion === 'string' ? { targetVersion: record.targetVersion } : {}),
    requestedAt: record.requestedAt,
    pid: record.pid,
  };
}

function readRecords(file: string, mode: 'lenient' | 'before-write'): AgentAppUpdateMarker[] {
  let raw: string | null;
  try {
    raw = readAtomicFileSync(file);
  } catch (error) {
    // An unreadable (not merely missing) file may hold records; never overwrite it blindly.
    if (mode === 'before-write') throw error;
    log.warn('agent app update marker read failed', { error: String(error) });
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { records?: unknown };
    if (!Array.isArray(parsed.records)) throw new Error('records missing');
    const records = parsed.records.map(parseRecord);
    // Before a write, one invalid entry makes the whole file untrusted: move it
    // aside intact rather than rewriting it without that entry.
    if (mode === 'before-write' && records.some((record) => !record)) {
      throw new Error('invalid record');
    }
    return records.filter((record): record is AgentAppUpdateMarker => !!record);
  } catch {
    if (mode === 'before-write') {
      // Unparseable content is moved aside rather than overwritten: nothing is
      // destroyed, and a damaged file cannot block every later update either.
      // A failed move throws, which cancels the restart.
      const aside = `${file}.corrupt-${Date.now()}`;
      // A leftover `.bak` goes with it: the next atomic write would otherwise restore
      // and then replace it, losing whatever records that backup still holds.
      if (fs.existsSync(`${file}.bak`)) fs.renameSync(`${file}.bak`, `${aside}.bak`);
      fs.renameSync(file, aside);
      log.warn('agent app update marker was corrupt; moved aside', { path: maskPath(aside) });
    } else {
      log.warn('agent app update marker is corrupt; ignoring it');
    }
    return [];
  }
}

function writeRecords(file: string, records: readonly unknown[]): void {
  if (records.length === 0) {
    for (const target of [file, `${file}.bak`]) fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ records }));
}

export function listRestartRecords(file: string): AgentAppUpdateMarker[] {
  return readRecords(file, 'lenient');
}

/** Throws when existing records cannot be preserved; the caller then does not restart. */
export function addRestartRecord(file: string, record: AgentAppUpdateMarker): void {
  const records = readRecords(file, 'before-write');
  // No cap: records leave only when delivered, their task is gone, or after 7 days.
  writeRecords(file, [...records, record]);
}

export function removeRestartRecord(file: string, requestId: string): void {
  // Works on the raw entries so an entry this module cannot parse is kept intact.
  let entries: unknown[];
  try {
    const raw = readAtomicFileSync(file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { records?: unknown };
    if (!Array.isArray(parsed.records)) return;
    entries = parsed.records;
  } catch (error) {
    log.warn('agent app update marker read failed', { error: String(error) });
    return;
  }
  const remaining = entries.filter(
    (entry) =>
      !(
        entry &&
        typeof entry === 'object' &&
        (entry as { requestId?: unknown }).requestId === requestId
      ),
  );
  if (remaining.length === entries.length) return;
  try {
    writeRecords(file, remaining);
  } catch (error) {
    log.warn('agent app update marker update failed', { error: String(error) });
  }
}
