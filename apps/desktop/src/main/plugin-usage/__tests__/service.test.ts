import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { buildDbWorkerBundle } from '../../localDb/__tests__/dbWorkerTestUtils';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginUsageService } from '../service';
import { runPluginUsageTransaction } from '../../localDb/worker/opHandlers/pluginUsageTx';
import { createDbClient, type DbClient } from '../../localDb/client/DbClient';
import type { PluginUsageIdentity } from '../../../shared/pluginUsage';
import type { PluginUsageReporting } from '../reporter';
import { registerPluginUsageIpc } from '../ipc';
import { withGhostInstallLock } from '../../cindy-brain/ghostInstallLock';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const identity: PluginUsageIdentity = {
  ghostId: 'test-plugin',
  displayName: 'Test',
  revision: 'rev1',
  sourceKind: 'manual',
  stableKey: null,
  pluginId: null,
  organizationId: null,
  sourceKey: null,
  serverRoot: null,
  version: '1.0',
  releaseId: null,
};
const migration = readFileSync(
  new URL('../../../../drizzle/0128_demonic_odin.sql', import.meta.url),
  'utf8',
) + '\n--> statement-breakpoint\n' + readFileSync(new URL('../../../../drizzle/0132_abnormal_dazzler.sql', import.meta.url), 'utf8');
const now = Date.UTC(2026, 9, 12, 12);
const week = 168 * 60 * 60 * 1000;
let db: Database.Database;
let service: PluginUsageService;
let ownerCurrent: boolean;
let clock: number;
let client: DbClient;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(migration);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT,status TEXT)');
  client = {
    tx: async (_name: string, args: unknown) => runPluginUsageTransaction(db, args),
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  } as DbClient;
  ownerCurrent = true;
  clock = now;
  service = new PluginUsageService({
    client,
    isCurrent: () => ownerCurrent,
    now: () => clock,
    deviceName: 'Test Mac',
    warn: vi.fn(),
  });
});
afterEach(async () => {
  await service.close();
  vi.useRealTimers();
  db.close();
});
const capture = () => service.capture(identity)!;

// 通用调用统计：同一宿主调用的工具派发及投递共享身份，旧工具记录保留类型。
// 现有 fixture 只覆盖工具派发；最小回归是两次接受同一个真实宿主 ID。
it('records invocation kinds without counting a tool and its child delivery twice', async () => {
  await service.bind(identity);
  const handle = capture();
  service.accept(handle, 'parent-root', 'run', null, now - 2, 'tool');
  service.accept(handle, 'parent-root', 'tasks.send', 'task', now - 1, 'execution');
  service.accept(handle, 'tool-root', 'status', null, now - 1);
  expect((await service.summary(handle.subjectId))?.totalCalls).toBe(2);
  expect(db.prepare('SELECT call_id,entry_kind FROM plugin_usage_events ORDER BY call_id').all()).toEqual([
    { call_id: 'parent-root', entry_kind: 'tool' },
    { call_id: 'tool-root', entry_kind: 'tool' },
  ]);
});

it('keeps one SQLite subject when a detail request overlaps the committed local upgrade', async () => {
  await service.bind(identity);
  const old = capture();
  service.accept(old, 'before-upgrade', 'tool', null, now - 2);
  const upgraded = { ...identity, revision: 'new-revision', version: '2.0' };
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  registerPluginUsageIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } as Pick<IpcMain, 'handle'>,
    assertTrusted: () => {},
    service: () => service,
    identity: () => upgraded,
    warn: vi.fn(),
  });
  let resume!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const upgrade = withGhostInstallLock(identity.ghostId, async () => {
    entered();
    await new Promise<void>((r) => {
      resume = r;
    });
    await service.bind(upgraded, identity.revision);
  });
  await ready;
  const reading = handlers.get('ghosts:usage-summary')!({} as IpcMainInvokeEvent, identity.ghostId);
  resume();
  await upgrade;
  expect(await reading).toMatchObject({ subjectId: old.subjectId, totalCalls: 1 });
  service.accept(service.capture(upgraded)!, 'after-upgrade', 'tool', null, now - 1);
  expect((await service.summary(old.subjectId))?.totalCalls).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_usage_subjects').get()).toEqual({ n: 1 });
});

