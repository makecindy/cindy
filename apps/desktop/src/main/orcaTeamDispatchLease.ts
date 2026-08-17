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

export type OrcaTeamDispatchLeaseOutcome = 'submitted' | 'confirmed-undispatched';

export interface OrcaTeamDispatchCleanupTarget {
  sessionId: string;
  clientId: string;
}

export type OrcaTeamDispatchLeaseRelease = (
  outcome?: OrcaTeamDispatchLeaseOutcome,
) => Promise<void>;

/**
 * Serializes the short local provider-submission boundary through a dedicated SQLite
 * connection. BEGIN IMMEDIATE is understood by old Cindy versions too, so a
 * legacy terminal UPDATE cannot commit between the active check and vendor send.
 */
export class OrcaTeamDispatchLeaseCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private client: { scopeKey: string; value: IsolatedSqliteClient } | null = null;

  constructor(private readonly deps: OrcaTeamDispatchLeaseDeps) {}

  async acquire(
    teamId: string,
    cleanupTarget?: OrcaTeamDispatchCleanupTarget,
  ): Promise<OrcaTeamDispatchLeaseRelease> {
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
        if (cleanupTarget) {
          await this.tombstoneCleanupTarget(client, teamId, cleanupTarget);
          await client.exec('COMMIT');
          transactionOpen = false;
        }
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
        if (cleanupTarget) {
          await this.tombstoneCleanupTarget(client, teamId, cleanupTarget);
          await client.exec('COMMIT');
          transactionOpen = false;
        }
        throw new Error(`ORCA_TEAM_INACTIVE: team ${teamId} has already ended`);
      }
      if (cleanupTarget) {
        const cleanupRow = await client.queryOne<{ teamId: string | null }>(
          `SELECT json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId') AS teamId
             FROM messages
            WHERE session_id = ?
              AND client_id = ?
              AND role = 'user'
              AND rewind_at IS NULL
            LIMIT 1`,
          [cleanupTarget.sessionId, cleanupTarget.clientId],
        );
        if (cleanupRow?.teamId !== teamId) {
          throw new Error(
            `ORCA_TEAM_INACTIVE: team ${teamId} pre-vendor row is no longer dispatchable`,
          );
        }
      }

      let released = false;
      return async (outcome: OrcaTeamDispatchLeaseOutcome = 'submitted') => {
        if (released) return;
        released = true;
        try {
          if (outcome === 'confirmed-undispatched' && cleanupTarget) {
            // Tombstone the exact accepted row in the same BEGIN IMMEDIATE
            // transaction that excluded terminal writers. Another Cindy
            // instance can only commit end_team after this durable rewind.
            await this.tombstoneCleanupTarget(client, teamId, cleanupTarget);
            await client.exec('COMMIT');
          } else if (outcome === 'submitted' && cleanupTarget) {
            await client.exec(
              `UPDATE messages
                  SET agent_meta = json_remove(agent_meta, '$.orcaPreVendorCleanup')
                WHERE session_id = ?
                  AND client_id = ?
                  AND role = 'user'
                  AND rewind_at IS NULL
                  AND json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId') = ?`,
              [cleanupTarget.sessionId, cleanupTarget.clientId, teamId],
            );
            await client.exec('COMMIT');
          } else {
            await this.releaseTransaction(client);
          }
        } catch (error) {
          if (this.client?.value === client) {
            await this.releaseTransaction(client);
          }
          throw error;
        } finally {
          unlock();
        }
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

  private async tombstoneCleanupTarget(
    client: IsolatedSqliteClient,
    teamId: string,
    cleanupTarget: OrcaTeamDispatchCleanupTarget,
  ): Promise<void> {
    await client.exec(
      `UPDATE messages
          SET rewind_at = ?
        WHERE session_id = ?
          AND client_id = ?
          AND role = 'user'
          AND rewind_at IS NULL
          AND json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId') = ?`,
      [Date.now(), cleanupTarget.sessionId, cleanupTarget.clientId, teamId],
    );
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
  cleanupTarget?: OrcaTeamDispatchCleanupTarget,
): Promise<OrcaTeamDispatchLeaseRelease> {
  return coordinator.acquire(teamId, cleanupTarget);
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
