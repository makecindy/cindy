import path from 'node:path';

import { app } from 'electron';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { createLogger } from './logger.js';
import {
  createWorkerDbClient,
  type CreateDbClientOptions,
  type DbClient,
} from './localDb/client/DbClient.js';
import { getCurrentDbClientUserId } from './localDb/client/current.js';
import {
  resolveBetterSqliteModuleEntry,
  resolveBetterSqliteNativeBinding,
} from './localDb/betterSqliteFactory.js';
import { getDrizzleDir } from './localDb/migrate.js';
import { resolveSqliteVecExtPath } from './localDb/sqliteVecLoader.js';

const log = createLogger('orca-team-dispatch-lease');

interface OrcaTeamDispatchDbScope {
  key: string;
  options: CreateDbClientOptions;
}

export interface OrcaTeamDispatchLeaseDeps {
  resolveScope(): OrcaTeamDispatchDbScope | null;
  createClient(options: CreateDbClientOptions): Promise<DbClient>;
}

export type OrcaTeamDispatchLeaseRelease = () => Promise<void>;

/**
 * Serializes the short provider-acceptance boundary through a dedicated SQLite
 * connection. BEGIN IMMEDIATE is understood by old Cindy versions too, so a
 * legacy terminal UPDATE cannot commit between the active check and vendor send.
 */
export class OrcaTeamDispatchLeaseCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private client: { scopeKey: string; value: DbClient } | null = null;

  constructor(private readonly deps: OrcaTeamDispatchLeaseDeps) {}

  async acquire(teamId: string): Promise<OrcaTeamDispatchLeaseRelease> {
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;

    let transactionOpen = false;
    try {
      const client = await this.ensureClient();
      await client.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const row = await client.queryOne<{ status: string }>(
        'SELECT status FROM orca_teams WHERE id = ? LIMIT 1',
        [teamId],
      );
      if (row?.status !== 'active') {
        throw new Error(`ORCA_TEAM_INACTIVE: team ${teamId} has already ended`);
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await this.releaseTransaction(client);
        unlock();
      };
    } catch (error) {
      if (transactionOpen && this.client) {
        await this.releaseTransaction(this.client.value);
      }
      unlock();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      await this.disposeClient();
    } finally {
      unlock();
    }
  }

  private async ensureClient(): Promise<DbClient> {
    const scope = this.deps.resolveScope();
    if (!scope) {
      throw new Error('ORCA_TEAM_DISPATCH_DB_UNAVAILABLE: no active database owner');
    }
    if (this.client?.scopeKey === scope.key) return this.client.value;
    await this.disposeClient();
    const value = await this.deps.createClient(scope.options);
    try {
      await value.queryOne('SELECT 1');
    } catch (error) {
      await value.dispose().catch(() => undefined);
      throw error;
    }
    this.client = { scopeKey: scope.key, value };
    return value;
  }

  private async releaseTransaction(client: DbClient): Promise<void> {
    try {
      await client.exec('ROLLBACK');
    } catch (error) {
      log.error('failed to release SQLite dispatch lease; disposing connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.client?.value === client) this.client = null;
      await client.dispose().catch(() => undefined);
    }
  }

  private async disposeClient(): Promise<void> {
    const current = this.client;
    this.client = null;
    await current?.value.dispose();
  }
}

function resolveCurrentScope(): OrcaTeamDispatchDbScope | null {
  const userId = getCurrentDbClientUserId();
  if (!userId) return null;
  const dbPath = path.join(
    app.getPath('userData'),
    `${BRAND_IDENTITY.dbFilePrefix}-${userId}.db`,
  );
  return {
    key: `${userId}:${dbPath}`,
    options: {
      userId,
      dbPath,
      drizzleDir: getDrizzleDir(),
      sqliteVecExtPath: resolveSqliteVecExtPath(),
      nativeBinding: resolveBetterSqliteNativeBinding(),
      betterSqliteModulePath: resolveBetterSqliteModuleEntry(),
    },
  };
}

const coordinator = new OrcaTeamDispatchLeaseCoordinator({
  resolveScope: resolveCurrentScope,
  createClient: createWorkerDbClient,
});

export function acquireOrcaTeamDispatchLease(
  teamId: string,
): Promise<OrcaTeamDispatchLeaseRelease> {
  return coordinator.acquire(teamId);
}

export function disposeOrcaTeamDispatchLeaseCoordinator(): Promise<void> {
  return coordinator.dispose();
}
