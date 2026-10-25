/**
 * 插件后台隐藏任务(sessions.hidden_at)在本机任务列表上的口径回归:
 * - local-db:sessions:list 排除隐藏任务,单任务读取仍返回(带 hiddenAt);
 * - setSessionHidden 是唯一宿主写入口:隐藏广播 hiddenAt patch 并收起灵动岛,
 *   恢复显示清列、刷新 updatedAt 并发「新建」推送让侧栏整体重拉。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  tapWindowBroadcast: vi.fn(),
  emitSessionCreated: vi.fn(),
  notifyAgentIslandSessionPatch: vi.fn(),
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
vi.mock('../../client/current', () => {
  const client = { get drizzle() { return h.db; } };
  return {
    getDbClient: () => client,
    getCurrentDbClientUserId: () => 'test-user',
    getCurrentDbClientSnapshot: () => ({ client, userId: 'test-user', clientEpoch: 1 }),
  };
});
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({ recomputePrRefsForSession: vi.fn(async () => undefined) }));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: h.notifyAgentIslandSessionPatch }));
vi.mock('../sessionCreatedBroadcast', () => ({ emitSessionCreated: h.emitSessionCreated }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionTaskSummary.js', () => ({ backfillPinnedSessionSummaries: vi.fn() }));
vi.mock('../../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn(), isTrustedAppRendererWindow: () => true }));

import { registerSessionIpc } from '../sessions';
import { setSessionHidden } from '../sessionHidden';
import { isSessionHiddenSync, resetHiddenSessionRegistryForTesting } from '../../hiddenSessionRegistry';

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
      scheduled_model_baseline TEXT,
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
      hidden_at INTEGER,
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
      agent_device_id TEXT,
      orca_remote_lead TEXT,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      im_default_route TEXT,
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
    INSERT INTO sessions (id, title, status, source, created_at, updated_at) VALUES
      ('visible', 'Visible', 'active', 'desktop', 1, 30),
      ('plugin-visible', 'Plugin visible', 'active', 'plugin', 1, 20),
      ('background', 'Background', 'active', 'plugin', 1, 10),
      ('deleted-bg', 'Deleted', 'deleted', 'plugin', 1, 5);
    UPDATE sessions SET hidden_at = 7 WHERE id IN ('background', 'deleted-bg');
  `);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

async function list(status: unknown = 'active'): Promise<string[]> {
  const handler = h.handlers.get('local-db:sessions:list')!;
  const rows = await handler({}, 100, status, { fresh: true }) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function readRow(id: string): { hidden_at: number | null; updated_at: number } {
  return h.sqlite!.prepare('SELECT hidden_at, updated_at FROM sessions WHERE id = ?').get(id) as {
    hidden_at: number | null; updated_at: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  createDb();
  resetHiddenSessionRegistryForTesting();
  registerSessionIpc();
});

describe('plugin background tasks in the local task list', () => {
  it('omits hidden tasks from every list filter but keeps single-task reads', async () => {
    expect(await list('active')).toEqual(['visible', 'plugin-visible']);
    expect(await list('all')).toEqual(['visible', 'plugin-visible']);
    const row = await h.handlers.get('local-db:sessions:get')!({}, 'background') as { hiddenAt: string | null };
    expect(row.hiddenAt).toBe(new Date(7).toISOString());
    const visible = await h.handlers.get('local-db:sessions:get')!({}, 'visible') as { hiddenAt: string | null };
    expect(visible.hiddenAt).toBeNull();
  });

  it('hides through the shared writer: patch broadcast, island cleanup and sync registry', async () => {
    expect(await setSessionHidden({ sessionId: 'plugin-visible', hidden: true, now: 100 })).toBe(true);
    expect(readRow('plugin-visible')).toEqual({ hidden_at: 100, updated_at: 20 });
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched',
      { sessionId: 'plugin-visible', patch: { hiddenAt: new Date(100).toISOString() } });
    expect(h.notifyAgentIslandSessionPatch).toHaveBeenCalledWith('plugin-visible', { hiddenAt: new Date(100).toISOString() });
    expect(h.emitSessionCreated).not.toHaveBeenCalled();
    expect(isSessionHiddenSync('plugin-visible')).toBe(true);
    expect(await list()).toEqual(['visible']);
    // Repeating the same state is a no-op without another broadcast.
    expect(await setSessionHidden({ sessionId: 'plugin-visible', hidden: true, now: 200 })).toBe(false);
    expect(h.tapWindowBroadcast).toHaveBeenCalledTimes(1);
  });

  it('reveals by clearing hidden_at, bumping updatedAt and announcing the task like a new one', async () => {
    expect(await setSessionHidden({ sessionId: 'background', hidden: false, now: 500 })).toBe(true);
    expect(readRow('background')).toEqual({ hidden_at: null, updated_at: 500 });
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched',
      { sessionId: 'background', patch: { hiddenAt: null, updatedAt: new Date(500).toISOString() } });
    expect(h.emitSessionCreated).toHaveBeenCalledWith('background');
    expect(h.notifyAgentIslandSessionPatch).not.toHaveBeenCalled();
    expect(isSessionHiddenSync('background')).toBe(false);
    expect(await list()).toEqual(['background', 'visible', 'plugin-visible']);
  });

  it('never touches deleted tasks and runs the caller check before writing', async () => {
    expect(await setSessionHidden({ sessionId: 'deleted-bg', hidden: false })).toBe(false);
    expect(readRow('deleted-bg').hidden_at).toBe(7);
    await expect(setSessionHidden({ sessionId: 'visible', hidden: true, assertCurrent: () => { throw new Error('changed'); } }))
      .rejects.toThrow('changed');
    expect(readRow('visible').hidden_at).toBeNull();
  });

  it('loads the sync registry from the database for tasks hidden before this process', async () => {
    expect(isSessionHiddenSync('background')).toBe(false);
    await list();
    await vi.waitFor(() => expect(isSessionHiddenSync('background')).toBe(true));
    expect(isSessionHiddenSync('visible')).toBe(false);
  });
});
