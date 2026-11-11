import { AsyncLocalStorage } from 'node:async_hooks';
import { requestSessionArchiveSync } from './sessionArchiveSync.js';

type SessionRuntimeCleanup = (sessionId: string) => void;

let sessionRuntimeCleanup: SessionRuntimeCleanup | null = null;

/** Composition-root injection for Host-owned runtime routing state. */
export function setSessionRuntimeCleanup(cleanup: SessionRuntimeCleanup | null): void {
  sessionRuntimeCleanup = cleanup;
}

/**
 * Runtime model/provider/axis overrides survive ordinary process release, but
 * not task archive/delete boundaries. Call this while holding the task route
 * lock that commits the terminal status so a queued mutation cannot recreate
 * state between the DB write and cleanup.
 */
export function cleanupSessionRuntimeForTerminalStatus(sessionId: string, status: unknown): void {
  if (status !== 'deleted' && status !== 'archived') return;
  sessionRuntimeCleanup?.(sessionId);
  requestSessionArchiveSync();
}

// Only live creation attempts are retained. The DB client identifies the owner;
// the async context identifies the exact attempt, including late preparation.
interface SessionCreationAttempt {
  sessionId: string;
  owner: object;
  readOwner: () => object;
  controller: AbortController;
}
const creationContext = new AsyncLocalStorage<SessionCreationAttempt>();
const creations = new Set<SessionCreationAttempt>();

export function currentSessionCreationSignal(sessionId: string): AbortSignal | undefined {
  const attempt = creationContext.getStore();
  return attempt?.sessionId === sessionId ? attempt.controller.signal : undefined;
}

export function assertSessionCreationCurrent(): void {
  const attempt = creationContext.getStore();
  if (!attempt) return;
  if (attempt.owner !== attempt.readOwner()) {
    attempt.controller.abort(new Error('[REMOTE_AGENT_EXPIRED] The task owner has changed.'));
  }
  attempt.controller.signal.throwIfAborted();
}

/** Call only after validating the terminal request against this owner's DB. */
export function captureSessionCreationCancellation(owner: object, sessionId: string): () => void {
  const snapshot = [...creations].filter(attempt => attempt.owner === owner && attempt.sessionId === sessionId);
  return () => {
    for (const attempt of snapshot) {
      if (creations.has(attempt)) {
        attempt.controller.abort(new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.'));
      }
    }
  };
}

/** Held inside the existing route lock; cancellation releases it before late preparation completes. */
export async function runSessionCreationAttempt<T>(
  sessionId: string,
  readOwner: () => object,
  task: () => Promise<T>,
): Promise<T> {
  const attempt: SessionCreationAttempt = {
    sessionId, owner: readOwner(), readOwner, controller: new AbortController(),
  };
  creations.add(attempt);
  const signal = attempt.controller.signal;
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const onAbort = () => rejectCancelled(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([creationContext.run(attempt, task), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    creations.delete(attempt);
  }
}
