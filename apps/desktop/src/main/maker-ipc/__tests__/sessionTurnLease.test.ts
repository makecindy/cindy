import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import {
  readPersistedSessionTurnLeases,
  releaseSessionTurnLease,
  replaceSessionTurnLease,
  SESSION_TURN_LEASE_CLIENT_ID_PREFIX,
  SilentStopTurnLeaseGate,
  SessionTurnLeaseTracker,
  tryAcquireSessionTurnLease,
} from '../sessionTurnLease.js';

function asLeaseClient(db: Database.Database): Pick<DbClient, 'exec' | 'query'> {
  return {
    exec: async (sql, params = []) => db.prepare(sql).run(...params),
    query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
  };
}

describe('shared-process session turn lease', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-turn-lease-'));
    const dbPath = path.join(dir, 'turn.db');
    const first = new Database(dbPath);
    first.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        active_turn_started_at INTEGER,
        last_turn_ended_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_meta TEXT,
        created_at INTEGER NOT NULL,
        rewind_at INTEGER
      );
      CREATE UNIQUE INDEX uniq_messages_session_client
        ON messages(session_id, client_id);
      INSERT INTO sessions
        (id, status, active_turn_started_at, last_turn_ended_at)
      VALUES ('source-1', 'active', 20, 10);
    `);
    const second = new Database(dbPath);
    second.pragma('foreign_keys = ON');
    cleanups.push(() => {
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return {
      first: asLeaseClient(first),
      second: asLeaseClient(second),
      raw: first,
    };
  }

  it('lets only the newest silent-stop generation own the delayed decision', () => {
    const gate = new SilentStopTurnLeaseGate();
    const firstTerminal = {};
    const duplicateFirstTerminal = {};
    const secondTerminal = {};

    expect(gate.schedule('source-1', firstTerminal, 'generation-1')).toBe(true);
    expect(gate.schedule('source-1', duplicateFirstTerminal, 'generation-1')).toBe(false);
    expect(gate.turnLeaseIdForEvent(firstTerminal)).toBe('generation-1');
    expect(gate.turnLeaseIdForEvent(duplicateFirstTerminal)).toBeUndefined();

    expect(gate.schedule('source-1', secondTerminal, 'generation-2')).toBe(true);
    expect(gate.claim('source-1', 'generation-1')).toBe(false);
    expect(gate.claim('source-1', 'generation-2')).toBe(true);
    expect(gate.claim('source-1', 'generation-2')).toBe(false);

    gate.settle('source-1', 'generation-2');
    expect(gate.schedule('source-1', {}, 'generation-2')).toBe(false);
    gate.supersede('source-1');
    expect(gate.schedule('source-1', {}, 'generation-3')).toBe(true);
  });

  it('keeps every live Desktop process observable while hiding lease rows from history', async () => {
    const { first, second, raw } = setup();
    const firstOwner = { instanceId: 'first', processId: 101 };
    const secondOwner = { instanceId: 'second', processId: 202 };

    await expect(
      tryAcquireSessionTurnLease(first, {
        sessionId: 'source-1',
        turnId: 'turn-1',
        owner: firstOwner,
        createdAt: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      tryAcquireSessionTurnLease(second, {
        sessionId: 'source-1',
        turnId: 'turn-2',
        owner: secondOwner,
        createdAt: 2,
      }),
    ).resolves.toBe(true);

    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toHaveLength(2);
    expect(
      raw
        .prepare(
          `SELECT count(*) AS count FROM messages
            WHERE client_id LIKE ? AND rewind_at IS NULL`,
        )
        .get(`${SESSION_TURN_LEASE_CLIENT_ID_PREFIX}%`),
    ).toEqual({ count: 0 });

    await releaseSessionTurnLease(first, {
      sessionId: 'source-1',
      turnId: 'turn-1',
      owner: firstOwner,
    });
    await expect(readPersistedSessionTurnLeases(second, 'source-1')).resolves.toMatchObject([
      { lease: { turnId: 'turn-2', owner: secondOwner } },
    ]);
  });

  it('uses exact CAS release so a delayed old end cannot delete a successor', async () => {
    const { first } = setup();
    const owner = { instanceId: 'first', processId: 101 };
    await tryAcquireSessionTurnLease(first, {
      sessionId: 'source-1',
      turnId: 'old-turn',
      owner,
      createdAt: 1,
    });
    await releaseSessionTurnLease(first, { sessionId: 'source-1', turnId: 'old-turn', owner });
    await tryAcquireSessionTurnLease(first, {
      sessionId: 'source-1',
      turnId: 'new-turn',
      owner,
      createdAt: 2,
    });

    await expect(
      releaseSessionTurnLease(first, { sessionId: 'source-1', turnId: 'old-turn', owner }),
    ).resolves.toBe(false);
    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toMatchObject([
      { lease: { turnId: 'new-turn' } },
    ]);
  });

  it('replaces an active generation atomically with an exact CAS update', async () => {
    const { first } = setup();
    const owner = { instanceId: 'first', processId: 101 };
    await tryAcquireSessionTurnLease(first, {
      sessionId: 'source-1',
      turnId: 'old-turn',
      owner,
      createdAt: 1,
    });

    await expect(
      replaceSessionTurnLease(first, {
        sessionId: 'source-1',
        previousTurnId: 'old-turn',
        nextTurnId: 'new-turn',
        owner,
        createdAt: 2,
      }),
    ).resolves.toBe(true);
    await expect(
      replaceSessionTurnLease(first, {
        sessionId: 'source-1',
        previousTurnId: 'old-turn',
        nextTurnId: 'stale-replacement',
        owner,
        createdAt: 3,
      }),
    ).resolves.toBe(false);
    await expect(
      releaseSessionTurnLease(first, { sessionId: 'source-1', turnId: 'old-turn', owner }),
    ).resolves.toBe(false);
    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toMatchObject([
      { lease: { turnId: 'new-turn' } },
    ]);
  });

  it('ignores a delayed tracker terminal after a newer generation replaces it', async () => {
    const { first } = setup();
    const tracker = new SessionTurnLeaseTracker({
      getDbClient: () => first,
      owner: { instanceId: 'first', processId: 101 },
      createTurnId: () => 'fallback',
      now: () => 1,
      ownerProcessEnded: () => false,
    });

    await tracker.markTurnStarted('source-1', 'generation-1');
    await tracker.markTurnStarted('source-1', 'generation-2');
    await expect(
      tracker.markTurnEndedAndCheckIdle('source-1', 'generation-1'),
    ).resolves.toBe(false);

    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toMatchObject([
      { lease: { turnId: 'generation-2' } },
    ]);
    await expect(
      tracker.markTurnEndedAndCheckIdle('source-1', 'generation-2'),
    ).resolves.toBe(true);
    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toEqual([]);
  });

  it('makes a peer turn visible until its exact lifecycle ends', async () => {
    const { first, second } = setup();
    const firstTracker = new SessionTurnLeaseTracker({
      getDbClient: () => first,
      owner: { instanceId: 'first', processId: 101 },
      createTurnId: () => 'turn-1',
      now: () => 1,
      ownerProcessEnded: () => false,
    });
    const secondTracker = new SessionTurnLeaseTracker({
      getDbClient: () => second,
      owner: { instanceId: 'second', processId: 202 },
      createTurnId: () => 'turn-2',
      now: () => 2,
      ownerProcessEnded: () => false,
    });

    await firstTracker.markTurnStarted('source-1');
    await expect(secondTracker.isTurnActive('source-1')).resolves.toBe(true);
    await firstTracker.markTurnEnded('source-1');
    await expect(secondTracker.isTurnActive('source-1')).resolves.toBe(false);
  });

  it('reclaims dead and malformed leases without acknowledging interrupted-turn markers', async () => {
    const { first, raw } = setup();
    const deadOwner = { instanceId: 'dead', processId: 303 };
    await tryAcquireSessionTurnLease(first, {
      sessionId: 'source-1',
      turnId: 'dead-turn',
      owner: deadOwner,
      createdAt: 1,
    });
    raw
      .prepare(
        `INSERT INTO messages
          (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
         VALUES ('bad-row', ?, 'source-1', 'assistant', 'null', '{bad', 2, 2)`,
      )
      .run(`${SESSION_TURN_LEASE_CLIENT_ID_PREFIX}malformed`);
    const tracker = new SessionTurnLeaseTracker({
      getDbClient: () => first,
      owner: { instanceId: 'current', processId: 404 },
      createTurnId: () => 'current-turn',
      now: () => 3,
      ownerProcessEnded: (owner) => owner.instanceId === deadOwner.instanceId,
    });

    await tracker.reconcileStaleLeases();
    await expect(tracker.isTurnActive('source-1')).resolves.toBe(false);
    expect(
      raw
        .prepare(
          `SELECT active_turn_started_at AS startedAt, last_turn_ended_at AS endedAt
             FROM sessions WHERE id = 'source-1'`,
        )
        .get(),
    ).toEqual({ startedAt: 20, endedAt: 10 });
    await expect(readPersistedSessionTurnLeases(first, 'source-1')).resolves.toEqual([]);
  });
});
