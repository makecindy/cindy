import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDbWorkerBundle } from './dbWorkerTestUtils.js';
import { createDbClient, type DbClient } from '../client/DbClient.js';
import { messages, sessions } from '../schema.js';
import * as schema from '../schema.js';

type DrizzleDb = BetterSQLite3Database<typeof schema>;

const ITERATIONS = 1_000;
const WARMUP = 100;
// 全量 vitest 会和大量测试并发，worker 线程尾延迟会被调度噪声放大；严格性能门禁必须通过专用命令独立运行。
const STRICT_PERF_GATE = process.env.XDT_DB_PROXY_PERF_STRICT === '1';

let workerBundleDir: string | undefined;
let workerScriptPath: string;

const CREATE_TABLES = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      summary TEXT,
      provider_id TEXT,
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  `
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    )
  `,
  `CREATE INDEX idx_messages_session_created ON messages(session_id, created_at)`,
  `CREATE INDEX idx_messages_created_at ON messages(created_at, id)`,
];

interface PerfRow {
  pattern: string;
  inprocP50Ms: number;
  inprocP95Ms: number;
  proxyP50Ms: number;
  proxyP95Ms: number;
  deltaP50Ms: number;
  deltaP95Ms: number;
}

describe('MR2.2 Step 0 drizzle proxy performance baseline', () => {
  beforeAll(async () => {
    workerBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-proxy-perf-worker-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(workerBundleDir, 'build'));
  });

  afterAll(() => {
    if (workerBundleDir) {
      fs.rmSync(workerBundleDir, { recursive: true, force: true });
    }
  });

  it('records proxy overhead and gates strict perf when requested', async () => {
    const inprocSqlite = new Database(':memory:');
    const client = await createDbClient({
      workerScriptPath,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
    });
    try {
      await setupSqlite(inprocSqlite);
      await setupClient(client);
      const inproc = drizzle(inprocSqlite, { schema });
      const proxy = client.drizzle;

      const contextCreatedAt = Array.from({ length: 10 }, (_, i) => 10_000 + i * 10);
      const cases: Array<{
        pattern: string;
        inproc: () => unknown | Promise<unknown>;
        proxy: () => unknown | Promise<unknown>;
      }> = [
        {
          pattern: 'select-by-pk',
          inproc: () => inproc.select().from(sessions).where(eq(sessions.id, 's-1')).limit(1).all(),
          proxy: () => proxy.select().from(sessions).where(eq(sessions.id, 's-1')).limit(1).all(),
        },
        {
          pattern: 'select-list-paginated',
          inproc: () =>
            inproc
              .select()
              .from(messages)
              .where(eq(messages.sessionId, 's-1'))
              .orderBy(desc(messages.createdAt))
              .limit(20)
              .all(),
          proxy: () =>
            proxy
              .select()
              .from(messages)
              .where(eq(messages.sessionId, 's-1'))
              .orderBy(desc(messages.createdAt))
              .limit(20)
              .all(),
        },
        {
          pattern: 'select-with-join',
          inproc: () =>
            inproc
              .select({
                messageId: messages.id,
                title: sessions.title,
              })
              .from(messages)
              .innerJoin(sessions, eq(messages.sessionId, sessions.id))
              .where(eq(messages.sessionId, 's-1'))
              .limit(20)
              .all(),
          proxy: () =>
            proxy
              .select({
                messageId: messages.id,
                title: sessions.title,
              })
              .from(messages)
              .innerJoin(sessions, eq(messages.sessionId, sessions.id))
              .where(eq(messages.sessionId, 's-1'))
              .limit(20)
              .all(),
        },
        {
          pattern: 'insert-single',
          inproc: () => insertSession(inproc, 'inproc-insert'),
          proxy: () => insertSession(proxy, 'proxy-insert'),
        },
        {
          pattern: 'update',
          inproc: () =>
            inproc
              .update(sessions)
              .set({ updatedAt: Date.now() })
              .where(eq(sessions.id, 's-1'))
              .run(),
          proxy: () =>
            proxy
              .update(sessions)
              .set({ updatedAt: Date.now() })
              .where(eq(sessions.id, 's-1'))
              .run(),
        },
        {
          pattern: 'chatHistorySearch.fetchContextWindow',
          inproc: () => fetchContextWindowPattern(inproc, contextCreatedAt),
          proxy: () => fetchContextWindowPattern(proxy, contextCreatedAt),
        },
      ];

      const results: PerfRow[] = [];
      for (const benchCase of cases) {
        const stats = await measurePaired(benchCase.inproc, benchCase.proxy);
        results.push({
          pattern: benchCase.pattern,
          inprocP50Ms: round(stats.inproc.p50),
          inprocP95Ms: round(stats.inproc.p95),
          proxyP50Ms: round(stats.proxy.p50),
          proxyP95Ms: round(stats.proxy.p95),
          deltaP50Ms: round(stats.delta.p50),
          deltaP95Ms: round(stats.delta.p95),
        });
      }

      process.stdout.write(
        `\nMR2.2 drizzle proxy perf baseline (strictGate=${STRICT_PERF_GATE ? 'enabled' : 'disabled'})\n${JSON.stringify(results, null, 2)}\n`,
      );

      for (const row of results) {
        expect(Number.isFinite(row.deltaP50Ms), `${row.pattern} p50 sample`).toBe(true);
        expect(Number.isFinite(row.deltaP95Ms), `${row.pattern} p95 sample`).toBe(true);
        if (!STRICT_PERF_GATE) {
          continue;
        }
        if (row.pattern === 'chatHistorySearch.fetchContextWindow') {
          expect(row.deltaP50Ms, `${row.pattern} waived p50 regression`).toBeLessThan(5);
          expect(row.deltaP95Ms, `${row.pattern} p95 regression`).toBeLessThan(10);
          continue;
        }
        expect(row.deltaP50Ms, `${row.pattern} p50 regression`).toBeLessThan(2);
        expect(row.deltaP95Ms, `${row.pattern} p95 regression`).toBeLessThan(10);
      }
    } finally {
      await client.dispose();
      inprocSqlite.close();
    }
  }, 120_000);
});