async function withReporting() {
  await service.close();
  vi.useFakeTimers();
  const target = {
    serverRoot: 'https://plugins.example',
    ownerId: 'owner',
    pluginId: 'plugin1',
    scope: 'public' as const,
    organizationId: null,
  };
  const reporting = {
    allowed: vi.fn(() => true),
    target: vi.fn(() => target),
    canSend: vi.fn(() => true),
    send: vi.fn<PluginUsageReporting['send']>(async (_target, events) => ({
      accepted: events.map((e) => e.eventId),
      duplicate: [],
      rejected: [],
    })),
  };
  service = new PluginUsageService({
    client,
    isCurrent: () => ownerCurrent,
    now: () => clock,
    deviceName: 'Test',
    warn: vi.fn(),
    reporting,
  });
  await service.bind(identity);
  return reporting;
}

it('reports accepted inputs through the existing event contract without uploading local classification', async () => {
  const reporting = await withReporting();
  const h = capture();
  service.accept(h, 'tool', 'status', null, now - 2);
  service.accept(h, 'execution', 'tasks.send', null, now - 1, 'execution');
  await service.summary(h.subjectId);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send.mock.calls[0]?.[1]).toEqual([
    { eventId: 'tool', releaseId: null, occurredAt: new Date(now - 2).toISOString() },
    { eventId: 'execution', releaseId: null, occurredAt: new Date(now - 1).toISOString() },
  ]);
  expect(reporting.send).toHaveBeenCalledOnce();
  expect((await service.summary(h.subjectId))?.totalCalls).toBe(2);
});

it('resumes persisted pending rows on the next service and never recreates cleared data from an ACK', async () => {
  const reporting = await withReporting();
  const h = capture();
  service.accept(h, 'restart', 'tool', null, now);
  await service.close();
  service = new PluginUsageService({
    client,
    isCurrent: () => ownerCurrent,
    now: () => clock,
    deviceName: 'Test',
    warn: vi.fn(),
    reporting,
  });
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT report_state AS state FROM plugin_usage_events').get()).toEqual({
    state: 'sent',
  });
  const oldRow = {
    callId: 'restart',
    subjectId: h.subjectId,
    historyGeneration: h.historyGeneration,
    releaseId: 'release',
    occurredAt: now,
    reportTarget: JSON.stringify(h.reportTarget),
    attemptCount: 0,
  };
  await service.bind(identity);
  await service.clear(h.subjectId);
  service.accept(capture(), 'restart', 'tool', null, now);
  await service.summary(h.subjectId);
  runPluginUsageTransaction(db, {
    action: 'report',
    updates: [{ row: oldRow, state: 'sent', nextAttemptAt: null }],
  });
  expect(
    db
      .prepare(
        'SELECT report_state AS state,history_generation AS generation FROM plugin_usage_events',
      )
      .get(),
  ).toEqual({ state: 'pending', generation: 1 });
});

it('persists the frozen target, batches at most 100, and confirms only ACKed events without deleting history', async () => {
  const reporting = await withReporting();
  reporting.send.mockImplementationOnce(async (_target, events) => ({
    accepted: [events[0].eventId],
    duplicate: [events[1].eventId],
    rejected: [{ eventId: events[2].eventId, code: 'FUTURE_REASON' }],
  }));
  const h = capture();
  h.identity.releaseId = 'release-1';
  for (let i = 0; i < 101; i++)
    service.accept(h, `call-${i}`, 'tool', 'private-task', now - 1000 + i);
  await service.summary(h.subjectId);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send).toHaveBeenCalledTimes(1);
  expect(reporting.send.mock.calls[0][1]).toHaveLength(100);
  expect(reporting.send.mock.calls[0][1][0]).toEqual({
    eventId: 'call-0',
    releaseId: 'release-1',
    occurredAt: new Date(now - 1000).toISOString(),
  });
  expect(
    db
      .prepare(
        'SELECT report_state AS state,COUNT(*) AS n FROM plugin_usage_events GROUP BY report_state ORDER BY state',
      )
      .all(),
  ).toEqual([
    { state: 'pending', n: 99 },
    { state: 'sent', n: 2 },
  ]);
  expect((await service.summary(h.subjectId))?.totalCalls).toBe(101);
});

