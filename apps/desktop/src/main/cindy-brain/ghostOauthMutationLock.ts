/**
 * OAuth credential mutations share one authorization-boundary lock with
 * plugin package updates. The existing install lock remains the in-process
 * package/lifecycle lock; this layer adds owner-scoped cross-process exclusion
 * for vault read-modify-write sequences that must agree with the committed
 * plugin manifest.
 *
 * Lock order is fixed: owner lease -> ghost install lock -> OAuth mutation
 * lock. Callers must never acquire an install/source lock from inside `task`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';

const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();
const inProcessTails = new Map<string, Promise<void>>();

export async function withGhostOauthMutationLock<T>(
  ownerScopeKey: string,
  ghostId: string,
  lockPath: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const key = `${ownerScopeKey}\u0000${ghostId}`;
  const held = heldKeys.getStore();
  if (held?.has(key)) return task();

  const previous = inProcessTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = previous.then(() => gate);
  inProcessTails.set(key, mine);
  await previous.catch(() => undefined);

  const nextHeld = new Set(held ?? []);
  nextHeld.add(key);
  try {
    return await heldKeys.run(nextHeld, async () => {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      return withSecurityBoundaryLock(
        lockPath,
        { label: 'ghost-oauth-mutation', waitMs: 12_000 },
        async (status) => {
          if (!status.held) {
            throw new Error('Plugin OAuth mutation lock is busy or unavailable');
          }
          return task();
        },
      );
    });
  } finally {
    release();
    if (inProcessTails.get(key) === mine) inProcessTails.delete(key);
  }
}

export function resetGhostOauthMutationLocksForTest(): void {
  inProcessTails.clear();
}
