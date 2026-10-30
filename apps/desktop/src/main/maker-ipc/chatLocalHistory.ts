import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { BotGroupDetail } from '../../shared/botGroupChat.js';

const MAX_BYTES = 8 * 1024 * 1024;
/** Display snapshots only; every write/action still uses current server authority. */
export function chatLocalHistory(endpoint: string, current: () => boolean) {
  const root = ownerScopedUserDataPath('chat-history', createHash('sha256').update(endpoint).digest('hex'));
  const revoked = new Set<string>();
  const file = (roomId: string) => path.join(root, `${createHash('sha256').update(roomId).digest('hex')}.json`);
  return {
    read(roomId: string): BotGroupDetail | null {
      if (!current() || revoked.has(roomId)) return null;
      try {
        const raw = readAtomicFileSync(file(roomId));
        if (!raw || Buffer.byteLength(raw) > MAX_BYTES) return null;
        const value = JSON.parse(raw);
        if (value.version !== 1 || value.group?.id !== roomId || !Array.isArray(value.group.messages)
          || !Array.isArray(value.group.members) || !Array.isArray(value.group.plans) || !value.group.round) return null;
        return current() ? value.group : null;
      } catch { return null; }
    },
    save(roomId: string, group: BotGroupDetail): void {
      if (!current()) return;
      const raw = JSON.stringify({ version: 1, group });
      if (Buffer.byteLength(raw) > MAX_BYTES) return;
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        atomicWriteFileSync(file(roomId), raw);
        revoked.delete(roomId);
      } catch { /* Best-effort history never changes the result of a server read. */ }
    },
    forget(roomId: string): void {
      if (!current()) return;
      revoked.add(roomId);
      try {
        // Replace first so a recoverable Windows backup cannot resurrect a revoked page.
        atomicWriteFileSync(file(roomId), JSON.stringify({ version: 1, group: null }));
        rmSync(`${file(roomId)}.bak`, { force: true }); rmSync(file(roomId), { force: true });
      } catch { /* The current process never serves the revoked page. */ }
    },
  };
}
