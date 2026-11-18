import type { CreateDbClientOptions, DbClient } from './DbClient.js';
import { isSqliteCorruption } from './sqliteCorruption.js';
import { waitForRetainedDbClient } from './pendingOperations.js';

export type LifecycleDbClientMode =
  | 'worker'
  | 'inproc-fallback'
  | 'unchanged'
  | 'skipped'
  | 'failed';

export interface LifecycleDbClientEnsureResult {
  mode: LifecycleDbClientMode;
  shouldReleaseMainDb: boolean;
}

export interface LifecycleDbClientLog {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface LifecycleDbClientManagerDeps {
  getCurrentDbPath(): string | null;
  createWorkerClient(opts: CreateDbClientOptions): Promise<DbClient>;
  createInprocClient(options?: Pick<CreateDbClientOptions, 'onCorruption'>): Promise<DbClient>;
  setCurrentDbClient(client: DbClient, userId: string): void;
  clearCurrentDbClient(client?: DbClient): void;
  log: LifecycleDbClientLog;
}

export interface LifecycleDbClientManager {
  ensure(
    userId: string,
    workerOptions: Omit<CreateDbClientOptions, 'userId' | 'dbPath'>,
  ): Promise<LifecycleDbClientEnsureResult>;
  dispose(reason: string): Promise<void>;
}

export function createLifecycleDbClientManager(
  deps: LifecycleDbClientManagerDeps,
): LifecycleDbClientManager {
  let lifecycleDbClient: DbClient | null = null;
  let lifecycleDbClientUserId: string | null = null;
  let notifyCurrentCorruption: CreateDbClientOptions['onCorruption'];
  let lifecycleDbClientMode: Extract<
    LifecycleDbClientMode,
    'worker' | 'inproc-fallback'
  > | null = null;

  async function dispose(reason: string): Promise<void> {
    const client = lifecycleDbClient;
    if (!client) return;
    lifecycleDbClient = null;
    lifecycleDbClientUserId = null;
    notifyCurrentCorruption = undefined;
    lifecycleDbClientMode = null;
    deps.clearCurrentDbClient(client);
    try {
      await waitForRetainedDbClient(client);
      await client.dispose();
      deps.log.info('[DbClient] disposed', { reason });
    } catch (err) {
      deps.log.warn('[DbClient] dispose failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function ensure(
    userId: string,
    workerOptions: Omit<CreateDbClientOptions, 'userId' | 'dbPath'>,
  ): Promise<LifecycleDbClientEnsureResult> {
    const dbPath = deps.getCurrentDbPath();
    if (!dbPath) {
      deps.log.warn('[DbClient] skip lifecycle start: localDb path unavailable', { userId });
      return { mode: 'skipped', shouldReleaseMainDb: false };
    }

    if (lifecycleDbClient?.corruptionError && lifecycleDbClientUserId === userId) {
      await dispose('retry-after-corruption');
    }
    if (lifecycleDbClient && lifecycleDbClientUserId === userId) {
      // The live connection may survive a same-owner generation change. Use
      // the latest readiness callback, not the stamp from its initial creation.
      notifyCurrentCorruption = workerOptions.onCorruption;
      return {
        mode: 'unchanged',
        shouldReleaseMainDb: lifecycleDbClientMode === 'worker',
      };
    }
    if (lifecycleDbClient) {
      await dispose('user-switch');
    }

    let workerClient: DbClient | null = null;
    try {
      workerClient = await deps.createWorkerClient({
        ...workerOptions,
        userId,
        dbPath,
        onCorruption: (error) => {
          if (lifecycleDbClient === workerClient && lifecycleDbClientUserId === userId) {
            notifyCurrentCorruption?.(error);
          }
        },
      });
      const rows = await workerClient.query<{ c: number }>(
        'SELECT count(*) as c FROM sqlite_master',
        [],
      );
      const tableCount = rows[0]?.c ?? 0;
      lifecycleDbClient = workerClient;
      lifecycleDbClientUserId = userId;
      notifyCurrentCorruption = workerOptions.onCorruption;
      lifecycleDbClientMode = 'worker';
      deps.setCurrentDbClient(workerClient, userId);
      deps.log.info(`[DbClient] smoke OK, table count = ${tableCount}`, {
        userId,
        dbPath,
        tableCount,
      });
      return { mode: 'worker', shouldReleaseMainDb: true };
    } catch (err) {
      deps.log.error('[DbClient] worker smoke failed; main localDb path remains active', {
        userId,
        dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      if (workerClient) {
        try {
          await workerClient.dispose();
        } catch (disposeErr) {
          deps.log.warn('[DbClient] dispose after failed smoke failed', {
            userId,
            error: disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
          });
        }
      }
      // Corruption is a database failure, not a missing worker bundle. Never
      // bypass containment by opening a second native connection to that file.
      if (isSqliteCorruption(err)) throw err;
      return activateInprocFallback(userId, dbPath, workerOptions.onCorruption);
    }
  }

  async function activateInprocFallback(
    userId: string,
    dbPath: string,
    onCorruption?: (error: Error) => void,
  ): Promise<LifecycleDbClientEnsureResult> {
    try {
      const fallbackClient = await deps.createInprocClient({ onCorruption: (error) => {
        if (lifecycleDbClient === fallbackClient && lifecycleDbClientUserId === userId) {
          notifyCurrentCorruption?.(error);
        }
      } });
      lifecycleDbClient = fallbackClient;
      lifecycleDbClientUserId = userId;
      notifyCurrentCorruption = onCorruption;
      lifecycleDbClientMode = 'inproc-fallback';
      deps.setCurrentDbClient(fallbackClient, userId);
      deps.log.warn('[DbClient] inproc fallback active after worker takeover failed', {
        userId,
        dbPath,
      });
      return { mode: 'inproc-fallback', shouldReleaseMainDb: false };
    } catch (fallbackErr) {
      deps.log.error('[DbClient] inproc fallback failed after worker takeover failed', {
        userId,
        dbPath,
        error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      return { mode: 'failed', shouldReleaseMainDb: false };
    }
  }

  return { ensure, dispose };
}
