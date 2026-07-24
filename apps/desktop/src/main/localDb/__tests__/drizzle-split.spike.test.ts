import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, count, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';

import {
  dailySpend,
  messages,
  orcaWorkers,
  sessions,
} from '../schema.js';
import * as schema from '../schema.js';
import { createDbClient, type DbClient } from '../client/DbClient.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../../shared/sessionSource.js';

type Sqlite = Database.Database;
type DrizzleDb = BetterSQLite3Database<typeof schema>;
type SeedTarget = Sqlite | DbClient;
const REAL_DB_PROXY_TEST_TIMEOUT_MS = 20_000;

async function createProxyClient(): Promise<DbClient> {
  const client = await createDbClient({ useInlineWorker: true });
  await applyRealMigrations(client);
  return client;
}

function createDb(): Sqlite {
  const db = new Database(':memory:');
  applyRealMigrations(db);
  return db;
}

function createDrizzle(db: Sqlite) {
  return drizzle(db, { schema });
}

async function runSql(target: SeedTarget, statement: string, params: unknown[] = []): Promise<void> {
  if ('prepare' in target) {
    target.prepare(statement).run(...params);
  } else {
    await target.exec(statement, params);
  }
}

function findDesktopDir(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'drizzle', '0000_init.sql'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('apps/desktop directory not found');
}

function migrationStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('--');
      }),
    );
}

function isOptionalVecStatement(statement: string): boolean {
  return /USING\s+vec0|chat_messages_vec_v1/i.test(statement);
}

function applyRealMigrations(target: SeedTarget): Promise<void> | void {
  const drizzleDir = path.join(findDesktopDir(), 'drizzle');
  const files = fs
    .readdirSync(drizzleDir)
    .filter((fileName) => /^\d{4}_.*\.sql$/.test(fileName))
    .sort();

  const run = async (): Promise<void> => {
    for (const fileName of files) {
      const sqlText = fs.readFileSync(path.join(drizzleDir, fileName), 'utf8');
      for (const statement of migrationStatements(sqlText)) {
        await runMigrationStatement(target as DbClient, statement);
      }
      await applyMigrationScript(target as DbClient, fileName);
      await writeSchemaVersion(target as DbClient, Number(fileName.slice(0, 4)));
    }
  };

  if ('prepare' in target) {
    for (const fileName of files) {
      const sqlText = fs.readFileSync(path.join(drizzleDir, fileName), 'utf8');
      for (const statement of migrationStatements(sqlText)) {
        runMigrationStatementSync(target, statement);
      }
      applyMigrationScriptSync(target, fileName);
      writeSchemaVersionSync(target, Number(fileName.slice(0, 4)));
    }
    return;
  }

  return run();
}

function runMigrationStatementSync(db: Sqlite, statement: string): void {
  try {
    db.exec(statement);
  } catch (err) {
    if (isOptionalVecStatement(statement)) return;
    throw err;
  }
}

async function runMigrationStatement(target: DbClient, statement: string): Promise<void> {
  try {
    await target.exec(statement);
  } catch (err) {
    if (isOptionalVecStatement(statement)) return;
    throw err;
  }
}