it('does not upload disabled-period calls or replay historical not-applicable rows after enabling', async () => {
  const reporting = await withReporting();
  reporting.allowed.mockReturnValue(false);
  service.accept(capture(), 'disabled', 'tool', null, now);
  await service.summary(capture().subjectId);
  reporting.allowed.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send).not.toHaveBeenCalled();
  expect(db.prepare('SELECT report_state AS state FROM plugin_usage_events').get()).toEqual({
    state: 'not-applicable',
  });
});

it('retains personal history and retries the identical event after a missing endpoint', async () => {
  const reporting = await withReporting();
  reporting.send.mockRejectedValueOnce({ statusCode: 404 });
  const h = capture();
  service.accept(h, 'retry', 'tool', null, now);
  await service.summary(h.subjectId);
  await vi.advanceTimersByTimeAsync(2500);
  expect(
    db
      .prepare(
        'SELECT report_state AS state,attempt_count AS attempts,next_attempt_at AS next FROM plugin_usage_events',
      )
      .get(),
  ).toEqual({ state: 'pending', attempts: 1, next: now + 300_000 });
  clock += 300_000;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reporting.send).toHaveBeenCalledTimes(2);
  expect(reporting.send.mock.calls[1][1]).toEqual(reporting.send.mock.calls[0][1]);
  expect((await service.summary(h.subjectId))?.totalCalls).toBe(1);
});

it('splits a 413 batch while preserving event facts and personal history', async () => {
  const reporting = await withReporting();
  reporting.send.mockRejectedValueOnce({ statusCode: 413 });
  const h = capture();
  h.identity.releaseId = 'release-1';
  for (let i = 0; i < 4; i++) service.accept(h, `split-${i}`, 'tool', null, now - 4 + i);
  await service.summary(h.subjectId);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send.mock.calls[0][1]).toHaveLength(4);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM plugin_usage_events WHERE report_state='pending'").get(),
  ).toEqual({ n: 4 });
  clock += 2500;
  await vi.advanceTimersByTimeAsync(2500);
  clock += 2500;
  await vi.advanceTimersByTimeAsync(2500);
  expect(reporting.send.mock.calls.map((call) => call[1].length)).toEqual([4, 2, 2]);
  expect(reporting.send.mock.calls.slice(1).flatMap((call) => call[1])).toEqual(
    reporting.send.mock.calls[0][1],
  );
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM plugin_usage_events WHERE report_state='sent'").get(),
  ).toEqual({ n: 4 });
  expect((await service.summary(h.subjectId))?.totalCalls).toBe(4);
});

it('backs off a single-event 413 without deleting it or retrying in a tight loop', async () => {
  const reporting = await withReporting();
  reporting.send.mockRejectedValueOnce({ statusCode: 413 });
  const h = capture();
  service.accept(h, 'single-413', 'tool', null, now);
  await service.summary(h.subjectId);
  await vi.advanceTimersByTimeAsync(2500);
  clock += 10_000;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reporting.send).toHaveBeenCalledTimes(1);
  expect(
    db
      .prepare('SELECT report_state AS state,next_attempt_at AS next FROM plugin_usage_events')
      .get(),
  ).toEqual({ state: 'pending', next: now + 60_000 });
  expect((await service.summary(h.subjectId))?.totalCalls).toBe(1);
});

