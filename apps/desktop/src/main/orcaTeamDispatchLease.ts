import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { app } from 'electron';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { createLogger } from './logger.js';
import type { CreateDbClientOptions } from './localDb/client/DbClient.js';
import {
  createIsolatedSqliteClient,
  type IsolatedSqliteClient,
} from './localDb/client/IsolatedSqliteClient.js';
import { getCurrentDbClientUserId } from './localDb/client/current.js';
import { resolveBetterSqliteNativeBinding } from './localDb/betterSqliteFactory.js';
import {
  orcaTeamTerminalFence,
  type OrcaTeamTerminalFenceState,
} from './orcaTeamTerminalFence.js';

const log = createLogger('orca-team-dispatch-lease');

interface OrcaTeamDispatchDbScope {
  key: string;
  options: CreateDbClientOptions;
}

export interface OrcaTeamDispatchLeaseDeps {
  resolveScope(): OrcaTeamDispatchDbScope | null;
  createClient(options: CreateDbClientOptions): Promise<IsolatedSqliteClient>;
  getTerminalFenceState(teamId: string): OrcaTeamTerminalFenceState;
}

export type OrcaTeamDispatchLeaseRelease = () => Promise<void>;

/**
 * Serializes the short local provider-submission boundary through a dedicated SQLite
 * connection. BEGIN IMMEDIATE is understood by old Cindy versions too, so a
 * legacy terminal UPDATE cannot commit between the active check and vendor send.
 */
export class OrcaTeamDispatchLeaseCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private client: { scopeKey: string; value: IsolatedSqliteClient } | null = null;

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
      await this.beginImmediate(client);
      transactionOpen = true;
      const row = await client.queryOne<{ status: string }>(
        'SELECT status FROM orca_teams WHERE id = ? LIMIT 1',
        [teamId],
      );
      if (row?.status !== 'active') {
        throw new Error(`ORCA_TEAM_INACTIVE: team ${teamId} has already ended`);
      }
      // BEGIN IMMEDIATE protects against durable terminal writers, but an
      // in-process end_team may already have raised its synchronous fence while
      // still waiting for this transaction. Recheck after the final DB read so
      // no await remains between the local fence and returning the vendor lease.
      const fenceState = this.deps.getTerminalFenceState(teamId);
      if (fenceState === 'pending') {
        throw new Error(
          `ORCA_TEAM_TERMINATING: team ${teamId} terminal transition is still pending`,
        );
      }
      if (fenceState === 'terminal') {
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

  private async ensureClient(): Promise<IsolatedSqliteClient> {
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

  private async beginImmediate(client: IsolatedSqliteClient): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await client.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
  }

  private async releaseTransaction(client: IsolatedSqliteClient): Promise<void> {
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
      nativeBinding: resolveBetterSqliteNativeBinding(),
    },
  };
}

const coordinator = new OrcaTeamDispatchLeaseCoordinator({
  resolveScope: resolveCurrentScope,
  createClient: createIsolatedSqliteClient,
  getTerminalFenceState: (teamId) => orcaTeamTerminalFence.getState(teamId),
});

export function acquireOrcaTeamDispatchLease(
  teamId: string,
): Promise<OrcaTeamDispatchLeaseRelease> {
  return coordinator.acquire(teamId);
}

export function disposeOrcaTeamDispatchLeaseCoordinator(): Promise<void> {
  return coordinator.dispose();
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error ? error.code === 'SQLITE_BUSY' : /database is locked/i.test(error.message))
  );
}
