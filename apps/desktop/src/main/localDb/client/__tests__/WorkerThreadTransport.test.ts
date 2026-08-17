import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../__tests__/dbWorkerTestUtils.js';
import {
  DB_TRANSPORT_NOT_SENT,
  DB_TRANSPORT_OUTCOME_UNKNOWN,
  type LogEvent,
  type VecStatusEvent,
} from '../DbTransport.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';

describe('WorkerThreadTransport', () => {
  it('round-trips RPC messages', async () => {
    const transport = new WorkerThreadTransport({ useInlineWorker: true });
    try {
      await transport.send('exec', {
        sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)',
      });
      await transport.send('exec', {
        sql: 'INSERT INTO t (name) VALUES (?)',
        params: ['alice'],
      });
      await expect(
        transport.send('query', {
          sql: 'SELECT id, name FROM t',
        }),
      ).resolves.toEqual([{ id: 1, name: 'alice' }]);
    } finally {
      await transport.close();
    }
  });

  it('rejects all pending RPCs when the worker terminates', async () => {
    const transport = new WorkerThreadTransport({ useInlineWorker: true });
    const pending = transport.send('sleep', { ms: 1_000 });
    await transport.terminateForTest();
    await expect(pending).rejects.toMatchObject({
      code: DB_TRANSPORT_OUTCOME_UNKNOWN,
      message: expect.stringMatching(/db worker exited|terminated/i),
    });
  });

  it('applies bounded backpressure before posting more RPCs to the worker', async () => {
    const transport = new WorkerThreadTransport({
      useInlineWorker: true,
      maxInFlightRpcs: 1,
      maxQueuedRpcs: 1,
    });
    try {
      const active = transport.send('sleep', { ms: 30 });
      const queued = transport.send('echoTransfer', { buffer: new ArrayBuffer(4) });
      await expect(transport.send('query', { sql: 'SELECT 1' })).rejects.toThrow(
        /RPC queue overloaded/,
      );

      await expect(active).resolves.toEqual({ slept: 30 });
      await expect(queued).resolves.toEqual({ byteLength: 4 });
    } finally {
      await transport.close();
    }
  });

  it('counts queue wait against the RPC timeout budget', async () => {
    const transport = new WorkerThreadTransport({
      useInlineWorker: true,
      maxInFlightRpcs: 1,
      maxQueuedRpcs: 1,
      // Leave enough startup/scheduling headroom for Windows worker threads;
      // the assertion below still verifies that queue wait consumes the
      // request's total budget.
      rpcTimeoutMs: 500,
    });
    const startedAt = Date.now();
    try {
      const active = transport.send('sleep', { ms: 200 });
      const queued = transport.send('sleep', { ms: 400 });
      await expect(active).resolves.toEqual({ slept: 200 });
      await expect(queued).rejects.toThrow(/RPC timeout/);
      expect(Date.now() - startedAt).toBeLessThan(700);
    } finally {
      await transport.close();
    }
  });

  it('terminates promptly instead of queueing closeDb behind existing work', async () => {
    const transport = new WorkerThreadTransport({
      useInlineWorker: true,
      maxInFlightRpcs: 1,
      maxQueuedRpcs: 1,
    });
    const active = transport.send('sleep', { ms: 1_000 });
    const queued = transport.send('query', { sql: 'SELECT 1' });
    const activeRejection = expect(active).rejects.toMatchObject({
      code: DB_TRANSPORT_OUTCOME_UNKNOWN,
      message: expect.stringMatching(/transport closed/),
    });
    const queuedRejection = expect(queued).rejects.toMatchObject({
      code: DB_TRANSPORT_NOT_SENT,
      message: expect.stringMatching(/transport closed/),
    });

    await expect(transport.close()).resolves.toBeUndefined();
    await Promise.all([activeRejection, queuedRejection]);
  });

  it('marks requests rejected before dispatch as definitely not sent', async () => {
    const transport = new WorkerThreadTransport({ useInlineWorker: true });
    await transport.close();

    await expect(transport.send('query', { sql: 'SELECT 1' })).rejects.toMatchObject({
      code: DB_TRANSPORT_NOT_SENT,
    });
  });

  it('transfers ArrayBuffer ownership through postMessage transferList', async () => {
    const transport = new WorkerThreadTransport({ useInlineWorker: true });
    try {
      const f32 = new Float32Array([1, 2, 3]);
      const result = await transport.send<{ byteLength: number }>(
        'echoTransfer',
        { buffer: f32.buffer },
        [f32.buffer],
      );
      expect(result.byteLength).toBe(12);
      expect(f32.buffer.byteLength).toBe(0);
    } finally {
      await transport.close();
    }
  });

  it('normalizes fork.session fields in the inline worker fallback', async () => {
    const transport = new WorkerThreadTransport({ useInlineWorker: true });
    try {
      await transport.send('exec', {
        sql: `CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          working_dir TEXT,
          model TEXT NOT NULL,
          provider_id TEXT,
          effort TEXT NOT NULL,
          permission_mode TEXT NOT NULL,
          status TEXT NOT NULL,
          sdk_session_id TEXT,
          total_token_usage INTEGER NOT NULL,
          total_cost_usd REAL NOT NULL,
          total_cost_amount REAL NOT NULL DEFAULT 0,
          total_cost_currency TEXT,
          total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
          context_tokens INTEGER NOT NULL,
          context_window INTEGER NOT NULL,
          fast_mode INTEGER NOT NULL,
          cleared_at INTEGER,
          pinned_at INTEGER,
          user_send_at INTEGER,
          agent_kind TEXT NOT NULL,
          workspace_kind TEXT NOT NULL,
          codex_history_has_product_prompt INTEGER,
          parent_session_id TEXT,
          forked_at_message_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      });
      await transport.send('exec', {
        sql: `CREATE TABLE messages (
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
        )`,
      });
      await transport.send('exec', {
        sql: `INSERT INTO messages (
          id, client_id, session_id, role, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          'switch',
          'switch-client',
          'src',
          'agent_switch',
          JSON.stringify({ fromAgentKind: 'cc', fromSdkSessionId: 'parent-claude-session' }),
          50,
        ],
      });

      await transport.send('tx', {
        name: 'fork.session',
        args: {
          sourceSessionId: 'src',
          targetCreatedAt: 100,
          newSession: {
            id: 'forked',
            title: 'Forked',
            workingDir: 'D:\\repo\\project',
            model: 'gpt-5',
            providerId: 'xd',
            effort: 'high',
            permissionMode: 'default',
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
            agentKind: 'codex',
            workspaceKind: 'project',
            codexHistoryHasProductPrompt: null,
            parentSessionId: 'src',
            forkedAtMessageId: 'm1',
            createdAt: 1,
            updatedAt: 1,
          },
          uuidMap: [],
          detachAgentSwitchSessions: true,
          newMessageIds: [{ id: 'forked-switch', clientId: 'forked-switch-client' }],
        },
      });

      await expect(
        transport.send('queryOne', {
          sql: 'SELECT working_dir FROM sessions WHERE id = ?',
          params: ['forked'],
        }),
      ).resolves.toEqual({ working_dir: 'D:/repo/project' });
      const copiedSwitch = await transport.send<{ content: string }>('queryOne', {
        sql: 'SELECT content FROM messages WHERE id = ?',
        params: ['forked-switch'],
      });
      expect(JSON.parse(copiedSwitch.content)).toMatchObject({
        fromSdkSessionId: null,
      });
    } finally {
      await transport.close();
    }
  });

  it('opens a migrated dbPath before RPCs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-'));
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    createMigratedSmokeDb(dbPath);

    const transport = new WorkerThreadTransport({
      userId: 'test-user',
      dbPath,
      drizzleDir,
      useInlineWorker: true,
    });
    try {
      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
          params: ['table', 'worker_smoke'],
        }),
      ).resolves.toEqual([{ name: 'worker_smoke' }]);
      await expect(
        transport.send('queryOne', {
          sql: "SELECT value FROM migration_meta WHERE key='schema_version'",
        }),
      ).resolves.toEqual({ value: '0' });
    } finally {
      await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps worker startup alive when schema drift history query fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-history-'));
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    createMigratedSmokeDb(dbPath, { malformedHistory: true });

    const transport = new WorkerThreadTransport({
      userId: 'test-user',
      dbPath,
      drizzleDir,
      useInlineWorker: true,
    });
    try {
      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
          params: ['table', 'worker_smoke'],
        }),
      ).resolves.toEqual([{ name: 'worker_smoke' }]);
      await expect(
        transport.send('queryOne', {
          sql: "SELECT value FROM migration_meta WHERE key='schema_version'",
        }),
      ).resolves.toEqual({ value: '0' });
    } finally {
      await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when the real worker script is missing', () => {
    const missingWorkerPath = path.join(os.tmpdir(), `xdt-missing-db-worker-${Date.now()}.js`);

    expect(
      () =>
        new WorkerThreadTransport({
          workerScriptPath: missingWorkerPath,
        }),
    ).toThrow(/db worker script not found/i);
  });

  it('runs queries through a real worker bundle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-bundle-'));
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      const logs: LogEvent[] = [];
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
          "INSERT INTO worker_smoke (name) VALUES ('file-worker');",
        ].join('\n'),
        'utf-8',
      );
      createMigratedSmokeDb(dbPath, { smokeName: 'file-worker' });

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });
      transport.on('log', (event) => logs.push(event));

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).resolves.toEqual([{ name: 'file-worker' }]);
      expect(logs.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'dbWorker.init.ok', runtimeMode: 'file' }),
        ]),
      );
      await expect(transport.send('closeDb')).resolves.toBeUndefined();
      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).rejects.toMatchObject({ code: 'INIT_FAILED' });
    } finally {
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers explicit workerScriptPath over the inline fallback env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-explicit-'));
    const previousInlineEnv = process.env.XDT_DB_WORKER_INLINE;
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      const logs: LogEvent[] = [];
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        ].join('\n'),
        'utf-8',
      );
      createMigratedSmokeDb(dbPath);
      process.env.XDT_DB_WORKER_INLINE = 'true';

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });
      transport.on('log', (event) => logs.push(event));

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).resolves.toEqual([{ name: 'alice' }]);
      expect(logs.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'dbWorker.init.ok', runtimeMode: 'file' }),
        ]),
      );
    } finally {
      if (previousInlineEnv === undefined) {
        delete process.env.XDT_DB_WORKER_INLINE;
      } else {
        process.env.XDT_DB_WORKER_INLINE = previousInlineEnv;
      }
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes pending migration startup errors from a real worker bundle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-pending-'));
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        ].join('\n'),
        'utf-8',
      );

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).rejects.toMatchObject({ code: 'MIGRATION_REQUIRED' });
    } finally {
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a real worker bundle usable when sqlite-vec load fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-vec-'));
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      const invalidVecPath = path.join(dir, 'missing-vec0.dll');
      const vecStatus: VecStatusEvent[] = [];
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        ].join('\n'),
        'utf-8',
      );
      createMigratedSmokeDb(dbPath);

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        sqliteVecExtPath: invalidVecPath,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });
      transport.on('vec-status', (event) => vecStatus.push(event));

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).resolves.toEqual([{ name: 'alice' }]);
      expect(vecStatus).toContainEqual({
        loaded: false,
        error: 'sqlite-vec binary not found at expected path',
        expectedPath: invalidVecPath,
      });
    } finally {
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports sqlite-vec load errors from a real worker bundle when the file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-vec-file-'));
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      const invalidVecPath = path.join(dir, 'fake-vec0.dll');
      const vecStatus: VecStatusEvent[] = [];
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(invalidVecPath, 'not a sqlite extension', 'utf-8');
      createMigratedSmokeDb(dbPath);

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        sqliteVecExtPath: invalidVecPath,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });
      transport.on('vec-status', (event) => vecStatus.push(event));

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).resolves.toEqual([{ name: 'alice' }]);
      expect(vecStatus).toEqual([
        expect.objectContaining({
          loaded: false,
          expectedPath: invalidVecPath,
          error: expect.any(String),
        }),
      ]);
    } finally {
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unknown schema drift status from a real worker bundle when history query fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-history-file-'));
    let transport: WorkerThreadTransport | undefined;
    try {
      const drizzleDir = path.join(dir, 'drizzle');
      const dbPath = path.join(dir, 'xdt-maker-test-user.db');
      const workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'build'));
      const logs: LogEvent[] = [];
      fs.mkdirSync(drizzleDir);
      fs.writeFileSync(
        path.join(drizzleDir, '0000_init.sql'),
        [
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
          'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY);',
          'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        ].join('\n'),
        'utf-8',
      );
      createMigratedSmokeDb(dbPath, { malformedHistory: true });

      transport = new WorkerThreadTransport({
        userId: 'test-user',
        dbPath,
        drizzleDir,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        workerScriptPath,
      });
      transport.on('log', (event) => logs.push(event));

      await expect(
        transport.send('query', {
          sql: 'SELECT name FROM worker_smoke',
        }),
      ).resolves.toEqual([{ name: 'alice' }]);
      expect(logs.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'dbWorker.schemaDrift.queryFailed' }),
          expect.objectContaining({ event: 'dbWorker.schemaDrift', status: 'unknown' }),
        ]),
      );
    } finally {
      if (transport) await transport.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
