/** Device-local project choices and prepared workspaces; never shared chat state. */
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
const workspace = z.object({ workDir: z.string(), branch: z.string().nullable(), ownerSessionId: z.string().nullable() });
const record = z.object({ projectDir: z.string().nullable(), plans: z.record(z.string(), workspace) });
export function chatServerWorkspaces(endpoint: string, actorId: string, current: () => boolean) {
  const root = ownerScopedUserDataPath('chat-workspace-settings', createHash('sha256').update(`${endpoint}\n${actorId}`).digest('hex'));
  const file = (room: string) => path.join(root, `${z.string().uuid().parse(room)}.json`);
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(room: string): z.infer<typeof record> | null {
      check(); const raw = readAtomicFileSync(file(room));
      return raw ? record.parse(JSON.parse(raw)) : null;
    },
    save(room: string, value: z.infer<typeof record>) {
      check(); mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file(room), JSON.stringify(record.parse(value)));
    },
  };
}