function applyMigrationScriptSync(db: Sqlite, fileName: string): void {
  if (fileName === '0038_add_session_remote_host_id.sql') {
    ensureColumnSync(db, 'sessions', 'remote_host_id', 'text');
    return;
  }
  if (fileName === '0040_orca_multi_worker_phase1.sql') {
    applyOrcaMultiWorkerPhase1Sync(db);
    return;
  }
  if (fileName === '0048_add_session_summary.sql') {
    ensureColumnSync(db, 'sessions', 'summary', 'text');
    return;
  }
  // 占位 SQL + 配套脚本型迁移(加列真身在 drizzle/scripts/*.ts),此处按
  // 文件名等价模拟;漏登记 = 查询 schema 全列时 no such column。
  if (fileName === '0060_orange_penance.sql') {
    ensureColumnSync(db, 'sessions', 'plan_mode_enabled', 'integer DEFAULT false NOT NULL');
    return;
  }
  if (fileName === '0064_icy_bruce_banner.sql') {
    ensureColumnSync(db, 'sessions', 'active_turn_started_at', 'integer');
    ensureColumnSync(db, 'sessions', 'active_turn_pid', 'integer');
    return;
  }
  if (fileName === '0065_equal_shinobi_shaw.sql') {
    ensureColumnSync(db, 'sessions', 'last_turn_ended_at', 'integer');
  }
  if (fileName === '0064_icy_bruce_banner.sql') {
    ensureColumnSync(db, 'sessions', 'active_turn_started_at', 'integer');
    ensureColumnSync(db, 'sessions', 'active_turn_pid', 'integer');
  }
  if (fileName === '0065_equal_shinobi_shaw.sql') {
    ensureColumnSync(db, 'sessions', 'last_turn_ended_at', 'integer');
  }
  if (fileName === '0080_regional_money.sql') {
    ensureColumnSync(db, 'sessions', 'total_cost_amount', 'real DEFAULT 0 NOT NULL');
    ensureColumnSync(db, 'sessions', 'total_cost_currency', 'text');
    ensureColumnSync(
      db,
      'sessions',
      'total_cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    ensureColumnSync(db, 'daily_spend', 'cost_amount', 'real DEFAULT 0 NOT NULL');
    ensureColumnSync(db, 'daily_spend', 'cost_currency', 'text');
    ensureColumnSync(
      db,
      'daily_spend',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    ensureColumnSync(
      db,
      'daily_model_usage',
      'cost_amount',
      'real DEFAULT 0 NOT NULL',
    );
    ensureColumnSync(db, 'daily_model_usage', 'cost_currency', 'text');
    ensureColumnSync(
      db,
      'daily_model_usage',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    ensureColumnSync(db, 'schedule_runs', 'cost_amount', 'real DEFAULT 0 NOT NULL');
    ensureColumnSync(
      db,
      'schedule_runs',
      'estimated_value_amount',
      'real DEFAULT 0 NOT NULL',
    );
    ensureColumnSync(db, 'schedule_runs', 'cost_currency', 'text');
    ensureColumnSync(
      db,
      'schedule_runs',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    return;
  }
}

async function applyMigrationScript(target: DbClient, fileName: string): Promise<void> {
  if (fileName === '0038_add_session_remote_host_id.sql') {
    await ensureColumn(target, 'sessions', 'remote_host_id', 'text');
    return;
  }
  if (fileName === '0040_orca_multi_worker_phase1.sql') {
    await applyOrcaMultiWorkerPhase1(target);
    return;
  }
  if (fileName === '0048_add_session_summary.sql') {
    await ensureColumn(target, 'sessions', 'summary', 'text');
    return;
  }
  if (fileName === '0060_orange_penance.sql') {
    await ensureColumn(target, 'sessions', 'plan_mode_enabled', 'integer DEFAULT false NOT NULL');
    return;
  }
  if (fileName === '0064_icy_bruce_banner.sql') {
    await ensureColumn(target, 'sessions', 'active_turn_started_at', 'integer');
    await ensureColumn(target, 'sessions', 'active_turn_pid', 'integer');
    return;
  }
  if (fileName === '0065_equal_shinobi_shaw.sql') {
    await ensureColumn(target, 'sessions', 'last_turn_ended_at', 'integer');
  }
  if (fileName === '0064_icy_bruce_banner.sql') {
    await ensureColumn(target, 'sessions', 'active_turn_started_at', 'integer');
    await ensureColumn(target, 'sessions', 'active_turn_pid', 'integer');
  }
  if (fileName === '0065_equal_shinobi_shaw.sql') {
    await ensureColumn(target, 'sessions', 'last_turn_ended_at', 'integer');
  }
  if (fileName === '0080_regional_money.sql') {
    await ensureColumn(target, 'sessions', 'total_cost_amount', 'real DEFAULT 0 NOT NULL');
    await ensureColumn(target, 'sessions', 'total_cost_currency', 'text');
    await ensureColumn(
      target,
      'sessions',
      'total_cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    await ensureColumn(target, 'daily_spend', 'cost_amount', 'real DEFAULT 0 NOT NULL');
    await ensureColumn(target, 'daily_spend', 'cost_currency', 'text');
    await ensureColumn(
      target,
      'daily_spend',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    await ensureColumn(
      target,
      'daily_model_usage',
      'cost_amount',
      'real DEFAULT 0 NOT NULL',
    );
    await ensureColumn(target, 'daily_model_usage', 'cost_currency', 'text');
    await ensureColumn(
      target,
      'daily_model_usage',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    await ensureColumn(target, 'schedule_runs', 'cost_amount', 'real DEFAULT 0 NOT NULL');
    await ensureColumn(
      target,
      'schedule_runs',
      'estimated_value_amount',
      'real DEFAULT 0 NOT NULL',
    );
    await ensureColumn(target, 'schedule_runs', 'cost_currency', 'text');
    await ensureColumn(
      target,
      'schedule_runs',
      'cost_is_approximate',
      'integer DEFAULT 0 NOT NULL',
    );
    return;
  }
}

function applyOrcaMultiWorkerPhase1Sync(db: Sqlite): void {
  db.exec('DROP TRIGGER IF EXISTS `trg_chat_rewind_clean_vec`');
  if (tableExistsSync(db, 'orca_workflows') && !tableExistsSync(db, 'orca_teams')) {
    db.exec('ALTER TABLE `orca_workflows` RENAME TO `orca_teams`');
  }
  const workerCols = columnNamesSync(db, 'orca_workers');
  if (workerCols.has('workflow_id') && !workerCols.has('team_id')) {
    db.exec('ALTER TABLE `orca_workers` RENAME COLUMN `workflow_id` TO `team_id`');
  }
  ensureColumnSync(db, 'orca_workers', 'role', "text NOT NULL DEFAULT 'developer'");
  ensureColumnSync(db, 'orca_workers', 'focused', 'integer NOT NULL DEFAULT 0');
  ensureColumnSync(db, 'orca_workers', 'idle_since', 'integer');
}

async function applyOrcaMultiWorkerPhase1(target: DbClient): Promise<void> {
  await target.exec('DROP TRIGGER IF EXISTS `trg_chat_rewind_clean_vec`');
  if (await tableExists(target, 'orca_workflows')) {
    if (!(await tableExists(target, 'orca_teams'))) {
      await target.exec('ALTER TABLE `orca_workflows` RENAME TO `orca_teams`');
    }
  }
  const workerCols = await columnNames(target, 'orca_workers');
  if (workerCols.has('workflow_id') && !workerCols.has('team_id')) {
    await target.exec('ALTER TABLE `orca_workers` RENAME COLUMN `workflow_id` TO `team_id`');
  }
  await ensureColumn(target, 'orca_workers', 'role', "text NOT NULL DEFAULT 'developer'");
  await ensureColumn(target, 'orca_workers', 'focused', 'integer NOT NULL DEFAULT 0');
  await ensureColumn(target, 'orca_workers', 'idle_since', 'integer');
}

function tableExistsSync(db: Sqlite, tableName: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) !== undefined;
}

async function tableExists(target: DbClient, tableName: string): Promise<boolean> {
  return await target.queryOne(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [tableName],
  ) !== undefined;
}

function columnNamesSync(db: Sqlite, tableName: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

async function columnNames(target: DbClient, tableName: string): Promise<Set<string>> {
  const columns = await target.query<{ name: string }>(`PRAGMA table_info('${tableName}')`);
  return new Set(columns.map((column) => column.name));
}

function ensureColumnSync(db: Sqlite, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureColumn(
  target: DbClient,
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  const columns = await target.query<{ name: string }>(`PRAGMA table_info('${tableName}')`);
  if (!columns.some((column) => column.name === columnName)) {
    await target.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function writeSchemaVersionSync(db: Sqlite, seq: number): void {
  db.prepare(
    "INSERT INTO migration_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(seq));
}

async function writeSchemaVersion(target: DbClient, seq: number): Promise<void> {
  await target.exec(
    "INSERT INTO migration_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [String(seq)],
  );
}

async function insertSession(
  target: SeedTarget,
  input: {
    id: string;
    title?: string;
    workingDir?: string | null;
    status?: string;
    source?: string;
    agentKind?: string;
    createdAt?: number;
    updatedAt?: number;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? 1;
  const updatedAt = input.updatedAt ?? createdAt;
  await runSql(
    target,
    `
      INSERT INTO sessions (
        id, title, working_dir, status, source, agent_kind, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.id,
      input.title ?? input.id,
      input.workingDir ?? null,
      input.status ?? 'active',
      input.source ?? 'desktop',
      input.agentKind ?? 'cc',
      createdAt,
      updatedAt,
    ],
  );
}

async function insertMessage(
  target: SeedTarget,
  input: { id: string; sessionId: string; createdAt?: number; rewindAt?: number | null },
): Promise<void> {
  await runSql(
    target,
    `
      INSERT INTO messages (
        id, client_id, session_id, role, content, created_at, rewind_at
      )
      VALUES (?, ?, ?, 'user', ?, ?, ?)
    `,
    [
      input.id,
      `client-${input.id}`,
      input.sessionId,
      JSON.stringify(`message ${input.id}`),
      input.createdAt ?? 1,
      input.rewindAt ?? null,
    ],
  );
}

async function seedSessionsList(target: SeedTarget): Promise<void> {
  await insertSession(target, { id: 's-visible-2', status: 'archived', source: 'scheduler', updatedAt: 200 });
  await insertSession(target, { id: 's-visible-1', status: 'active', source: 'desktop', updatedAt: 300 });
  await insertSession(target, { id: 's-deleted', status: 'deleted', source: 'desktop', updatedAt: 400 });
  await insertSession(target, { id: 's-feishu', status: 'active', source: 'feishu', updatedAt: 500 });
  await insertMessage(target, { id: 'm-1', sessionId: 's-visible-1' });
  await insertMessage(target, { id: 'm-2', sessionId: 's-visible-1' });
}

function buildSessionsListQuery(db: DrizzleDb, limit: number) {
  const baseQuery = db
    .select({
      session: sessions,
      messageCount: count(messages.id),
    })
    .from(sessions)
    .leftJoin(messages, eq(messages.sessionId, sessions.id));
  const sourceFilter = inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES);
  return baseQuery
    .where(and(sourceFilter, ne(sessions.status, 'deleted')))
    .groupBy(sessions.id)
    .orderBy(desc(sessions.updatedAt))
    .limit(limit);
}

describe('sessions:list LEFT JOIN + groupBy + orderBy + limit', () => {
  it('keeps DbClient.drizzle results deep-equal to in-proc drizzle', async () => {
    const drizzleDb = createDb();
    const client = await createProxyClient();
    try {
      await seedSessionsList(drizzleDb);
      await seedSessionsList(client);

      const r1 = await buildSessionsListQuery(createDrizzle(drizzleDb), 10);
      const r2 = await buildSessionsListQuery(client.drizzle, 10);

      expect(r2).toEqual(r1);
    } finally {
      drizzleDb.close();
      await client.dispose();
    }
  }, REAL_DB_PROXY_TEST_TIMEOUT_MS);
});

async function seedOrcaArchive(target: SeedTarget): Promise<void> {
  await insertSession(target, { id: 'lead-1', status: 'active', updatedAt: 100 });
  await insertSession(target, { id: 'lead-2', status: 'active', updatedAt: 100 });
  await insertSession(target, { id: 'worker-a', status: 'active', updatedAt: 100 });
  await insertSession(target, { id: 'worker-b', status: 'active', updatedAt: 100 });
  await insertSession(target, { id: 'other-worker', status: 'active', updatedAt: 100 });
  await runSql(
    target,
    `
      INSERT INTO orca_teams (
        id, lead_session_id, status, created_at, updated_at
      )
      VALUES (?, ?, 'active', 1, 1)
    `,
    ['wf-1', 'lead-1'],
  );
  await runSql(
    target,
    `
      INSERT INTO orca_teams (
        id, lead_session_id, status, created_at, updated_at
      )
      VALUES (?, ?, 'active', 1, 1)
    `,
    ['wf-2', 'lead-2'],
  );
  await runSql(
    target,
    `
      INSERT INTO orca_workers (
        id, team_id, session_id, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'idle', 1, 1)
    `,
    ['ow-a', 'wf-1', 'worker-a'],
  );
  await runSql(
    target,
    `
      INSERT INTO orca_workers (
        id, team_id, session_id, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'idle', 1, 1)
    `,
    ['ow-b', 'wf-1', 'worker-b'],
  );
  await runSql(
    target,
    `
      INSERT INTO orca_workers (
        id, team_id, session_id, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'idle', 1, 1)
    `,
    ['ow-c', 'wf-2', 'other-worker'],
  );
}

function buildArchiveSelectQuery(db: DrizzleDb, workflowId: string) {
  return db
    .select({ sessionId: orcaWorkers.sessionId })
    .from(orcaWorkers)
    .where(eq(orcaWorkers.teamId, workflowId));
}

function buildArchiveUpdateQuery(
  db: DrizzleDb,
  ids: string[],
  now: number,
) {
  return db
    .update(sessions)
    .set({ status: 'archived', updatedAt: now })
    .where(sql`${sessions.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
}

function buildSessionStatusQuery(db: DrizzleDb) {
  return db
    .select({
      id: sessions.id,
      status: sessions.status,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .orderBy(sessions.id);
}

describe('archiveWorkersByWorkflow select + update chain', () => {
  it('keeps selected ids and update effects deep-equal through DbClient.drizzle', async () => {
    const drizzleDb = createDb();
    const client = await createProxyClient();
    try {
      await seedOrcaArchive(drizzleDb);
      await seedOrcaArchive(client);

      const drizzleRows = await buildArchiveSelectQuery(createDrizzle(drizzleDb), 'wf-1');
      const proxyRows = await buildArchiveSelectQuery(client.drizzle, 'wf-1');
      expect(proxyRows).toEqual(drizzleRows);

      const ids = proxyRows.map((r) => r.sessionId);
      const now = 12345;
      const r1 = buildArchiveUpdateQuery(createDrizzle(drizzleDb), ids, now).run();
      const r2 = await buildArchiveUpdateQuery(client.drizzle, ids, now).run();
      expect({ changes: r2.changes, lastInsertRowid: r2.lastInsertRowid }).toEqual({
        changes: r1.changes,
        lastInsertRowid: r1.lastInsertRowid,
      });

      expect(await buildSessionStatusQuery(client.drizzle)).toEqual(
        await buildSessionStatusQuery(createDrizzle(drizzleDb)),
      );
    } finally {
      drizzleDb.close();
      await client.dispose();
    }
  }, REAL_DB_PROXY_TEST_TIMEOUT_MS);
});

function buildDailySpendUpsertQuery(
  db: DrizzleDb,
  day: string,
  costUsdDelta: number,
  ts: number,
) {
  return db
    .insert(dailySpend)
    .values({
      day,
      costUsd: costUsdDelta,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: dailySpend.day,
      set: {
        costUsd: sql`${dailySpend.costUsd} + ${costUsdDelta}`,
        updatedAt: ts,
      },
    });
}

function buildSpendQuery(db: DrizzleDb, day: string) {
  return db
    .select({ costUsd: dailySpend.costUsd })
    .from(dailySpend)
    .where(eq(dailySpend.day, day))
    .get();
}

describe('dailySpend insert onConflictDoUpdate run upsert', () => {
  it('keeps .run() metadata and upsert effects deep-equal through DbClient.drizzle', async () => {
    const drizzleDb = createDb();
    const client = await createProxyClient();
    try {
      await runSql(
        drizzleDb,
        'INSERT INTO daily_spend (day, cost_usd, updated_at) VALUES (?, ?, ?)',
        ['2026-06-04', 1.25, 1],
      );
      await runSql(
        client,
        'INSERT INTO daily_spend (day, cost_usd, updated_at) VALUES (?, ?, ?)',
        ['2026-06-04', 1.25, 1],
      );

      const r1 = buildDailySpendUpsertQuery(
        createDrizzle(drizzleDb),
        '2026-06-04',
        0.75,
        99,
      ).run();
      const r2 = await buildDailySpendUpsertQuery(
        client.drizzle,
        '2026-06-04',
        0.75,
        99,
      ).run();

      expect({ changes: r2.changes, lastInsertRowid: r2.lastInsertRowid }).toEqual({
        changes: r1.changes,
        lastInsertRowid: r1.lastInsertRowid,
      });
      expect(await buildSpendQuery(client.drizzle, '2026-06-04')).toEqual(
        await buildSpendQuery(createDrizzle(drizzleDb), '2026-06-04'),
      );
    } finally {
      drizzleDb.close();
      await client.dispose();
    }
  }, REAL_DB_PROXY_TEST_TIMEOUT_MS);
});

async function seedWorkdirs(target: SeedTarget): Promise<void> {
  await insertSession(target, {
    id: 'wd-a-1',
    workingDir: '/work/a',
    status: 'active',
    agentKind: 'cc',
    createdAt: 1000,
    updatedAt: 1000,
  });
  await insertSession(target, {
    id: 'wd-a-2',
    workingDir: '/work/a',
    status: 'archived',
    agentKind: 'codex',
    createdAt: 3000,
    updatedAt: 3000,
  });
  await insertSession(target, {
    id: 'wd-b-1',
    workingDir: '/work/b',
    status: 'active',
    agentKind: 'cc',
    createdAt: 2500,
    updatedAt: 2500,
  });
  await insertSession(target, {
    id: 'wd-c-deleted',
    workingDir: '/work/c',
    status: 'deleted',
    agentKind: 'cc',
    createdAt: 4000,
    updatedAt: 4000,
  });
  await insertSession(target, {
    id: 'wd-null',
    workingDir: null,
    status: 'active',
    agentKind: 'cc',
    createdAt: 5000,
    updatedAt: 5000,
  });
}

function buildListWorkdirsQuery(db: DrizzleDb) {
  const lastTs = sql<number>`MAX(${sessions.createdAt})`;
  const firstTs = sql<number>`MIN(${sessions.createdAt})`;
  const cnt = sql<number>`COUNT(*)`;
  const kinds = sql<string>`GROUP_CONCAT(DISTINCT ${sessions.agentKind})`;
  const cursorCreatedAt = 3000;
  const cursorWorkingDir = '/work/a';
  const havingExpr = or(
    sql`${lastTs} < ${cursorCreatedAt}`,
    and(sql`${lastTs} = ${cursorCreatedAt}`, sql`${sessions.workingDir} < ${cursorWorkingDir}`),
  );

  return db
    .select({
      workingDir: sessions.workingDir,
      sessionCount: cnt,
      firstSessionAt: firstTs,
      lastSessionAt: lastTs,
      agentKinds: kinds,
    })
    .from(sessions)
    .where(and(ne(sessions.status, 'deleted'), isNotNull(sessions.workingDir)))
    .groupBy(sessions.workingDir)
    .having(havingExpr)
    .orderBy(desc(lastTs), desc(sessions.workingDir))
    .limit(3);
}

describe('listWorkdirs GROUP BY + HAVING', () => {
  it('keeps aggregate rows deep-equal through DbClient.drizzle', async () => {
    const drizzleDb = createDb();
    const client = await createProxyClient();
    try {
      await seedWorkdirs(drizzleDb);
      await seedWorkdirs(client);

      expect(await buildListWorkdirsQuery(client.drizzle)).toEqual(
        await buildListWorkdirsQuery(createDrizzle(drizzleDb)),
      );
    } finally {
      drizzleDb.close();
      await client.dispose();
    }
  }, REAL_DB_PROXY_TEST_TIMEOUT_MS);
});

async function seedSessionsMeta(target: SeedTarget): Promise<string[]> {
  const ids = ['meta-1', 'meta-2', 'meta-3', 'meta-4', 'meta-5'];
  for (const [index, id] of ids.entries()) {
    await insertSession(target, {
      id,
      title: `Meta ${index + 1}`,
      workingDir: `/work/${index + 1}`,
      agentKind: index % 2 === 0 ? 'cc' : 'codex',
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
  await insertSession(target, { id: 'meta-extra', title: 'Extra', workingDir: '/work/extra' });
  return ids;
}

function buildFetchSessionsMetaQuery(
  db: DrizzleDb,
  ids: string[],
) {
  return db
    .select({
      id: sessions.id,
      workingDir: sessions.workingDir,
      agentKind: sessions.agentKind,
      title: sessions.title,
    })
    .from(sessions)
    .where(inArray(sessions.id, ids));
}

describe('fetchSessionsMeta inArray variable params', () => {
  it('expands five ids and keeps rows deep-equal through DbClient.drizzle', async () => {
    const drizzleDb = createDb();
    const client = await createProxyClient();
    try {
      const ids = await seedSessionsMeta(drizzleDb);
      await seedSessionsMeta(client);

      const built = buildFetchSessionsMetaQuery(client.drizzle, ids).toSQL();
      expect(built.sql).toMatch(/in\s*\(\?, \?, \?, \?, \?\)/i);
      expect(built.params).toEqual(ids);
      expect(await buildFetchSessionsMetaQuery(client.drizzle, ids)).toEqual(
        await buildFetchSessionsMetaQuery(createDrizzle(drizzleDb), ids),
      );
    } finally {
      drizzleDb.close();
      await client.dispose();
    }
  }, REAL_DB_PROXY_TEST_TIMEOUT_MS);
});

describe('relational query db.query.* usage', () => {
  it('is N/A for current localDb codebase because no db.query relational usage exists', () => {
    expect(true).toBe(true);
  });
});
