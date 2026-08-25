import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import {
  discardInvalidReviewSourceLease,
  readPersistedReviewSourceLease,
  releaseReviewSourceLease,
  REVIEW_SOURCE_LEASE_CLIENT_ID,
  tryAcquireReviewSourceLease,
} from '../reviewSourceLease.js';

function asLeaseClient(db: Database.Database): Pick<DbClient, 'exec' | 'query'> {
  return {
    exec: async (sql, params = []) => db.prepare(sql).run(...params),
    query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
  };
}

describe('Review source lease', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-review-lease-'));
    const dbPath = path.join(dir, 'review.db');
    const first = new Database(dbPath);
    first.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);
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
      INSERT INTO sessions (id, status) VALUES ('source-1', 'active'), ('source-2', 'active');
    `);
    const second = new Database(dbPath);
    second.pragma('foreign_keys = ON');
    cleanups.push(() => {
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { first: asLeaseClient(first), second: asLeaseClient(second), raw: first };
  }

  it('admits exactly one shared-database owner and allows a successor after CAS release', async () => {
    const { first, second, raw } = setup();
    const firstOwner = {
      instanceId: 'first',
      processId: 101,
      liveness: { version: 1 as const, port: 43101, token: 'first-owner-token' },
    };
    const secondOwner = { instanceId: 'second', processId: 202 };

    const acquired = await Promise.all([
      tryAcquireReviewSourceLease(first, {
        sourceSessionId: 'source-1',
        runId: 'run-1',
        owner: firstOwner,
        createdAt: 1,
      }),
      tryAcquireReviewSourceLease(second, {
        sourceSessionId: 'source-1',
        runId: 'run-2',
        owner: secondOwner,
        createdAt: 2,
      }),
    ]);
    expect(acquired.filter(Boolean)).toHaveLength(1);
    expect(
      raw
        .prepare(
          `SELECT count(*) AS count FROM messages
            WHERE client_id = ? AND rewind_at IS NULL`,
        )
        .get(REVIEW_SOURCE_LEASE_CLIENT_ID),
    ).toEqual({ count: 0 });

    const winner = acquired[0]
      ? { client: first, runId: 'run-1', owner: firstOwner }
      : { client: second, runId: 'run-2', owner: secondOwner };
    const loser = acquired[0]
      ? { client: second, runId: 'run-2', owner: secondOwner }
      : { client: first, runId: 'run-1', owner: firstOwner };
    const row = await readPersistedReviewSourceLease(second, 'source-1');
    expect(row?.lease).toMatchObject({ runId: winner.runId, owner: winner.owner });

    await expect(
      releaseReviewSourceLease(loser.client, {
        sourceSessionId: 'source-1',
        runId: loser.runId,
        owner: loser.owner,
      }),
    ).resolves.toBe(false);
    await expect(
      releaseReviewSourceLease(winner.client, {
        sourceSessionId: 'source-1',
        runId: winner.runId,
        owner: winner.owner,
      }),
    ).resolves.toBe(true);
    await expect(
      tryAcquireReviewSourceLease(loser.client, {
        sourceSessionId: 'source-1',
        runId: loser.runId,
        owner: loser.owner,
        createdAt: 3,
      }),
    ).resolves.toBe(true);
  });

  it('reads only the requested source task lease', async () => {
    const { first } = setup();
    const owner = { instanceId: 'first', processId: 101 };
    await tryAcquireReviewSourceLease(first, {
      sourceSessionId: 'source-1',
      runId: 'run-1',
      owner,
      createdAt: 1,
    });
    await tryAcquireReviewSourceLease(first, {
      sourceSessionId: 'source-2',
      runId: 'run-2',
      owner,
      createdAt: 2,
    });

    await expect(readPersistedReviewSourceLease(first, 'source-1')).resolves.toMatchObject({
      sourceSessionId: 'source-1',
      lease: { runId: 'run-1' },
    });
    await expect(readPersistedReviewSourceLease(first, 'missing')).resolves.toBeNull();
  });

  it('reclaims a malformed hidden lease by immutable row id', async () => {
    const { first, raw } = setup();
    raw
      .prepare(
        `INSERT INTO messages
        (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
       VALUES ('bad-row', ?, 'source-1', 'assistant', 'null', '{bad', 1, 1)`,
      )
      .run(REVIEW_SOURCE_LEASE_CLIENT_ID);

    const row = await readPersistedReviewSourceLease(first, 'source-1');
    expect(row?.lease).toBeNull();
    await expect(discardInvalidReviewSourceLease(first, row!)).resolves.toBe(true);
    await expect(readPersistedReviewSourceLease(first, 'source-1')).resolves.toBeNull();
  });
});
