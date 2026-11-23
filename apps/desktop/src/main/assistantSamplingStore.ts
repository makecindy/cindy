import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';

interface Settlement {
  sessionId: string;
  persistId: string;
  patch: Record<string, unknown>;
}
export interface PendingSamplingSettlement extends Settlement { file: string }

/** One immutable intent per file: independent writers cannot overwrite each other.
 * The owner's DB update is idempotent; acknowledge only this intent after it succeeds.
 * These small writes happen at sampling boundaries, never on text deltas.
 */
export function createAssistantSamplingSettlementStore(directory: () => string) {
  // Writes are immutable. Track only files written by this instance that have
  // yet to be acknowledged, partitioned by the owner directory and session.
  const pending = new Map<string, Set<string>>();
  const sessionKey = (root: string, sessionId: string) => JSON.stringify([root, sessionId]);
  return {
    put(entry: Settlement): PendingSamplingSettlement {
      const root = directory();
      const file = path.join(root, `${randomUUID()}.json`);
      atomicWriteFileSync(file, JSON.stringify(entry));
      const key = sessionKey(root, entry.sessionId);
      const files = pending.get(key) ?? new Set<string>();
      files.add(file);
      pending.set(key, files);
      return { ...entry, file };
    },
    hasPendingWrite(sessionId: string): boolean {
      return pending.has(sessionKey(directory(), sessionId));
    },
    list(sessionId: string): PendingSamplingSettlement[] {
      const root = directory();
      const key = sessionKey(root, sessionId);
      let names: string[];
      try { names = fs.readdirSync(root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        pending.delete(key);
        return [];
      }
      // The atomic writer can leave only a backup after an interrupted replacement.
      const files = new Set(names.filter(name => /^[0-9a-f-]{36}\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.bak$/, '')));
      // Another process using this owner directory may already have replayed
      // and removed our files. Reconcile the index during the existing read.
      const written = pending.get(key);
      if (written) {
        for (const file of written) if (!files.has(path.basename(file))) written.delete(file);
        if (!written.size) pending.delete(key);
      }
      return [...files].flatMap(name => {
        const file = path.join(root, name);
        const raw = readAtomicFileSync(file);
        if (raw === null) return [];
        const entry = JSON.parse(raw) as Settlement;
        if (typeof entry.sessionId !== 'string' || typeof entry.persistId !== 'string'
          || !entry.patch || typeof entry.patch !== 'object' || entry.patch.samplingAttemptPending !== false) {
          throw new Error('INVALID_SAMPLING_SETTLEMENT');
        }
        return entry.sessionId === sessionId ? [{ ...entry, file }] : [];
      });
    },
    acknowledge(entry: PendingSamplingSettlement): void {
      // Exact file captured at enqueue, not a path re-resolved after an account switch.
      fs.rmSync(entry.file, { force: true });
      const key = sessionKey(path.dirname(entry.file), entry.sessionId);
      const files = pending.get(key);
      files?.delete(entry.file);
      if (files?.size === 0) pending.delete(key);
    },
  };
}

