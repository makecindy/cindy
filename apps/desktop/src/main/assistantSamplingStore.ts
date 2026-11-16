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
  return {
    put(entry: Settlement): PendingSamplingSettlement {
      const file = path.join(directory(), `${randomUUID()}.json`);
      atomicWriteFileSync(file, JSON.stringify(entry));
      return { ...entry, file };
    },
    list(sessionId: string): PendingSamplingSettlement[] {
      const root = directory();
      let names: string[];
      try { names = fs.readdirSync(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      // The atomic writer can leave only a backup after an interrupted replacement.
      const files = new Set(names.filter(name => /^[0-9a-f-]{36}\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.bak$/, '')));
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
    },
  };
}

