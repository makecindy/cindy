import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

/** Immutable HTTP intent survives a lost response and a client restart. */
export function chatSendJournal<T>(endpoint: string, current: () => boolean) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const root = ownerScopedUserDataPath('chat-send-journal', hash(endpoint));
  const file = (key: string) => path.join(root, `${hash(key)}.json`);
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  const write = (key: string, value: unknown) => {
    check(); const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('OUTBOX_TOO_LARGE');
    mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(file(key), raw);
  };
  return {
    read(key: string, signature: string): { intent?: T; receipt?: string } | null {
      check(); const raw = readAtomicFileSync(file(key));
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (value.version !== 1 || value.signature !== signature) throw new Error('INVALID_INPUT');
      return value;
    },
    save(key: string, signature: string, intent: T, roomId?: string) { write(key, { version: 1, signature, intent, roomId }); },
    forgetRoom(roomId: string) {
      check();
      if (!roomId) return;
      let names: string[];
      try { names = readdirSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const filename = path.join(root, name);
        const value = JSON.parse(readAtomicFileSync(filename) ?? '{}');
        if (value.roomId !== roomId) continue;
        // No background process replays this journal. Remove private request content
        // when its room is hidden/deleted or access is revoked, including atomic backups.
        atomicWriteFileSync(filename, JSON.stringify({ version: 1, signature: value.signature }));
        rmSync(`${filename}.bak`, { force: true }); rmSync(filename, { force: true });
      }
    },
    confirm(key: string, signature: string, receipt: string) {
      write(key, { version: 1, signature, receipt });
      // The atomic backup otherwise retains the full message after compaction.
      rmSync(`${file(key)}.bak`, { force: true });
      // A byte budget for old receipts; unconfirmed user intent is never evicted.
      try {
        const files = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
          const filename = path.join(root, name); const stat = statSync(filename); return { filename, size: stat.size, at: stat.mtimeMs };
        }).sort((a, b) => a.at - b.at);
        let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of files) {
          if (bytes <= 64 * 1024 * 1024) break;
          if (entry.filename === file(key) || !JSON.parse(readAtomicFileSync(entry.filename) ?? '{}').receipt) continue;
          rmSync(`${entry.filename}.bak`, { force: true }); rmSync(entry.filename, { force: true }); bytes -= entry.size;
        }
      } catch { /* Receipt collection must not change an acknowledged send. */ }
    },
  };
}