async function setupSqlite(db: Database.Database): Promise<void> {
  for (const ddl of CREATE_TABLES) db.exec(ddl);
  const insertSessionStmt = db.prepare(`
    INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
      context_window, fast_mode, cleared_at, pinned_at, user_send_at,
      agent_kind, workspace_kind, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (id, client_id, session_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < 20; i += 1) {
      insertSessionStmt.run(
        `s-${i}`,
        `Session ${i}`,
        `D:/work/${i}`,
        'claude-sonnet-4-6',
        'high',
        'ask',
        'active',
        `sdk-${i}`,
        0,
        0,
        0,
        0,
        0,
        null,
        null,
        1_000 + i,
        'cc',
        'project',
        1_000 + i,
        1_000 + i,
      );
    }
    for (let i = 0; i < 1_200; i += 1) {
      insertMessageStmt.run(
        `m-${i}`,
        `c-${i}`,
        's-1',
        i % 2 === 0 ? 'user' : 'assistant',
        JSON.stringify({ text: `message ${i}` }),
        10_000 + i,
      );
    }
  });
  tx();
}

async function setupClient(client: DbClient): Promise<void> {
  for (const ddl of CREATE_TABLES) await client.exec(ddl);
  await setupViaExec(client);
}

async function setupViaExec(client: DbClient): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await client.exec(
      `INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, workspace_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `s-${i}`,
        `Session ${i}`,
        `D:/work/${i}`,
        'claude-sonnet-4-6',
        'high',
        'ask',
        'active',
        `sdk-${i}`,
        0,
        0,
        0,
        0,
        0,
        null,
        null,
        1_000 + i,
        'cc',
        'project',
        1_000 + i,
        1_000 + i,
      ],
    );
  }
  for (let i = 0; i < 1_200; i += 1) {
    await client.exec(
      `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `m-${i}`,
        `c-${i}`,
        's-1',
        i % 2 === 0 ? 'user' : 'assistant',
        JSON.stringify({ text: `message ${i}` }),
        10_000 + i,
      ],
    );
  }
}

function insertSession(db: DrizzleDb, prefix: string) {
  const id = `${prefix}-${performance.now()}`;
  return db
    .insert(sessions)
    .values({
      id,
      title: id,
      workingDir: null,
      model: 'claude-sonnet-4-6',
      effort: 'high',
      permissionMode: 'ask',
      status: 'active',
      sdkSessionId: null,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: false,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: null,
      agentKind: 'cc',
      workspaceKind: 'project',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

async function fetchContextWindowPattern(db: DrizzleDb, createdAts: number[]) {
  for (const createdAt of createdAts) {
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, 's-1'), lt(messages.createdAt, createdAt)))
      .orderBy(desc(messages.createdAt))
      .limit(5)
      .all();
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, 's-1'), eq(messages.createdAt, createdAt)))
      .limit(1)
      .all();
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, 's-1'), gt(messages.createdAt, createdAt)))
      .orderBy(asc(messages.createdAt))
      .limit(5)
      .all();
  }
}

async function measurePaired(
  inproc: () => unknown | Promise<unknown>,
  proxy: () => unknown | Promise<unknown>,
): Promise<{
  inproc: { p50: number; p95: number };
  proxy: { p50: number; p95: number };
  delta: { p50: number; p95: number };
}> {
  for (let i = 0; i < WARMUP; i += 1) {
    await inproc();
    await proxy();
  }

  const inprocSamples: number[] = [];
  const proxySamples: number[] = [];
  const deltaSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const [inprocMs, proxyMs] =
      i % 2 === 0
        ? [await measureOne(inproc), await measureOne(proxy)]
        : await measureProxyThenInproc(inproc, proxy);
    inprocSamples.push(inprocMs);
    proxySamples.push(proxyMs);
    deltaSamples.push(proxyMs - inprocMs);
  }

  inprocSamples.sort((a, b) => a - b);
  proxySamples.sort((a, b) => a - b);
  deltaSamples.sort((a, b) => a - b);
  return {
    inproc: {
      p50: percentile(inprocSamples, 50),
      p95: percentile(inprocSamples, 95),
    },
    proxy: {
      p50: percentile(proxySamples, 50),
      p95: percentile(proxySamples, 95),
    },
    delta: {
      p50: percentile(deltaSamples, 50),
      p95: percentile(deltaSamples, 95),
    },
  };
}

async function measureProxyThenInproc(
  inproc: () => unknown | Promise<unknown>,
  proxy: () => unknown | Promise<unknown>,
): Promise<[number, number]> {
  const proxyMs = await measureOne(proxy);
  const inprocMs = await measureOne(inproc);
  return [inprocMs, proxyMs];
}

async function measureOne(fn: () => unknown | Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function percentile(samples: number[], percentileValue: number): number {
  const index = Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * samples.length) - 1),
  );
  return samples[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