it.each(['clear', 'owner', 'close'] as const)(
  'does not apply a late network ACK after %s',
  async (action) => {
    const reporting = await withReporting();
    let resolve!: (value: Awaited<ReturnType<PluginUsageReporting['send']>>) => void;
    reporting.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const h = capture();
    service.accept(h, 'late-ack', 'tool', null, now);
    await service.summary(h.subjectId);
    await vi.advanceTimersByTimeAsync(2500);
    if (action === 'clear') await service.clear(h.subjectId);
    else if (action === 'owner') ownerCurrent = false;
    else await service.close();
    resolve({ accepted: ['late-ack'], duplicate: [], rejected: [] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM plugin_usage_events WHERE report_state='sent'").get(),
    ).toEqual({ n: 0 });
    expect(reporting.send).toHaveBeenCalledTimes(1);
    if (action === 'clear')
      expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_usage_events').get()).toEqual({ n: 0 });
  },
);

it('counts unique dispatched calls over a rolling 168h window without deleting older events', async () => {
  await service.bind(identity);
  const h = capture();
  for (const [id, time] of [
    ['older', now - week - 1],
    ['boundary', now - week],
    ['recent', now - 1],
    ['future', now],
  ] as const)
    service.accept(h, id, 'top_tool', null, time);
  service.accept(h, 'recent', 'top_tool', 'forged-title-never-stored', now - 1);
  service.settle(h, 'recent', 'failed');
  expect(await service.summary(h.subjectId)).toMatchObject({
    totalCalls: 4,
    callsLast7Days: 2,
    lastUsedAt: now,
    recentTasks: [],
  });
  expect(
    db
      .prepare(
        'SELECT outcome,session_id AS sessionId,version,report_state AS state FROM plugin_usage_events WHERE call_id=?',
      )
      .get('recent'),
  ).toEqual({ outcome: 'failed', sessionId: null, version: '1.0', state: 'not-applicable' });
});

it('deduplicates tasks after filtering deletion and reads current titles; calls survive task deletion', async () => {
  await service.bind(identity);
  const h = capture();
  for (let i = 1; i <= 5; i++) {
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
      `s${i}`,
      `Title ${i}`,
      i === 5 ? 'deleted' : 'active',
    );
    service.accept(h, `c${i}`, 'tool', `s${i}`, now - (10 - i));
  }
  service.accept(h, 'duplicate-session', 'tool', 's4', now - 1);
  db.prepare('UPDATE sessions SET title=? WHERE id=?').run('Renamed', 's4');
  expect(
    (await service.summary(h.subjectId))?.recentTasks.map((t) => [t.sessionId, t.title]),
  ).toEqual([
    ['s4', 'Renamed'],
    ['s3', 'Title 3'],
    ['s2', 'Title 2'],
  ]);
  db.prepare('DELETE FROM sessions WHERE id=?').run('s4');
  expect(await service.summary(h.subjectId)).toMatchObject({
    totalCalls: 6,
    recentTasks: [{ sessionId: 's3' }, { sessionId: 's2' }, { sessionId: 's1' }],
  });
});

it('atomically clears one subject, rejects old-generation inserts/results, then accepts new calls', async () => {
  await service.bind(identity);
  const old = capture();
  const other = { ...identity, ghostId: 'other', revision: 'other-rev' };
  await service.bind(other);
  const h2 = service.capture(other)!;
  service.accept(old, 'old', 'tool', null, now - 1);
  service.accept(h2, 'keep', 'tool', null, now - 1);
  await service.clear(old.subjectId);
  service.accept(old, 'late-accept', 'tool', null, now);
  service.settle(old, 'old', 'succeeded');
  expect(await service.summary(old.subjectId)).toMatchObject({
    totalCalls: 0,
    recordingStartedAt: now,
  });
  const next = capture();
  expect(next.historyGeneration).toBe(old.historyGeneration + 1);
  service.accept(next, 'new', 'tool', null, now - 1);
  expect((await service.summary(next.subjectId))?.totalCalls).toBe(1);
  expect((await service.summary(h2.subjectId))?.totalCalls).toBe(1);
  await service.clear(null);
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_usage_events').get()).toEqual({ n: 0 });
});

