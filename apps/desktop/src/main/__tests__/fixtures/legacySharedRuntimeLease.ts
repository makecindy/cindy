import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeRuntimeLease } from '../../worktree/runtimeLeases';
import { physicalWorktreeKey } from '../../worktree/resourceLock';

/** Seed persisted old-client evidence; production no longer creates shared leases or Git locks. */
export async function seedLegacySharedRuntimeLease(
  appData: string,
  worktree: string,
  gitLock: string,
): Promise<WorktreeRuntimeLease> {
  const directory = path.join(appData, 'Cindy', 'shared-worktree-runtime-leases');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(gitLock, JSON.stringify({ kind: 'cindy-runtime-lock', version: 1, nonce: 'legacy-fixture' }), { flag: 'wx' })
    .catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const identity = await fs.lstat(gitLock);
  const keepSentinel = {
    file: gitLock,
    content: await fs.readFile(gitLock, 'utf8'),
    identity: `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`,
  };
  const file = path.join(directory, `${process.pid}-${randomUUID().replaceAll('-', '').repeat(2)}.json`);
  const physicalPath = await physicalWorktreeKey(worktree);
  await fs.writeFile(file, JSON.stringify({ version: 1, pid: process.pid, path: physicalPath, keepSentinel }));
  return { file, physicalPath, keepSentinel };
}
