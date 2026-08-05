/**
 * sessionsRestoreIfArchived.test.ts — 批量恢复的持久层 compare-and-set 回归测试。
 *
 * 确认框期间会话可能被删除、由其他入口恢复或移动项目；真实 IPC handler 必须用
 * 一条条件 UPDATE 同时校验 archived 状态和项目身份，不能用 get + update 两步校验。
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
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
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

import { registerSessionIpc } from '../sessions';

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
      one_m INTEGER NOT NULL DEFAULT 0,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      orca_role TEXT,
      remote_host_id TEXT,
      codex_history_has_product_prompt INTEGER,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      summary TEXT,
      provider_id TEXT,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER
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
  vi.clearAllMocks();
  h.handlers.clear();
  createDb();
  registerSessionIpc();
});

describe('local-db:sessions:restore-if-archived', () => {
  it('restores when archived status and the full project identity still match', async () => {
    const updated = (await restore()) as { id: string; status: string };

    expect(updated).toMatchObject({ id: 'target', status: 'active' });
    expect(readStatus()).toBe('active');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'target',
      patch: { status: 'active' },
    });
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
});