it('rejects writes with stale generations cleared by another connection/service without replay', async () => {
  await service.bind(identity);
  const stale = capture();
  runPluginUsageTransaction(db, { action: 'clear', subjectId: stale.subjectId, now });
  service.accept(stale, 'old-generation', 'tool', null, now - 1);
  expect((await service.summary(stale.subjectId))?.totalCalls).toBe(0);
  service.accept(capture(), 'fresh', 'tool', null, now - 1);
  expect((await service.summary(stale.subjectId))?.totalCalls).toBe(1);
});

it('keeps local upgrades continuous but separates reinstallations; verified market reinstallation rejoins', async () => {
  await service.bind(identity);
  const h = capture();
  service.accept(h, 'v1', 'tool', null, now - 2);
  const upgraded = { ...identity, revision: 'rev2', version: '2.0' };
  await service.bind(upgraded, identity.revision);
  const h2 = service.capture(upgraded)!;
  expect(h2.subjectId).toBe(h.subjectId);
  service.accept(h2, 'v2', 'tool', null, now - 1);
  const rollback = { ...identity, revision: 'rollback' };
  await service.bind(rollback, upgraded.revision);
  const rollbackHandle = service.capture(rollback)!;
  expect(rollbackHandle.subjectId).toBe(h.subjectId);
  service.accept(rollbackHandle, 'rollback-call', 'tool', null, now);
  await service.detach(identity.ghostId);
  const reinstalled = { ...upgraded, revision: 'rev3' };
  await service.bind(reinstalled);
  expect(service.capture(reinstalled)?.subjectId).not.toBe(h.subjectId);
  const market = {
    ...identity,
    sourceKind: 'server' as const,
    stableKey: 'verified-server/plugin1',
    pluginId: 'plugin1',
    serverRoot: 'https://plugins.example',
    revision: 'market1',
  };
  await service.bind(market);
  const mh = service.capture(market)!;
  await service.detach(market.ghostId);
  await service.bind({ ...market, revision: 'market2' });
  expect(service.capture({ ...market, revision: 'market2' })?.subjectId).toBe(mh.subjectId);
  expect(db.prepare('SELECT version FROM plugin_usage_events ORDER BY occurred_at').all()).toEqual([
    { version: '1.0' },
    { version: '2.0' },
    { version: '1.0' },
  ]);
});

it('does not run queued operations after the owner/client epoch changes, including global inproc handles', async () => {
  await service.bind(identity);
  const h = capture();
  let resume!: () => void;
  const realTx = client.tx.bind(client);
  const txSpy = vi.spyOn(client, 'tx').mockImplementationOnce(async (name, args) => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return realTx(name, args);
  });
  const pendingBind = service.bind(identity).catch(() => undefined);
  await Promise.resolve();
  service.accept(h, 'old-owner', 'tool', null, now);
  ownerCurrent = false;
  resume();
  await pendingBind;
  await service.close();
  expect(txSpy).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_usage_events').get()).toEqual({ n: 0 });
  expect(service.capture(identity)).toBeNull();
});

it('close stops admission and drains already accepted short writes', async () => {
  await service.bind(identity);
  const h = capture();
  service.accept(h, 'before-close', 'tool', null, now - 1);
  await service.close();
  service.accept(h, 'after-close', 'tool', null, now);
  expect(db.prepare('SELECT call_id FROM plugin_usage_events').all()).toEqual([
    { call_id: 'before-close' },
  ]);
});

