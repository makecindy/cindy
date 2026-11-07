import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const id = z.string().uuid();
const receipt = z.object({ roomId: id, sequence: z.number().int().nonnegative().safe(), version: z.literal(2).optional() }).strict();
const failure = z.object({ version: z.literal(1), code: z.string().min(1).max(64) }).strict();
export function chatMigrationReceipts(endpoint: string, actorId: string, current: () => boolean) {
  const root = ownerScopedUserDataPath('chat-upgrades', createHash('sha256').update(`${endpoint}\n${actorId}`).digest('hex'));
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(groupId: string) {
      check();
      const raw = readAtomicFileSync(path.join(root, `${id.parse(groupId)}.json`));
      return raw ? receipt.parse(JSON.parse(raw)) : null;
    },
    save(groupId: string, value: z.infer<typeof receipt>) {
      check();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(path.join(root, `${id.parse(groupId)}.json`), JSON.stringify(receipt.parse(value)));
    },
    /** A terminal server-side failure must survive restarts so the group is not retried forever. */
    readFailure(groupId: string) {
      check();
      const raw = readAtomicFileSync(path.join(root, `${id.parse(groupId)}.failed.json`));
      if (!raw) return null;
      try { return failure.parse(JSON.parse(raw)); } catch { return null; }
    },
    saveFailure(groupId: string, code: string) {
      check();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(
        path.join(root, `${id.parse(groupId)}.failed.json`),
        JSON.stringify(failure.parse({ version: 1, code })),
      );
    },
  };
}
