import type { CreateDbClientOptions, DbClient } from './DbClient.js';

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
  createInprocClient(): Promise<DbClient>;
  setCurrentDbClient(client: DbClient, userId: string): void;
  clearCurrentDbClient(client?: DbClient): void;
  beforeDispose?(reason: string): Promise<void>;
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
  let lifecycleDbClientMode: Extract<
    LifecycleDbClientMode,
    'worker' | 'inproc-fallback'
  > | null = null;

  async function dispose(reason: string): Promise<void> {
    const client = lifecycleDbClient;
    if (!client) return;
    try {
      await deps.beforeDispose?.(reason);
    } catch (err) {
      deps.log.warn('[DbClient] before-dispose hook failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    lifecycleDbClient = null;
    lifecycleDbClientUserId = null;
    lifecycleDbClientMode = null;
    deps.clearCurrentDbClient(client);
    try {
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

    if (lifecycleDbClient && lifecycleDbClientUserId === userId) {
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
      });
      const rows = await workerClient.query<{ c: number }>(
        'SELECT count(*) as c FROM sqlite_master',
        [],
      );
      const tableCount = rows[0]?.c ?? 0;
      lifecycleDbClient = workerClient;
      lifecycleDbClientUserId = userId;
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
      return activateInprocFallback(userId, dbPath);
    }
  }

  async function activateInprocFallback(
    userId: string,
    dbPath: string,
  ): Promise<LifecycleDbClientEnsureResult> {
    try {
      const fallbackClient = await deps.createInprocClient();
      lifecycleDbClient = fallbackClient;
      lifecycleDbClientUserId = userId;
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