describe('actual async DbClient inline worker', () => {
  it('uses the same generated migration and transaction contract in the worker', async () => {
    const worker = await createDbClient({ useInlineWorker: true });
    try {
      for (const statement of migration.split('--> statement-breakpoint').filter((s) => s.trim()))
        await worker.exec(statement);
      const h = await worker.tx('pluginUsage.execute', {
        action: 'bind',
        identity,
        newId: 'worker-subject',
        now,
      });
      await worker.tx('pluginUsage.execute', {
        action: 'accept',
        handle: h!,
        callId: 'worker-call',
        toolName: 'tool',
        sessionId: null,
        occurredAt: now,
      });
      await worker.tx('pluginUsage.execute', { action: 'clear', subjectId: h!.subjectId, now });
      await worker.tx('pluginUsage.execute', {
        action: 'accept',
        handle: h!,
        callId: 'late-worker-call',
        toolName: 'tool',
        sessionId: null,
        occurredAt: now,
      });
      expect(await worker.queryOne('SELECT COUNT(*) AS n FROM plugin_usage_events')).toEqual({
        n: 0,
      });
      expect(
        await worker.queryOne('SELECT history_generation AS generation FROM plugin_usage_subjects'),
      ).toEqual({ generation: 1 });
    } finally {
      await worker.dispose();
    }
  });
});

it('uses persisted generations across two independent SQLite connections', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-usage-generation-'));
  const first = new Database(path.join(dir, 'history.db'));
  first.exec(migration);
  const second = new Database(path.join(dir, 'history.db'));
  try {
    const h = runPluginUsageTransaction(first, {
      action: 'bind',
      identity,
      newId: 'subject',
      now,
    })!;
    runPluginUsageTransaction(second, { action: 'clear', subjectId: h.subjectId, now });
    runPluginUsageTransaction(first, {
      action: 'accept',
      handle: h,
      callId: 'stale',
      toolName: 'tool',
      sessionId: null,
      occurredAt: now,
    });
    runPluginUsageTransaction(first, {
      action: 'settle',
      handle: h,
      callId: 'stale',
      outcome: 'succeeded',
    });
    expect(second.prepare('SELECT COUNT(*) AS n FROM plugin_usage_events').get()).toEqual({ n: 0 });
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('runs usage transactions in the bundled file worker, not only its inline fallback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-usage-worker-'));
  let worker: DbClient | undefined;
  try {
    const drizzleDir = path.join(dir, 'drizzle');
    mkdirSync(drizzleDir);
    writeFileSync(path.join(drizzleDir, '0000_init.sql'), migration);
    const raw = new Database(path.join(dir, 'history.db'));
    raw.exec(
      'CREATE TABLE migration_meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY,file_name TEXT NOT NULL,content_hash TEXT NOT NULL,applied_at INTEGER NOT NULL)',
    );
    runMigrationReplay(raw, { drizzleDir, currentVersion: -1 });
    raw.close();
    const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'bundle'));
    worker = await createDbClient({
      dbPath: path.join(dir, 'history.db'),
      drizzleDir,
      workerScriptPath,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
    });
    const h = await worker.tx('pluginUsage.execute', {
      action: 'bind',
      identity,
      newId: 'file-worker-subject',
      now,
    });
    await worker.tx('pluginUsage.execute', {
      action: 'accept',
      handle: h!,
      callId: 'file-worker-call',
      toolName: 'tool',
      sessionId: null,
      occurredAt: now,
    });
    expect(await worker.queryOne('SELECT COUNT(*) AS n FROM plugin_usage_events')).toEqual({
      n: 1,
    });
  } finally {
    await worker?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('counts and clears tool calls separately for same-name namespace instances', async () => {
  const root = { ...identity, ghostId: 'same-name' };
  const org = { ...identity, ghostId: '_ns__acme__same-name' };
  await service.bind(root);
  await service.bind(org);
  const rootHandle = service.capture(root)!;
  const orgHandle = service.capture(org)!;
  expect(rootHandle.subjectId).not.toBe(orgHandle.subjectId);
  service.accept(rootHandle, 'root-call', 'tool', null, now - 1);
  service.accept(orgHandle, 'org-call', 'tool', null, now - 1);
  expect(await service.summary(rootHandle.subjectId)).toMatchObject({ totalCalls: 1 });
  expect(await service.summary(orgHandle.subjectId)).toMatchObject({ totalCalls: 1 });
  await service.clear(rootHandle.subjectId);
  expect(await service.summary(rootHandle.subjectId)).toMatchObject({ totalCalls: 0 });
  expect(await service.summary(orgHandle.subjectId)).toMatchObject({ totalCalls: 1 });
});
