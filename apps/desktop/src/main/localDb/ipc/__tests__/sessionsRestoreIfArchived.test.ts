/**
 * sessionsRestoreIfArchived.test.ts — 批量恢复的持久层 compare-and-set 回归测试。
 *
 * 确认框期间会话可能被删除、由其他入口恢复或移动项目；真实 IPC handler 必须用
 * 一条条件 UPDATE 同时校验 archived 状态和项目身份，不能用 get + update 两步校验。
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { messages, sessions } from '../../schema';
import type { SessionRouteLock } from '../../sessionRouteLock';

type SessionRouteLockMock = SessionRouteLock &
  MockInstance<(sessionId: string, task: () => Promise<unknown>) => Promise<unknown>>;

const h = vi.hoisted(() => ({
  migrationRoot: '',
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  tapWindowBroadcast: vi.fn(),
  resourceLock: vi.fn(async (_resources: readonly string[], task: () => Promise<unknown>) => task()),
  routeLock: vi.fn(async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> =>
    task(),
  ) as SessionRouteLockMock,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.migrationRoot, ...parts),
  activeOwnerScopeKey: () => 'test-user:1',
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
  getCurrentDbClientUserId: () => 'test-user',
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../worktree/resourceLock', () => ({
  physicalWorktreeKey: async (value: string) => value,
  // This fixture serializes the recycler's resource only; migration admission is a distinct key.
  withWorktreeResourceLocks: (resources: string[], task: () => Promise<unknown>) =>
    resources.every(resource => resource.startsWith(path.join(h.migrationRoot, 'task-migrations', 'admission') + path.sep))
      ? task() : h.resourceLock(resources, task),
}));
vi.mock('../../../worktree/recycleEvents', () => ({ notifyWorktreeRecycleOpportunity: vi.fn() }));

import { registerSessionIpc } from '../sessions';
import { migrationScope } from '../../../task-migration/journal';
import { setSessionRouteLockImplementation } from '../../sessionRouteLock';
import { getDbClient } from '../../client/current';
import { selectSessionsByIds, selectSessionWithCount, selectSessionListRows, flattenSessionReadRow } from '../../sessionQueries';
import { createDrizzleProxy } from '../../client/drizzleProxy';
import type { DbTransport } from '../../client/DbTransport';

type ExpectedIdentity = {
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  remoteHostId: string | null;
};

const ORIGINAL_IDENTITY: ExpectedIdentity = {
  workingDir: '/repo/project',
  workspaceKind: 'project',
  remoteHostId: null,
};

function createDb(): void {
  h.sqlite?.close();
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE task_tags(id TEXT PRIMARY KEY,name TEXT,color TEXT,favorite_order INTEGER,sort_order INTEGER,revision INTEGER,name_customized INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE session_task_tags(session_id TEXT,tag_id TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New CCS',
      working_dir TEXT,
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
      context_window_runtime INTEGER,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      user_send_at INTEGER,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      writable_dirs TEXT NOT NULL DEFAULT '[]',
      one_m INTEGER NOT NULL DEFAULT 0,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      orca_role TEXT,
      remote_host_id TEXT,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      summary TEXT,
      provider_id TEXT,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    INSERT INTO sessions (
      id, working_dir, workspace_kind, remote_host_id, status, created_at, updated_at
    ) VALUES ('target', '/repo/project', 'project', NULL, 'archived', 1, 1);
  `);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

async function restore(
  id = 'target',
  expected: ExpectedIdentity = ORIGINAL_IDENTITY,
): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:restore-if-archived');
  if (!handler) throw new Error('restore-if-archived handler not registered');
  return handler({}, id, expected);
}

function readStatus(): string {
  return (
    h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('target') as {
      status: string;
    }
  ).status;
}

beforeEach(() => {
  h.migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-restore-migration-'));
  vi.clearAllMocks();
  h.routeLock.mockImplementation(async (_sessionId, task) => task());
  h.resourceLock.mockImplementation(async (_resources, task) => task());
  h.handlers.clear();
  createDb();
  setSessionRouteLockImplementation(h.routeLock);
  registerSessionIpc();
});

afterEach(() => {
  fs.rmSync(h.migrationRoot, { recursive: true, force: true });
  setSessionRouteLockImplementation(null);
});

describe('local-db:sessions:restore-if-archived', () => {
  it('keeps a migrated source fenced before any lifecycle update', async () => {
    migrationScope().save({ kind: 'outgoing', id: '11111111-2222-4333-a444-555555555555',
      sessionId: 'target', sourceDeviceId: 'source', targetDeviceId: 'destination',
      targetSessionId: '11111111-2222-4333-a444-555555555555', targetProject: null,
      workingDir: path.join(h.migrationRoot, 'project'), stage: 'complete' });
    await expect(restore()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED',
      message: '[PRECONDITION_FAILED] MIGRATION_TASK_MOVED' });
    expect(readStatus()).toBe('archived');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });
  function managedIdentity(): ExpectedIdentity {
    const root = path.join(os.tmpdir(), 'cindy-restore-lock-fixture', '.cindy-worktrees', 'work');
    const workingDir = path.join(root, 'src');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ?, worktree_path = ? WHERE id = ?')
      .run(workingDir, root, 'target');
    return { ...ORIGINAL_IDENTITY, workingDir };
  }

  it('waits for a recycler holding the physical worktree lock before making the task active', async () => {
    const identity = managedIdentity();
    let acquired!: () => void;
    const waiting = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.resourceLock.mockImplementationOnce(async (_resources, task) => {
      acquired();
      await gate;
      return task();
    });

    const restoring = restore('target', identity);
    await waiting;
    expect(readStatus()).toBe('archived');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(h.resourceLock).toHaveBeenCalledWith(
      expect.arrayContaining([path.dirname(identity.workingDir!)]), expect.any(Function),
    );
    release();
    await expect(restoring).resolves.toMatchObject({ status: 'active' });
  });

  it('publishes active status before a later recycler can enter the resource lock', async () => {
    const identity = managedIdentity();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let tail = Promise.resolve<unknown>(undefined);
    h.resourceLock.mockImplementation((_resources, task) => {
      const next = tail.then(task);
      tail = next;
      return next;
    });
    // Hold the first lock holder long enough to enqueue both the restore and a later recycler.
    const blocker = h.resourceLock([], async () => { entered(); await gate; });
    await waiting;
    const restoring = restore('target', identity);
    await vi.waitFor(() => expect(h.resourceLock).toHaveBeenCalledTimes(2));
    const canRecycle = h.resourceLock([], async () => readStatus() === 'archived');
    release();
    await blocker;
    await expect(restoring).resolves.toMatchObject({ status: 'active' });
    await expect(canRecycle).resolves.toBe(false);
  });

  it('restores when archived status and the full project identity still match', async () => {
    const updated = (await restore()) as { id: string; status: string };

    expect(updated).toMatchObject({ id: 'target', status: 'active' });
    expect(readStatus()).toBe('active');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'target',
      patch: { status: 'active' },
    });
  });

  it('waits for the shared task route lock before restoring', async () => {
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.routeLock.mockImplementationOnce(async (_sessionId, task) => {
      markWaiting();
      await gate;
      return task();
    });

    const restoring = restore();
    await waiting;
    expect(readStatus()).toBe('archived');
    release();

    await expect(restoring).resolves.toMatchObject({ status: 'active' });
    expect(h.routeLock).toHaveBeenCalledWith('target', expect.any(Function));
  });

  it.each(['active', 'deleted'])('does not overwrite a newer %s status', async (status) => {
    h.sqlite!.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, 'target');

    await expect(restore()).resolves.toBeNull();
    expect(readStatus()).toBe(status);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['workingDir', "UPDATE sessions SET working_dir = '/repo/other' WHERE id = 'target'"],
    ['workspaceKind', "UPDATE sessions SET workspace_kind = 'dialogue' WHERE id = 'target'"],
    ['remoteHostId', "UPDATE sessions SET remote_host_id = 'host-2' WHERE id = 'target'"],
  ])('does not restore after %s changes during confirmation', async (_field, sql) => {
    h.sqlite!.exec(sql);

    await expect(restore()).resolves.toBeNull();
    expect(readStatus()).toBe('archived');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the session no longer exists', async () => {
    await expect(restore('missing')).rejects.toThrow('[NOT_FOUND]');
  });

  it('does not restore Bot history through the ordinary task lifecycle', async () => {
    h.sqlite!.prepare("UPDATE sessions SET source = 'bot' WHERE id = 'target'").run();

    await expect(restore()).rejects.toThrow(/Bot task lifecycle/);
    expect(readStatus()).toBe('archived');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });
});

describe('bounded reconciliation read', () => {
  it.each(['native', 'worker-proxy'])('correlates uncached projections to the outer session through %s', async (mode) => {
    h.sqlite!.exec(`
      CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
      INSERT INTO sessions (id, created_at, updated_at) VALUES ('other', 1, 1), ('empty', 1, 1);
      UPDATE sessions SET cleared_at = 2 WHERE id = 'target';
      INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at) VALUES
        ('old', 'old', 'target', 'user', '{"text":"cleared"}', NULL, 1, NULL),
        ('user', 'user', 'target', 'user', '{"text":"question"}', NULL, 3, NULL),
        ('answer', 'answer', 'target', 'assistant', '"answer"', NULL, 4, NULL),
        ('resume', 'resume', 'target', 'user', '{"text":"continue"}', '{"autoResume":true}', 5, NULL),
        ('rewound', 'rewound', 'target', 'assistant', '"rewound"', NULL, 6, 7),
        ('other', 'other', 'other', 'assistant', '"another session"', NULL, 8, NULL);
    `);
    const plans: string[] = [];
    const transport = {
      async send(_op: string, args: { sql: string; params: unknown[] }) {
        plans.push(...(h.sqlite!.prepare(`EXPLAIN QUERY PLAN ${args.sql}`).all(...args.params) as { detail: string }[])
          .map((row) => row.detail));
        return h.sqlite!.prepare(args.sql).raw().all(...args.params);
      },
    } as unknown as DbTransport;
    const db = mode === 'native' ? getDbClient().drizzle : createDrizzleProxy(transport);
    const single = await selectSessionWithCount(db, 'target');
    expect(single).toMatchObject({ messageCount: 5, latestMessageExtract: 'answer', latestMessageRole: 'assistant' });
    const batch = await selectSessionsByIds(db, ['target', 'empty']);
    expect(batch[0]).toEqual(single);
    expect(batch[1]).toMatchObject({ messageCount: 0, latestMessageExtract: null, latestMessageRole: null });
    const list = (await selectSessionListRows(db, undefined, 20)).map(flattenSessionReadRow);
    expect(list.find((row) => row.id === 'target')).toEqual(single);
    if (mode === 'worker-proxy') {
      expect(plans.some((plan) => /SEARCH m USING (?:COVERING )?INDEX idx_messages_session_created/.test(plan))).toBe(true);
      expect(plans.some((plan) => /SCAN m\b/.test(plan))).toBe(false);
    }
    h.sqlite!.prepare("UPDATE sessions SET cleared_at = 10 WHERE id = 'target'").run();
    expect(await selectSessionWithCount(db, 'target')).toMatchObject({ messageCount: 5, latestMessageExtract: null, latestMessageRole: null });
  });

  it('shares exact database projection across single, batch and list reads without retaining stale results', async () => {
    const db = getDbClient().drizzle;
    const select = vi.spyOn(db, 'select');
    const batch = await selectSessionsByIds(db, ['target', 'missing', 'target']);
    expect(select).toHaveBeenCalledTimes(1);
    expect(batch).toHaveLength(1);
    expect(await selectSessionWithCount(db, 'target')).toEqual(batch[0]);
    expect((await selectSessionListRows(db, undefined, 20)).map(flattenSessionReadRow)).toEqual(batch);
    h.sqlite!.prepare("UPDATE sessions SET title = 'fresh title' WHERE id = 'target'").run();
    expect((await selectSessionsByIds(db, ['target']))[0].title).toBe('fresh title');
    select.mockRestore();
  });

  it('does not query for empty input and bounds larger internal reads', async () => {
    const db = getDbClient().drizzle;
    const select = vi.spyOn(db, 'select');
    expect(await selectSessionsByIds(db, [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(await selectSessionsByIds(db, Array.from({ length: 600 }, (_, i) => `missing-${i}`))).toEqual([]);
    expect(select).toHaveBeenCalledTimes(3);
    select.mockRestore();
  });

  it('returns the same projection as GET, deduplicates ids and omits missing rows', async () => {
    const { runDeviceLinkInvokeContext } = await import('../../../device-link/invoke-context.js');
    const get = h.handlers.get('local-db:sessions:get')!;
    const batch = h.handlers.get('local-db:sessions:get-many')!;
    const expected = await get({}, 'target');
    const result = await runDeviceLinkInvokeContext({ controllerDeviceId: 'phone', channel: 'local-db:sessions:get-many' },
      () => batch({}, ['target', 'missing', 'target']));
    expect(result).toEqual([expected]);
  });
  it('rejects untrusted local callers and oversized remote batches before querying', async () => {
    const { runDeviceLinkInvokeContext } = await import('../../../device-link/invoke-context.js');
    const batch = h.handlers.get('local-db:sessions:get-many')!;
    await expect(batch({}, ['target'])).rejects.toThrow();
    await expect(runDeviceLinkInvokeContext({ controllerDeviceId: 'phone', channel: 'local-db:sessions:get-many' },
      () => batch({}, Array.from({ length: 33 }, () => 'target')))).rejects.toThrow('INVALID_PARAMS');
  });
});
