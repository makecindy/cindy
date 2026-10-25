import { setSessionOpeningModelAdmission, type SessionOpenBody } from '../../sessionOpening';
/**
 * sessionsUpdate.test.ts — `local-db:sessions:update` handler 集成接线。
 * -------------------------------------------------------------------
 * 覆盖持久化后需要广播的增量字段，以及会话移动触发 CLI 转录迁移的边界：
 * workingDir 实际变化、且会话是本机 cc 会话时，必须在查询返回行之前调用
 * relocateClaudeTranscriptsForSessionMove(旧值 → 新值)，并把迁移中持久化的最新
 * sdkSessionId 并入返回行与广播 patch；其它会话或未实际移动时不得调用。
 *
 * 通过 mock electron ipcMain 捕获真实 handler + 内存 sqlite 全列 sessions 表做集成断言。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { InvokeResultPayload } from '@cindy/device-link';

import { messages, recentWorkdirs, sessions } from '../../schema';
import { tx as runDbTransaction } from '../../worker/opHandlers/tx';
import type { SessionRouteLock } from '../../sessionRouteLock';
import { normalizeWorkingDirForStorage } from '../../../../shared/workingDir';
import { isWorktreeMoveBlockedError } from '../../../../shared/worktreeMoveGuardError';
import {
  isSessionContextWindowBudgetCustomized,
  readSessionContextWindowBudget,
  writeSessionContextWindowBudget,
} from '../../../maker-host/session-context-budget-store.js';

type SessionRouteLockMock = SessionRouteLock &
  MockInstance<(sessionId: string, task: () => Promise<unknown>) => Promise<unknown>>;

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  client: null as { drizzle: ReturnType<typeof drizzle> } | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  setBadgeCount: vi.fn(),
  relocate: vi.fn(async (): Promise<{ persistedSdkSessionId: string | null }> => ({
    persistedSdkSessionId: null,
  })),
  closeSession: vi.fn(async (_sessionId: string) => undefined),
  closeSharedTask: vi.fn(async (_sessionId: string, _database: unknown): Promise<void> => undefined),
  prepareSharedTaskClosure: vi.fn(async (_sessionId: string, _database: unknown): Promise<{ sessionId: string; marker: number; rowIds: number[] } | null> => null),
  rollbackSharedTaskClosure: vi.fn(async (_database: unknown, _prepared: unknown) => undefined),
  finalizeSharedTaskClosure: vi.fn(async (_database: unknown, _prepared: unknown) => undefined),
  commitBotProfileDeletion: vi.fn(async (): Promise<{ status: 'archived' | 'deleted'; sessionIds: string[] }> => ({ status: 'archived', sessionIds: [] })),
  tapWindowBroadcast: vi.fn(),
  windows: [] as Array<{
    trusted?: boolean;
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
  summarizeSession: vi.fn(async () => undefined),
  stopAndRemovePiSubagentRuns: vi.fn(async (_root: string) => true),
  writePiSubagentDeletedTombstone: vi.fn(
    async (_agentHome: string, _sessionId: string) => undefined,
  ),
  clearPiSubagentDeletedTombstone: vi.fn(
    async (_agentHome: string, _sessionId: string) => undefined,
  ),
  getMakerIfReady: vi.fn(
    (): {
      isSessionAlive: (id: string) => boolean;
      closeSession: (id: string) => Promise<void>;
    } | null => null,
  ),
  closeIdleSessionForMove: vi.fn(async (_sessionId: string) => true),
  withRehydrateCloseSuppressed: vi.fn(async (_sessionId: string, task: () => Promise<void>) =>
    task(),
  ),
  setPinnedSectionCardMode: vi.fn(),
  upsertRecentWorkdir: vi.fn(
    async (
      _path: string | null | undefined,
      _atMs?: number,
      _platform?: NodeJS.Platform,
      _client?: { drizzle: ReturnType<typeof drizzle> },
    ) => true,
  ),
  captureOwnerScope: false,
  ownerCurrent: true,
  requestRecycle: vi.fn(async () => undefined),
  routeLock: vi.fn(async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> =>
    task(),
  ) as SessionRouteLockMock,
  runtimeCleanup: vi.fn(),
  compactSessionToolResultsBestEffort: vi.fn(async () => undefined),
  userDataDir: null as string | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => h.windows },
  // status 写路径(removeHookAttachmentDir / removeTurnChangeSetsForSession)会调
  // app.getPath('userData') 并对真实文件系统做 fire-and-forget fs.rm。这里返回每次
  // 测试用 mkdtemp 生成的独立目录，避免并发 worktree 共享同一字面量路径互相删 fixture，
  // 也避免 Windows 把 POSIX 字面量解析成盘符根相对路径。
  app: { getPath: () => h.userDataDir, setBadgeCount: h.setBadgeCount },
}));
vi.mock('@cindy/maker-core/pi-subagent-runs', () => ({
  piSubagentRunRoot: (agentHome: string, sessionId: string) =>
    path.join(agentHome, 'runtime', 'pi-subagent-runs', sessionId),
  stopAndRemovePiSubagentRuns: h.stopAndRemovePiSubagentRuns,
  writePiSubagentDeletedTombstone: h.writePiSubagentDeletedTombstone,
  clearPiSubagentDeletedTombstone: h.clearPiSubagentDeletedTombstone,
}));
vi.mock('../../../appSessionState', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner-a', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.userDataDir!, ...parts),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getCurrentDbClientSnapshot: () => h,
  getDbClient: () => h.client,
  getCurrentDbClientUserId: () => 'test-user',
}));
vi.mock('../../botProfileDeletionStore.js', () => ({
  commitBotProfileDeletion: h.commitBotProfileDeletion,
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/sharedTaskRuntime.js', () => ({
  closeSharedTaskForTask: h.closeSharedTask,
  prepareSharedTaskClosureForTask: h.prepareSharedTaskClosure,
  rollbackPreparedSharedTaskClosure: h.rollbackSharedTaskClosure,
  finalizePreparedSharedTaskClosure: h.finalizeSharedTaskClosure,
}));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: h.upsertRecentWorkdir }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() =>
    h.captureOwnerScope ? { ownerStamp: { dataOwnerId: 'owner-a', generation: 1 } } : null,
  ),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  isDataOwnerBroadcastScopeCurrent: vi.fn(() => h.ownerCurrent),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../../sessionTaskSummary.js', () => ({
  maybeGenerateSessionTaskSummary: h.summarizeSession,
  setPinnedSectionCardMode: h.setPinnedSectionCardMode,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: (w: { trusted?: boolean; isDestroyed: () => boolean }) =>
    !w.isDestroyed() && w.trusted !== false,
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../toolResultCompaction.js', () => ({
  compactSessionToolResultsBestEffort: h.compactSessionToolResultsBestEffort,
}));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../maker-host/claude-transcript-relocation.js', () => ({
  relocateClaudeTranscriptsForSessionMove: h.relocate,
}));
// Loaded dynamically by the cleanup's launcher gate; the real module pulls in
// the whole Host.
vi.mock('../../../maker-host/index.js', () => ({
  getMakerIfReady: h.getMakerIfReady,
  withRehydrateCloseSuppressed: h.withRehydrateCloseSuppressed,
}));
// delete 路径的 removeHookAttachmentDir 会真删 turn change-set;归档路径动态
// import cindy-brain(重副作用模块)。两者都 mock 掉,本文件只断言广播行为。
vi.mock('../../../turn-change-set/store.js', () => ({
  removeTurnChangeSetsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  notifyGhostSessionEvent: vi.fn(),
}));
// 偏好文件不可读时 store 会拒绝写（保留坏文件给人工修）：个别用例需要让它抛错。
vi.mock('../../../maker-host/session-context-budget-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../maker-host/session-context-budget-store.js')>();
  return { ...actual, writeSessionContextWindowBudget: vi.fn(actual.writeSessionContextWindowBudget) };
});

import {
  applyAgentSwitchToSessionRow,
  broadcastSessionPatched,
  deleteBotProfileAndDetachSessionsInDb,
  patchSessionMetaInDb,
  restoreArchivedSessionForSend,
  persistSessionFields,
  registerSessionIpc,
  resumeDeletedPiSubagentCleanup,
  setSessionRuntimeCleanup,
  setSessionWorktreeBindingLookup,
  setSessionWorktreeRecycle,
  updateSessionInDb,
  touchUserSendInDb,
} from '../sessions';
import {
  clearAllSessionAttention,
  getAttentionCount,
  markSessionNeedsAttention,
} from '../../../appBadgeService';
import { retireDeletedPiSubagentState } from '../piSubagentDeletion';
import { setSessionRouteLockImplementation } from '../../sessionRouteLock';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';
import { createRemoteSessionsStatusSetter } from '../../../mcp-integrations/sessionStatusRemote.js';
import * as sessionQueries from '../../sessionQueries';
import { setSessionRuntimeProjector } from '../../mapper';

function createDb(): void {
  const sqlite = new Database(':memory:');
  // 与 schema.ts 的 sessions/messages 全列对齐(selectSessionWithCount select 全列)。
  sqlite.exec(`
    CREATE TABLE task_tags (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      name_customized INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL,
      favorite_order INTEGER,
      sort_order INTEGER,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE session_task_tags (
      session_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (session_id, tag_id)
    );
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
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
  `);
  const insert = sqlite.prepare(`
    INSERT INTO sessions (id, working_dir, agent_kind, remote_host_id, workspace_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `);
  insert.run('cc-local', '/old/dir', 'cc', null, 'dialogue');
  insert.run('codex-local', '/old/dir', 'codex', null, 'dialogue');
  insert.run('pi-local', '/old/dir', 'pi', null, 'dialogue');
  insert.run('cc-remote', '/remote/dir', 'cc', 'host-1', 'project');
  sqlite
    .prepare(
      `
    INSERT INTO sessions (
      id, working_dir, agent_kind, remote_host_id, workspace_kind, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'review', 1, 1)
  `,
    )
    .run('review-local', '/review/dir', 'codex', null, 'dialogue');
  sqlite
    .prepare(
      `
    INSERT INTO sessions (
      id, working_dir, agent_kind, remote_host_id, workspace_kind, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'bot', 1, 1)
  `,
    )
    .run('bot-local', '/bot/dir', 'pi', null, 'dialogue');
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, recentWorkdirs, sessions } });
  h.client = { drizzle: h.db };
}

async function invokeUpdate(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:update');
  if (!handler) throw new Error('update handler not registered');
  return handler({}, id, patch);
}

async function invokePatchMeta(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:patch-meta');
  if (!handler) throw new Error('patch-meta handler not registered');
  return handler({}, id, patch);
}

async function invokeCreate(body: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:create');
  if (!handler) throw new Error('create handler not registered');
  return handler({ sender: { id: 7 } }, body);
}

beforeEach(() => {
  clearAllSessionAttention();
  setSessionOpeningModelAdmission(async body => body);
  vi.clearAllMocks();
  h.commitBotProfileDeletion.mockReset();
  h.relocate.mockImplementation(async () => ({ persistedSdkSessionId: null }));
  h.commitBotProfileDeletion.mockResolvedValue({ status: 'archived', sessionIds: [] });
  h.closeSession.mockClear();
  h.routeLock.mockImplementation(async (_sessionId, task) => task());
  h.upsertRecentWorkdir.mockImplementation(async () => true);
  h.captureOwnerScope = false;
  h.ownerCurrent = true;
  h.requestRecycle.mockResolvedValue(undefined);
  h.handlers.clear();
  h.windows = [];
  h.stopAndRemovePiSubagentRuns.mockClear();
  h.stopAndRemovePiSubagentRuns.mockImplementation(async () => true);
  h.writePiSubagentDeletedTombstone.mockClear();
  h.writePiSubagentDeletedTombstone.mockImplementation(async () => undefined);
  h.clearPiSubagentDeletedTombstone.mockClear();
  h.clearPiSubagentDeletedTombstone.mockImplementation(async () => undefined);
  h.getMakerIfReady.mockReset();
  h.closeIdleSessionForMove.mockReset();
  h.closeIdleSessionForMove.mockImplementation(async (sessionId) => {
    await h.withRehydrateCloseSuppressed(sessionId, () => h.closeSession(sessionId));
    return true;
  });
  h.withRehydrateCloseSuppressed.mockClear();
  h.withRehydrateCloseSuppressed.mockImplementation(async (_sessionId, task) => task());
  h.getMakerIfReady.mockReturnValue({ isSessionAlive: () => false, closeSession: h.closeSession });
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cindy-sessions-update-'));
  createDb();
  setSessionRouteLockImplementation(h.routeLock);
  setSessionRuntimeCleanup(h.runtimeCleanup);
  setSessionWorktreeRecycle(h.requestRecycle);
  setSessionWorktreeBindingLookup(null);
  registerSessionIpc(undefined, { closeIdleSessionForMove: h.closeIdleSessionForMove });
});

afterEach(async () => {
  setSessionRuntimeCleanup(null);
  setSessionWorktreeBindingLookup(null);
  setSessionWorktreeRecycle(null);
  setSessionRouteLockImplementation(null);
  const dir = h.userDataDir;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    h.userDataDir = null;
  }
});

describe('local-db:sessions:update handler wiring', () => {
  // Terminal lifecycle through both real public handlers: an ordinary fork survives,
  // but a hidden side chat must not remain running after its parent becomes unreachable (unit).
  it.each([invokeUpdate, invokePatchMeta])('deletes dependent side chats without deleting ordinary forks (%#)', async update => {
    // Unit, #6529: use the real terminal transaction so post-commit cleanup and
    // broadcasts cannot depend on writing a deleted child a second time.
    h.sqlite!.exec(`CREATE TABLE shared_task_events (shared_task_id TEXT, session_id TEXT,
      revision INTEGER, kind TEXT, terminal INTEGER, snapshot TEXT, recorded_at INTEGER,
      PRIMARY KEY (shared_task_id, kind, revision))`);
    Object.assign(h.client!, { tx: async (name: string, args: unknown) => runDbTransaction(h.sqlite!, { name, args }) });
    h.sqlite!.prepare("UPDATE sessions SET parent_session_id = 'cc-local', source = 'side-chat' WHERE id = 'codex-local'").run();
    h.sqlite!.prepare("UPDATE sessions SET parent_session_id = 'cc-local' WHERE id = 'pi-local'").run();
    await update('cc-local', { status: 'deleted' });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'deleted' });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('pi-local')).toEqual({ status: 'active' });
    expect(h.runtimeCleanup).toHaveBeenCalledWith('codex-local');
    expect(h.runtimeCleanup).not.toHaveBeenCalledWith('pi-local');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local', patch: { status: 'deleted' },
    });
  });
  it.each([invokeUpdate, invokePatchMeta])(
    'clears only the deleted task from event-backed app attention (%#)',
    async (update) => {
      // These tasks have not entered a renderer catalog projection yet.
      markSessionNeedsAttention('cc-local');
      markSessionNeedsAttention('codex-local');
      expect(getAttentionCount()).toBe(2);

      await update('cc-local', { status: 'deleted' });
      expect(getAttentionCount()).toBe(1);
      await update('codex-local', { status: 'deleted' });
      expect(getAttentionCount()).toBe(0);
      if (process.platform !== 'win32') expect(h.setBadgeCount).toHaveBeenLastCalledWith(0);
    },
  );

  it.each([invokeUpdate, invokePatchMeta])(
    'retains attention when deletion fails or the task is missing (%#)',
    async (update) => {
      markSessionNeedsAttention('cc-local');
      markSessionNeedsAttention('missing');
      h.sqlite!.exec(`CREATE TRIGGER reject_delete BEFORE UPDATE OF status ON sessions
        WHEN NEW.status = 'deleted' BEGIN SELECT RAISE(ABORT, 'write failed'); END`);
      await expect(update('cc-local', { status: 'deleted' })).rejects.toThrow('PRECONDITION_FAILED');
      expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local'))
        .toEqual({ status: 'active' });
      await expect(update('missing', { status: 'deleted' })).rejects.toThrow('NOT_FOUND');
      expect(getAttentionCount()).toBe(2);
    },
  );

  it.each([invokeUpdate, invokePatchMeta])(
    "does not clear a new owner's attention after an in-flight deletion (%#)",
    async (update) => {
      markSessionNeedsAttention('cc-local');
      h.captureOwnerScope = true;
      h.routeLock.mockImplementationOnce(async (_sessionId, task) => {
        const result = await task();
        h.ownerCurrent = false;
        return result;
      });
      await update('cc-local', { status: 'deleted' });
      expect(getAttentionCount()).toBe(1);
    },
  );

  it('clears deleted Bot task attention only after its transaction succeeds', async () => {
    markSessionNeedsAttention('bot-task');
    markSessionNeedsAttention('other-task');
    h.commitBotProfileDeletion.mockRejectedValueOnce(new Error('write failed'));
    await expect(deleteBotProfileAndDetachSessionsInDb('bot', ['bot-task'], false))
      .rejects.toThrow('write failed');
    expect(getAttentionCount()).toBe(2);

    h.commitBotProfileDeletion.mockResolvedValueOnce({ sessionIds: ['bot-task'], status: 'deleted' });
    await deleteBotProfileAndDetachSessionsInDb('bot', ['bot-task'], false);
    expect(getAttentionCount()).toBe(1);
  });

  it('preserves attention when Bot history is retained or the owner changes', async () => {
    markSessionNeedsAttention('bot-task');
    h.commitBotProfileDeletion.mockResolvedValueOnce({ sessionIds: ['bot-task'], status: 'archived' });
    await deleteBotProfileAndDetachSessionsInDb('bot', ['bot-task'], true);
    expect(getAttentionCount()).toBe(1);

    h.captureOwnerScope = true;
    h.commitBotProfileDeletion.mockImplementationOnce(async () => {
      h.ownerCurrent = false;
      return { sessionIds: ['bot-task'], status: 'deleted' };
    });
    await deleteBotProfileAndDetachSessionsInDb('bot', ['bot-task'], false);
    expect(getAttentionCount()).toBe(1);
  });

  it('rechecks window trust for both movement broadcasts after navigation', async () => {
    const trusted = {
      trusted: true,
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    const auxiliary = {
      trusted: false,
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    h.windows = [trusted, auxiliary];
    await invokeUpdate('codex-local', { workingDir: '/new/dir', workspaceKind: 'project' });
    expect(trusted.webContents.send).toHaveBeenCalledWith('local-db:recent-workdirs:changed', {
      path: '/new/dir',
    });
    expect(trusted.webContents.send).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({ sessionId: 'codex-local' }),
    );
    expect(auxiliary.webContents.send).not.toHaveBeenCalled();

    trusted.webContents.send.mockClear();
    trusted.trusted = false;
    await invokeUpdate('codex-local', { workingDir: '/another/dir', workspaceKind: 'project' });
    await invokeUpdate('codex-local', { workspaceKind: 'dialogue' });
    expect(trusted.webContents.send).not.toHaveBeenCalled();
    expect(auxiliary.webContents.send).not.toHaveBeenCalled();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({ sessionId: 'codex-local' }),
    );
  });

  it('isolates device-link and renderer failures while broadcasting a session patch', () => {
    const failedWindowSend = vi.fn(() => {
      throw new Error('window closed');
    });
    const healthyWindowSend = vi.fn();
    h.tapWindowBroadcast.mockImplementationOnce(() => {
      throw new Error('tap unavailable');
    });
    h.windows = [
      { isDestroyed: vi.fn(() => false), webContents: { send: failedWindowSend } },
      { isDestroyed: vi.fn(() => false), webContents: { send: healthyWindowSend } },
    ];

    expect(() =>
      broadcastSessionPatched('s-projection', {
        contextTokens: 0,
        contextWindow: 272_000,
      }),
    ).not.toThrow();
    expect(failedWindowSend).toHaveBeenCalledOnce();
    expect(healthyWindowSend).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 's-projection',
      patch: { contextTokens: 0, contextWindow: 272_000 },
    });
  });

  it('rejects new SSH writable roots because the picker is not on the remote filesystem', async () => {
    await expect(
      invokeCreate({
        id: 'ssh-forged',
        agentKind: 'codex',
        workingDir: '/remote/repo',
        remoteHostId: 'host-1',
        writableDirs: ['/remote/outside'],
      }),
    ).rejects.toThrow(/can only be revoked/i);
    expect(
      h.sqlite!.prepare('SELECT id FROM sessions WHERE id = ?').get('ssh-forged'),
    ).toBeUndefined();
  });

  it('rejects renderer-side directory grant writes outside the atomic maker handlers', async () => {
    await expect(invokeUpdate('cc-local', { writableDirs: ['/forged'] })).rejects.toThrow(
      /maker:set-\*-dirs/i,
    );
    await expect(invokeUpdate('cc-local', { extraDirs: ['/forged-read'] })).rejects.toThrow(
      /maker:set-\*-dirs/i,
    );
  });

  it('recovers cleanup only for deleted parent tasks after restart', async () => {
    const userData = h.userDataDir!;
    const parentRoot = path.join(userData, 'pi-agent-home', 'runtime', 'pi-subagent-runs');
    await Promise.all([
      mkdir(path.join(parentRoot, 'codex-local'), { recursive: true }),
      mkdir(path.join(parentRoot, 'cc-local'), { recursive: true }),
    ]);
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');

    await resumeDeletedPiSubagentCleanup();
    await vi.waitFor(() => {
      expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledTimes(1);
    });
    expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledWith(
      path.join(parentRoot, 'codex-local'),
    );
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalledWith(
      path.join(parentRoot, 'cc-local'),
    );
    expect(h.writePiSubagentDeletedTombstone).toHaveBeenCalledWith(
      path.join(userData, 'pi-agent-home'),
      'codex-local',
    );
    expect(h.writePiSubagentDeletedTombstone.mock.invocationCallOrder[0]!).toBeLessThan(
      h.stopAndRemovePiSubagentRuns.mock.invocationCallOrder[0]!,
    );
  });

  it('reviving a deleted IM session cancels pending cleanup and clears the tombstone', async () => {
    const userData = h.userDataDir!;
    const agentHome = path.join(userData, 'pi-agent-home');
    h.writePiSubagentDeletedTombstone.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(resolve, 40);
        }),
    );
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('pi-local');

    await resumeDeletedPiSubagentCleanup();
    await retireDeletedPiSubagentState('pi-local');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.clearPiSubagentDeletedTombstone).toHaveBeenCalledWith(agentHome, 'pi-local');
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalled();
  });

  it('recovers tombstones for deleted PI tasks that never grew a run root', async () => {
    const userData = h.userDataDir!;
    const agentHome = path.join(userData, 'pi-agent-home');
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('pi-local');

    await resumeDeletedPiSubagentCleanup();
    await vi.waitFor(() => {
      expect(h.writePiSubagentDeletedTombstone).toHaveBeenCalledWith(agentHome, 'pi-local');
      expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledWith(
        path.join(agentHome, 'runtime', 'pi-subagent-runs', 'pi-local'),
      );
    });
    expect(h.writePiSubagentDeletedTombstone).not.toHaveBeenCalledWith(agentHome, 'cc-local');
  });

  it('writes the deleted-task tombstone even while this process never loaded the parent', async () => {
    // Codex P1: another supported instance sharing userData can still have the
    // parent PI alive. A local Maker miss is not proof that no launcher exists.
    const userData = h.userDataDir!;
    const agentHome = path.join(userData, 'pi-agent-home');
    const parentRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs');
    await mkdir(path.join(parentRoot, 'codex-local'), { recursive: true });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
    h.getMakerIfReady.mockReturnValue(null);

    await resumeDeletedPiSubagentCleanup();
    await vi.waitFor(() => {
      expect(h.writePiSubagentDeletedTombstone).toHaveBeenCalledWith(agentHome, 'codex-local');
      expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledTimes(1);
    });
    expect(h.writePiSubagentDeletedTombstone.mock.invocationCallOrder[0]!).toBeLessThan(
      h.stopAndRemovePiSubagentRuns.mock.invocationCallOrder[0]!,
    );
  });

  it('raises the deleted-task tombstone while the local parent is still closing', async () => {
    const userData = h.userDataDir!;
    const agentHome = path.join(userData, 'pi-agent-home');
    const runRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs', 'codex-local');
    await mkdir(runRoot, { recursive: true });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
    h.getMakerIfReady.mockReturnValue({
      isSessionAlive: () => true,
      closeSession: vi.fn(async () => undefined),
    });

    await resumeDeletedPiSubagentCleanup();
    await vi.waitFor(() => {
      expect(h.writePiSubagentDeletedTombstone).toHaveBeenCalledWith(agentHome, 'codex-local');
    });
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalled();
  });

  it('does not run the conclusive scan when the deleted-task tombstone cannot be written', async () => {
    const userData = h.userDataDir!;
    const parentRoot = path.join(userData, 'pi-agent-home', 'runtime', 'pi-subagent-runs');
    await mkdir(path.join(parentRoot, 'codex-local'), { recursive: true });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
    h.writePiSubagentDeletedTombstone.mockRejectedValue(new Error('disk full'));

    await resumeDeletedPiSubagentCleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalled();
  });

  it('will not run the conclusive scan while the deleted task is still loaded', async () => {
    // The scan ends by finding an empty run root and deleting it. Only the
    // parent PI process can launch a durable Subagent, so while it is alive a
    // launch can enter *after* that scan — recreating the root and spawning a
    // detached runner on the deleted task's credentials, with cleanup already
    // reporting success and its retry timer thrown away.
    const userData = h.userDataDir!;
    const runRoot = path.join(
      userData,
      'pi-agent-home',
      'runtime',
      'pi-subagent-runs',
      'codex-local',
    );
    await mkdir(runRoot, { recursive: true });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');

    let alive = true;
    // A close that does not confirm termination leaves the session in `error`,
    // which still reads as alive — the case the gate has to keep refusing on.
    const closeSession = vi.fn(async () => undefined);
    h.getMakerIfReady.mockReturnValue({ isSessionAlive: () => alive, closeSession });

    await resumeDeletedPiSubagentCleanup();
    // Twice, so the gate is pinned to *every* attempt rather than the first:
    // the backoff retry re-enters the same body, and a parent that was alive
    // when one attempt gave up is exactly the case the later ones must recheck.
    await vi.waitFor(
      () => {
        expect(closeSession.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5_000 },
    );
    expect(closeSession).toHaveBeenCalledWith('codex-local');
    // Nothing was scanned or removed while the launcher could still fire.
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalled();
    expect(existsSync(runRoot)).toBe(true);

    // The parent finally goes away; the backoff retry re-runs the same gate.
    alive = false;
    await vi.waitFor(
      () => {
        expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledWith(runRoot);
      },
      { timeout: 5_000 },
    );
  }, 20_000);

  it('leaves no runner behind when a launch races the scan of a deleted task', async () => {
    // The timing the finding describes, end to end: parent alive at cleanup
    // time, and a launch entering the moment the scan declares the root empty.
    const userData = h.userDataDir!;
    const runRoot = path.join(
      userData,
      'pi-agent-home',
      'runtime',
      'pi-subagent-runs',
      'codex-local',
    );
    await mkdir(runRoot, { recursive: true });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');

    const spawnedRunDir = path.join(runRoot, '123e4567-e89b-42d3-a456-426614174090');
    let alive = true;
    h.getMakerIfReady.mockReturnValue({
      isSessionAlive: () => alive,
      // Closing the parent is what actually ends the launcher. The run it had
      // already published its intent for is still on disk — that one the scan
      // can see, and must stop.
      closeSession: vi.fn(async () => {
        await mkdir(spawnedRunDir, { recursive: true });
        alive = false;
      }),
    });
    h.stopAndRemovePiSubagentRuns.mockImplementation(async (root: string) => {
      const entries = await readdir(root).catch(() => [] as string[]);
      await rm(root, { recursive: true, force: true });
      // An empty root is the conclusive verdict — and while the parent lives,
      // a launch lands in exactly the window that verdict just opened.
      if (entries.length === 0 && alive) await mkdir(spawnedRunDir, { recursive: true });
      return true;
    });

    await resumeDeletedPiSubagentCleanup();
    await vi.waitFor(() => {
      expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalled();
    });

    // Cleanup reported success, so nothing will look at this task again: the
    // root has to be genuinely gone, with no orphan inside it.
    expect(existsSync(spawnedRunDir)).toBe(false);
    expect(existsSync(runRoot)).toBe(false);
  }, 20_000);

  it('does not resurrect a deleted task through the generic status writer', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');

    await expect(invokeUpdate('codex-local', { status: 'active' })).rejects.toThrow(
      '[PRECONDITION_FAILED]',
    );

    const persisted = h
      .sqlite!.prepare('SELECT status FROM sessions WHERE id = ?')
      .get('codex-local') as { status: string };
    expect(persisted.status).toBe('deleted');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(h.routeLock).toHaveBeenCalledWith('codex-local', expect.any(Function));
  });

  it.each([false, true])('restores and broadcasts without reacquiring a held direct-send lease (held: %s)', async routeLockHeld => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
    // A lease is already held outside ALS by direct send. Any re-entry would
    // deadlock; the ordinary composer still acquires this route lock once.
    h.routeLock.mockClear();
    await restoreArchivedSessionForSend('codex-local', { routeLockHeld });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'active' });
    expect(h.routeLock).toHaveBeenCalledTimes(routeLockHeld ? 0 : 1);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', expect.objectContaining({
      sessionId: 'codex-local', patch: { status: 'active' },
    }));
  });

  // PR #6403 P1: entry-time abort tests missed cancellation during DB awaits.
  // Run the production restore/writer against SQLite, interrupting its read
  // continuations or the issued write. DB tier; no timers or copied handler.
  it.each(['initial-read', 'lifecycle-read', 'issued-write'] as const)(
    'honors the restore commit boundary when cancelled at %s', async stage => {
      h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
      const controller = new AbortController();
      const prepare = h.sqlite!.prepare.bind(h.sqlite!);
      const interrupted = vi.spyOn(h.sqlite!, 'prepare').mockImplementation(sql => {
        const selected = stage === 'initial-read' ? sql.startsWith('select "status", "source"')
          : stage === 'lifecycle-read' ? sql.startsWith('select "source" from "sessions"')
          : sql.startsWith('update "sessions"');
        if (selected) queueMicrotask(() => controller.abort());
        return prepare(sql);
      });
      try {
        const restoring = restoreArchivedSessionForSend('codex-local', { routeLockHeld: true, signal: controller.signal });
        if (stage === 'issued-write') await restoring;
        else await expect(restoring).rejects.toThrow('Session send aborted');
        expect(controller.signal.aborted).toBe(true);
        expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local'))
          .toEqual({ status: stage === 'issued-write' ? 'active' : 'archived' });
        if (stage === 'issued-write') expect(h.tapWindowBroadcast).toHaveBeenCalled();
        else expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
      } finally { interrupted.mockRestore(); }
    },
  );

  it.each(['deleted', 'bot', 'worker', 'remote-worker'] as const)('does not restore %s tasks through ordinary send', async kind => {
    h.sqlite!.prepare('UPDATE sessions SET status = ?, source = ?, orca_role = ?, orca_remote_lead = ? WHERE id = ?')
      .run(kind === 'deleted' ? 'deleted' : 'archived', kind === 'bot' ? 'bot' : 'desktop',
        kind === 'worker' ? 'worker' : null, kind === 'remote-worker' ? '{}' : null, 'codex-local');
    await expect(restoreArchivedSessionForSend('codex-local')).rejects.toThrow(
      kind === 'deleted' ? '[NOT_FOUND]' : '[PRECONDITION_FAILED]',
    );
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local'))
      .toEqual({ status: kind === 'deleted' ? 'deleted' : 'archived' });
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('does not write or broadcast for an already active task', async () => {
    await restoreArchivedSessionForSend('codex-local');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('rechecks task status after acquiring the route lock', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
    h.routeLock.mockImplementationOnce(async (_id, task) => {
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
      return task();
    });
    await expect(restoreArchivedSessionForSend('codex-local')).rejects.toThrow('[NOT_FOUND]');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('does not restore after the task owner changes', async () => {
    h.captureOwnerScope = true;
    h.ownerCurrent = false;
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
    await expect(restoreArchivedSessionForSend('codex-local')).rejects.toThrow('Task owner changed');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'archived' });
  });

  it('keeps the last legal sessions.effort when a fixed-effort model switch patches null', async () => {
    await persistSessionFields('pi-local', {
      model: 'x-ai-grok/grok-4.6',
      effort: null,
      fastMode: false,
    });

    const persisted = h
      .sqlite!.prepare('SELECT model, effort, fast_mode FROM sessions WHERE id = ?')
      .get('pi-local') as { model: string; effort: string; fast_mode: number };
    expect(persisted).toEqual({
      model: 'x-ai-grok/grok-4.6',
      effort: 'high',
      fast_mode: 0,
    });
  });

  it('rejects an out-of-range task context window budget instead of silently clearing it', async () => {
    // 与隧道入口同口径：<1000 会被 normalize 变成 null（等于静默清掉用户预算），
    // 超大值会被静默夹到上限；调用方却收到成功回包。宁可显式拒绝。
    await expect(invokeUpdate('cc-local', { contextWindowBudget: 999 })).rejects.toThrow(
      /contextWindowBudget must be null or an integer/,
    );
    await expect(invokeUpdate('cc-local', { contextWindowBudget: 300_000.5 })).rejects.toThrow(
      /contextWindowBudget must be null or an integer/,
    );
    await expect(invokeUpdate('cc-local', { contextWindowBudget: 100_000_001 })).rejects.toThrow(
      /contextWindowBudget must be null or an integer/,
    );
  });

  it('persists null and an in-range task context window budget', async () => {
    // 任务窗口预算不是会话列（没有 context_window_budget 列），而是 main 侧偏好文件里的
    // 条目：这里读写它自己的 store（路径由 electron 的 userData mock 指到临时目录）。
    await invokeUpdate('cc-local', { contextWindowBudget: 300_000 });
    expect(readSessionContextWindowBudget('cc-local')).toBe(300_000);
    expect(isSessionContextWindowBudgetCustomized('cc-local')).toBe(true);

    await invokeUpdate('cc-local', { contextWindowBudget: null });
    expect(readSessionContextWindowBudget('cc-local')).toBeNull();
    expect(isSessionContextWindowBudgetCustomized('cc-local')).toBe(false);
  });

  it('keeps the row update when the budget store refuses to write', async () => {
    // 偏好文件不可读时 store 拒绝写（保留坏文件给人工修）。行更新与广播都已提交，
    // 预算失败不能带走同一个 patch 里的其它字段，也不能让 IPC 抛错盖掉已生效的改名
    // （GLM-5.3 独立审查，2026-10-24）。
    vi.mocked(writeSessionContextWindowBudget).mockImplementationOnce(() => {
      throw new Error('session context budget settings file is unreadable');
    });
    await expect(invokeUpdate('cc-local', {
      contextWindowBudget: 300_000,
      title: 'renamed-despite-budget-failure',
    })).resolves.toBeDefined();
    expect(readSessionContextWindowBudget('cc-local')).toBeNull();
  });

  it('fails a budget-only update when the budget store refuses to write', async () => {
    // 纯预算请求只有这一个意图：吞掉错误就是「看着成功、实际还是旧窗口」，
    // 用户想靠缩小窗口省钱时会被骗（Greptile P1，2026-10-24）。
    vi.mocked(writeSessionContextWindowBudget).mockImplementationOnce(() => {
      throw new Error('session context budget settings file is unreadable');
    });
    await expect(invokeUpdate('cc-local', { contextWindowBudget: 300_000 })).rejects.toThrow(
      /unreadable/,
    );
    expect(readSessionContextWindowBudget('cc-local')).toBeNull();
  });

  it('does not mirror a remote budget into the next account after an owner change', async () => {
    // 远程镜像落库（persistSessionFields）同样是 await 之后才写偏好文件：保存期间切账号，
    // 这条过期更新不得把预算写进新账号的文件（Greptile P1，2026-10-24）。
    h.captureOwnerScope = true;
    h.ownerCurrent = false;
    await persistSessionFields('pi-local', { contextWindowBudget: 300_000 });
    expect(readSessionContextWindowBudget('pi-local')).toBeNull();
  });

  it('does not write the context window budget into the next account after an owner change', async () => {
    // 偏好文件按「当前」账号的 userData 解析，而 DB 更新是 await 出来的：保存期间切账号
    // 时，过期请求不得把原任务的预算写进新账号的文件（Greptile P1，2026-10-24）。
    h.captureOwnerScope = true;
    h.ownerCurrent = false;
    await invokeUpdate('cc-local', { contextWindowBudget: 300_000 });
    expect(readSessionContextWindowBudget('cc-local')).toBeNull();
  });

  it.each(['model', 'harness'])('projects the saved owner choice during an automatic %s switch', async (kind) => {
    const baseline = JSON.stringify({ scopeId: 'run', agentKind: 'pi', model: 'owner-model',
      providerId: 'owner-provider', effort: 'high', fastMode: true });
    h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?').run(baseline, 'pi-local');
    const project = vi.fn((row: { scheduledModelBaseline?: string | null }) =>
      row.scheduledModelBaseline ? { model: 'owner-model' } : {});
    setSessionRuntimeProjector(project);
    try {
      if (kind === 'harness') {
        await applyAgentSwitchToSessionRow('pi-local', {
          agentKind: 'codex', model: 'automatic-model', providerId: null,
        });
      } else {
        await persistSessionFields('pi-local', { model: 'automatic-model' });
      }
      expect(project).toHaveBeenCalledWith(expect.objectContaining({
        model: 'automatic-model', scheduledModelBaseline: baseline,
      }));
      expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', expect.objectContaining({
        sessionId: 'pi-local', patch: expect.objectContaining({ model: 'owner-model' }),
      }));
    } finally {
      setSessionRuntimeProjector(null);
    }
  });

  it('rejects setting drift for retained Review tasks while preserving metadata edits', async () => {
    await expect(invokeUpdate('review-local', { effort: 'low' })).rejects.toThrow(
      /Review task settings are fixed/,
    );
    await invokeUpdate('review-local', { title: '审查记录' });

    const persisted = h
      .sqlite!.prepare('SELECT effort, title FROM sessions WHERE id = ?')
      .get('review-local') as { effort: string; title: string };
    expect(persisted).toEqual({ effort: 'high', title: '审查记录' });
  });

  it('keeps Bot metadata editable but rejects ordinary lifecycle writes', async () => {
    await invokeUpdate('bot-local', { title: 'Release Bot' });
    await expect(invokeUpdate('bot-local', { status: 'archived' })).rejects.toThrow(
      /Bot task lifecycle/,
    );

    const persisted = h
      .sqlite!.prepare('SELECT title, status FROM sessions WHERE id = ?')
      .get('bot-local') as { title: string; status: string };
    expect(persisted).toEqual({ title: 'Release Bot', status: 'active' });
  });

  it('persists and broadcasts title-only patches to device-link subscribers', async () => {
    await invokeUpdate('codex-local', { title: '排查远程标题同步' });

    const persisted = h
      .sqlite!.prepare('SELECT title FROM sessions WHERE id = ?')
      .get('codex-local') as { title: string };
    expect(persisted.title).toBe('排查远程标题同步');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: expect.objectContaining({ title: '排查远程标题同步' }),
      }),
    );
  });

  it('broadcasts permission setting patches to every mounted client', async () => {
    await invokeUpdate('codex-local', { permissionMode: 'ask' });

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: { permissionMode: 'ask' },
      }),
    );
  });

  it('broadcasts status-only patches so secondary windows converge on delete', async () => {
    await invokeUpdate('cc-local', { status: 'deleted' });

    const persisted = h
      .sqlite!.prepare('SELECT status FROM sessions WHERE id = ?')
      .get('cc-local') as { status: string };
    expect(persisted.status).toBe('deleted');
    // #3175 回归:纯 status 变化(无 title / settings / project / pinnedAt)也必须广播
    // sessions:patched,否则「在新窗口打开」的副窗口收不到删除,仍停留在旧视图。
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'cc-local',
        patch: { status: 'deleted' },
      }),
    );
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'cc-local' }),
    );
  });

  it.each([
    ['generic', 'archived'],
    ['generic', 'deleted'],
    ['patch-meta', 'archived'],
    ['patch-meta', 'deleted'],
  ] as const)('preserves project activity through %s %s', async (writer, status) => {
    h.sqlite!.prepare(
      "UPDATE sessions SET workspace_kind = 'project', source = 'desktop' WHERE id = ?",
    ).run('codex-local');
    // Exercise the real upsert against this test's isolated SQLite database.
    const real = await vi.importActual<typeof import('../recentWorkdirs')>('../recentWorkdirs');
    h.upsertRecentWorkdir.mockImplementation(async (dir, atMs, platform) =>
      real.upsertRecentWorkdir(dir, atMs, platform),
    );
    const sentAt = 1_786_500_050_000;
    await touchUserSendInDb('codex-local', sentAt);
    h.upsertRecentWorkdir.mockClear();

    if (writer === 'generic') await invokeUpdate('codex-local', { status });
    else await invokePatchMeta('codex-local', { status });

    expect(h.upsertRecentWorkdir).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT * FROM recent_workdirs').all()).toEqual([
      { path: '/old/dir', last_used_at: sentAt },
    ]);
    // Even physically removing the last task must leave the project's timestamp intact.
    h.sqlite!.prepare('DELETE FROM sessions WHERE id = ?').run('codex-local');
    expect(h.sqlite!.prepare('SELECT * FROM recent_workdirs').all()).toEqual([
      { path: '/old/dir', last_used_at: sentAt },
    ]);
  });

  it.each(['archived', 'deleted'] as const)(
    'does not retain scheduler projects when the generic writer marks them %s',
    async (status) => {
      h.sqlite!.prepare(
        "UPDATE sessions SET workspace_kind = 'project', source = 'scheduler' WHERE id = ?",
      ).run('codex-local');

      await invokeUpdate('codex-local', { status });

      expect(h.upsertRecentWorkdir).not.toHaveBeenCalled();
    },
  );

  it('does not register a worker directory when its project target changes', async () => {
    h.sqlite!.prepare("UPDATE sessions SET orca_role = 'worker' WHERE id = ?").run('codex-local');

    await invokeUpdate('codex-local', { workingDir: '/worker/dir', workspaceKind: 'project' });

    expect(h.upsertRecentWorkdir).not.toHaveBeenCalled();
  });

  it('suppresses the recent-project refresh after an owner switch', async () => {
    h.sqlite!.prepare("UPDATE sessions SET workspace_kind = 'project' WHERE id = ?").run(
      'codex-local',
    );
    h.captureOwnerScope = true;
    h.windows = [{ isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }];
    h.routeLock.mockImplementationOnce(async (_sessionId, task) => {
      const result = await task();
      h.ownerCurrent = false;
      return result;
    });

    await invokeUpdate('codex-local', { workspaceKind: 'project' });

    expect(h.upsertRecentWorkdir).toHaveBeenCalledWith(
      '/old/dir',
      expect.any(Number),
      process.platform,
      h.client,
    );
    expect(h.windows[0]?.webContents.send).not.toHaveBeenCalledWith(
      'local-db:recent-workdirs:changed',
      expect.anything(),
    );
  });

  it('broadcasts local unarchive status patches to every window (#3175)', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');

    await invokeUpdate('codex-local', { status: 'active' });
    await vi.dynamicImportSettled();

    const persisted = h
      .sqlite!.prepare('SELECT status FROM sessions WHERE id = ?')
      .get('codex-local') as { status: string };
    expect(persisted.status).toBe('active');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { status: 'active' },
    });
    expect(h.compactSessionToolResultsBestEffort).not.toHaveBeenCalled();
  });

  // setStatus 的归档形是 { status, pinnedAt: null }:广播沿用置顶合并逻辑,
  // 归档一并清 pin 与摘要(归档列表不该保留 pin 标记)。
  it('broadcasts local archive status patches with the unpin merge (#3175)', async () => {
    await invokeUpdate('codex-local', { status: 'archived', pinnedAt: null });
    await vi.dynamicImportSettled();

    const persisted = h
      .sqlite!.prepare('SELECT status, pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { status: string; pinnedAt: number | null };
    expect(persisted.status).toBe('archived');
    expect(persisted.pinnedAt).toBeNull();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { status: 'archived', pinnedAt: null, summary: null },
    });
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'codex-local' }),
    );
  });

  it('cleans runtime state before releasing the local terminal status lock', async () => {
    const order: string[] = [];
    h.prepareSharedTaskClosure.mockImplementationOnce(async () => {
      order.push('sharing-prepared');
      return { sessionId: 'codex-local', marker: 1, rowIds: [7] };
    });
    h.runtimeCleanup.mockImplementationOnce(() => order.push('runtime-cleanup'));
    h.closeSharedTask.mockImplementationOnce(async () => { order.push('sharing-closed'); });
    h.routeLock.mockImplementationOnce(async (_sessionId, task) => {
      const result = await task();
      order.push('lock-released');
      h.sqlite!.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run('codex-local');
      return result;
    });

    await invokeUpdate('codex-local', { status: 'archived' });

    expect(order).toEqual(['sharing-prepared', 'runtime-cleanup', 'sharing-closed', 'lock-released']);
    expect(h.runtimeCleanup).toHaveBeenCalledOnce();
    expect(h.closeSharedTask).toHaveBeenCalledWith('codex-local', h.client);
  });

  it('restores an archived task through the remote adapter and existing patch-meta handler', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
      expect(channel).toBe('local-db:sessions:patch-meta');
      return { ok: true as const, result: await invokePatchMeta(args[0] as string, args[1] as Record<string, unknown>) };
    });
    const restore = createRemoteSessionsStatusSetter({ captureAccess: () => () => {}, invoke });
    expect(await restore({ deviceId: 'studio', sessionIds: ['codex-local'], status: 'active' })).toMatchObject({
      ok: true, changed: [{ sessionId: 'codex-local', status: 'active' }],
    });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'active' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(h.closeSharedTask).not.toHaveBeenCalled();
  });

  it('reports an unknown remote result when the receipt query overloads after the status write', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run('codex-local');
    const receiptQuery = vi.spyOn(sessionQueries, 'selectSessionWithCount')
      .mockRejectedValueOnce(new Error('db worker RPC queue overloaded'));
    try {
      let handlerError: unknown;
      const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]): Promise<InvokeResultPayload> => {
        try {
          return { ok: true as const, result: await invokePatchMeta(args[0] as string, args[1] as Record<string, unknown>) };
        } catch (error) {
          handlerError = error;
          // Preserve the handler error as dispatch does: newer hosts may wrap it first.
          const message = error instanceof Error ? error.message : String(error);
          const code = message.includes('db worker RPC queue overloaded') ? 'BACKPRESSURE' : 'IPC_ERROR';
          return { ok: false as const, error: { code, message } };
        }
      });
      const restore = createRemoteSessionsStatusSetter({ captureAccess: () => () => {}, invoke });
      expect(await restore({ deviceId: 'studio', sessionIds: ['codex-local', 'unattempted'], status: 'active' })).toMatchObject({
        ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN', changed: [],
        message: expect.stringContaining('请先查询目标任务状态'),
        failedSessionId: 'codex-local', remainingSessionIds: ['unattempted'],
      });
      expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'active' });
      expect(handlerError).toBeInstanceOf(Error);
      expect((handlerError as Error).message).toBe('[PRECONDITION_FAILED] Worktree is busy or its recovery record could not be saved');
      expect(receiptQuery).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      receiptQuery.mockRestore();
    }
  });

  it.each(['active', 'archived'] as const)('remote patch-meta cannot change a deleted task to %s', async (status) => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
    await expect(invokePatchMeta('codex-local', { status })).rejects.toThrow('已删除的任务不能恢复或归档');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'deleted' });
  });

  it('cleans runtime state before releasing the remote terminal status lock', async () => {
    const order: string[] = [];
    h.prepareSharedTaskClosure.mockImplementationOnce(async () => {
      order.push('sharing-prepared');
      return { sessionId: 'codex-local', marker: 1, rowIds: [7] };
    });
    h.runtimeCleanup.mockImplementationOnce(() => order.push('runtime-cleanup'));
    h.closeSharedTask.mockImplementationOnce(async () => { order.push('sharing-closed'); });
    h.routeLock.mockImplementationOnce(async (_sessionId, task) => {
      const result = await task();
      order.push('lock-released');
      h.sqlite!.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run('codex-local');
      return result;
    });

    await patchSessionMetaInDb('codex-local', { status: 'archived' });

    expect(order).toEqual(['sharing-prepared', 'runtime-cleanup', 'sharing-closed', 'lock-released']);
    expect(h.runtimeCleanup).toHaveBeenCalledOnce();
    expect(h.closeSharedTask).toHaveBeenCalledWith('codex-local', h.client);
  });

  // Real status writer + SQLite: completion guards run inside resource locks and
  // again after recycle preparation, before any lifecycle write (integration).
  it('rejects a superseded completed card after worktree preparation without archiving it', async () => {
    let current = true;
    h.requestRecycle.mockImplementationOnce(async () => { current = false; });
    await expect(patchSessionMetaInDb('codex-local', { status: 'archived' }, {
      beforeWrite: () => { if (!current) throw new Error('card changed'); },
    })).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'active' });
    expect(h.runtimeCleanup).not.toHaveBeenCalled();
    expect(h.prepareSharedTaskClosure).not.toHaveBeenCalled();
  });

  it('does not commit a terminal status when the shared-task journal cannot be prepared', async () => {
    h.prepareSharedTaskClosure.mockRejectedValueOnce(new Error('disk failed'));

    await expect(invokeUpdate('codex-local', { status: 'archived' })).rejects.toThrow(
      'Worktree is busy or its recovery record could not be saved',
    );
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('codex-local')).toEqual({ status: 'active' });
    expect(h.closeSharedTask).not.toHaveBeenCalled();
    expect(h.rollbackSharedTaskClosure).not.toHaveBeenCalled();
  });

  it('rolls back a prepared shared-task journal when the terminal status write fails', async () => {
    h.prepareSharedTaskClosure.mockImplementationOnce(async () => {
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
      return { sessionId: 'codex-local', marker: 1, rowIds: [7] };
    });

    await expect(invokeUpdate('codex-local', { status: 'archived' })).rejects.toThrow('已删除的任务不能恢复或归档');
    expect(h.rollbackSharedTaskClosure).toHaveBeenCalledWith(h.client, {
      sessionId: 'codex-local', marker: 1, rowIds: [7],
    });
    expect(h.closeSharedTask).not.toHaveBeenCalled();
  });

  it.each([true, false])('closes shared tasks when Bot deletion transitions sessions to terminal status (keep=%s)', async (keepTaskHistory) => {
    h.commitBotProfileDeletion.mockResolvedValue({
      status: keepTaskHistory ? 'archived' : 'deleted',
      sessionIds: ['bot-local', 'bot-local'],
    });

    await deleteBotProfileAndDetachSessionsInDb('bot-1', ['bot-local'], keepTaskHistory);
    await vi.dynamicImportSettled();

    expect(h.closeSharedTask).toHaveBeenCalledExactlyOnceWith('bot-local', h.client);
  });

  // 竞态收敛(review on #3225):写入与查询不在同一串行区间,归档写入后、查询前
  // 另一窗口可能已把行推进到 deleted。广播必须携带持久化后的 updated.status,
  // 否则副窗/控制端镜像会被请求值回滚成旧 UI 状态(已删除任务复活)。
  // routeLock 是测试注入的实现:在锁内写库完成后、handler 继续查询前,模拟
  // 另一窗口的删除落库。
  it('broadcasts the persisted status when a concurrent window deletes between write and read', async () => {
    h.routeLock.mockImplementation(async (_sessionId, task) => {
      await task();
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('codex-local');
    });

    await invokeUpdate('codex-local', { status: 'archived' });
    await vi.dynamicImportSettled();

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { status: 'deleted' },
    });
    // 不再出现携带请求值的回滚广播
    const statusPatches = h.tapWindowBroadcast.mock.calls
      .filter(([channel]) => channel === 'local-db:sessions:patched')
      .map(([, payload]) => (payload as { patch: { status?: string } }).patch.status);
    expect(statusPatches).toEqual(['deleted']);
  });

  // 竞态收敛(review on #3225 第二轮):读行与广播之间还有 await(摘要清理 /
  // recent-workdir / 转录迁移),期间另一窗口可删除并先广播 deleted;本 handler
  // 恢复后若用旧快照广播 archived,该广播是最后一条,镜像不会自愈——已删任务
  // 持久复活。upsertRecentWorkdir 是已 mock 的依赖:在其 await 期间模拟删除落库,
  // 断言广播前重读了状态。
  it('re-reads status before broadcasting when an await intervenes after the row read', async () => {
    h.upsertRecentWorkdir.mockImplementationOnce(async () => {
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
      return true;
    });

    await invokeUpdate('cc-local', { status: 'archived', workspaceKind: 'project' });
    await vi.dynamicImportSettled();

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'cc-local',
      patch: expect.objectContaining({ status: 'deleted' }),
    });
    const statusPatches = h.tapWindowBroadcast.mock.calls
      .filter(([channel]) => channel === 'local-db:sessions:patched')
      .map(([, payload]) => (payload as { patch: { status?: string } }).patch.status);
    expect(statusPatches).toEqual(['deleted']);
  });

  it('broadcasts pin and unpin patches to device-link subscribers', async () => {
    const pinnedAt = '2026-08-03T04:08:26.000Z';
    await invokeUpdate('codex-local', { pinnedAt });
    await vi.dynamicImportSettled();

    const pinned = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null };
    expect(pinned.pinnedAt).toBe(Date.parse(pinnedAt));
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt, status: 'active' },
    });
    expect(h.summarizeSession).toHaveBeenCalledWith('codex-local', { force: true });

    h.tapWindowBroadcast.mockClear();
    h.summarizeSession.mockClear();
    h.sqlite!.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(
      'PR 已提交并开启，相关单测通过。',
      'codex-local',
    );
    await invokeUpdate('codex-local', { pinnedAt: null });

    const unpinned = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt, summary FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null; summary: string | null };
    expect(unpinned.pinnedAt).toBeNull();
    expect(unpinned.summary).toBeNull();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt: null, summary: null },
    });
    expect(h.summarizeSession).not.toHaveBeenCalled();
  });

  it('broadcasts the stored value and skips summary generation for an invalid pin date', async () => {
    await invokeUpdate('codex-local', { pinnedAt: 'not-a-date' });
    await vi.dynamicImportSettled();

    const persisted = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null };
    expect(persisted.pinnedAt).toBeNull();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt: null, summary: null },
    });
    expect(h.summarizeSession).not.toHaveBeenCalled();
  });

  it('relocates transcripts when workingDir actually changes on a local cc session', async () => {
    await invokeUpdate('cc-local', { workingDir: '/new/dir', workspaceKind: 'project' });

    expect(h.relocate).toHaveBeenCalledTimes(1);
    expect(h.relocate).toHaveBeenCalledWith('cc-local', '/old/dir', '/new/dir');
  });

  it.each([{ workingDir: '/new/dir', workspaceKind: 'project' }, { workspaceKind: 'dialogue' }])(
    'runs MCP move checks inside the route lock before persisting %j',
    async (patch) => {
      let locked = false;
      h.routeLock.mockImplementation(async (_id, task) => {
        locked = true;
        try {
          return await task();
        } finally {
          locked = false;
        }
      });
      const beforeUpdate = vi.fn(async () => {
        expect(locked).toBe(true);
        throw Object.assign(new Error('[PRECONDITION_FAILED] move blocked'), {
          code: 'PRECONDITION_FAILED',
        });
      });
      await expect(
        updateSessionInDb('cc-local', patch, undefined, {
          assertCurrent: () => undefined,
          beforeUpdate,
        }),
      ).rejects.toThrow('move blocked');
      expect(beforeUpdate).toHaveBeenCalledOnce();
      expect(
        h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'),
      ).toEqual({ working_dir: '/old/dir' });
      expect(h.relocate).not.toHaveBeenCalled();
      expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    },
  );

  it('checks the move account fence again after closing an idle runtime and before writing', async () => {
    let current = true;
    h.closeIdleSessionForMove.mockImplementationOnce(async () => {
      current = false;
      return true;
    });
    await expect(
      updateSessionInDb('codex-local', { workingDir: '/new/dir' }, undefined, {
        beforeUpdate: async () => undefined,
        assertCurrent: () => {
          if (!current)
            throw Object.assign(new Error('[PRECONDITION_FAILED] account changed'), {
              code: 'PRECONDITION_FAILED',
            });
        },
      }),
    ).rejects.toThrow('account changed');
    expect(
      h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('codex-local'),
    ).toEqual({ working_dir: '/old/dir' });
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  // #6399, unit: a mutable authorization check must precede runtime close, not
  // just the final DB write; previous coverage only revoked after that close.
  it.each(['codex-local', 'pi-local'])('does not close %s when the pre-mutation check rejects', async (id) => {
    await expect(updateSessionInDb(id, { workingDir: '/new/dir' }, undefined, {
      assertCurrent: () => undefined,
      beforeUpdate: async () => undefined,
      beforeWrite: async () => { throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED'); },
    })).rejects.toThrow('PRECONDITION_FAILED');
    expect(h.closeIdleSessionForMove).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(id))
      .toEqual({ working_dir: '/old/dir' });
  });

  it('retains transcript relocation and returned resume identity for a guarded MCP move', async () => {
    const updated = await updateSessionInDb(
      'cc-local',
      { workingDir: '/new/dir', workspaceKind: 'project' },
      undefined,
      {
        beforeUpdate: async () => undefined,
        assertCurrent: () => undefined,
      },
    );
    expect(updated.workingDir).toBe('/new/dir');
    expect(h.relocate).toHaveBeenCalledWith('cc-local', '/old/dir', '/new/dir', {
      client: h.client,
      assertCurrent: expect.any(Function),
    });
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({ sessionId: 'cc-local' }),
    );
  });

  it.each(['cc-local', 'codex-local', 'pi-local'])(
    'awaits the final mutable move check after preparing %s',
    async (id) => {
      let prepared = false;
      h.relocate.mockImplementation(async () => {
        prepared = true;
        return { persistedSdkSessionId: null };
      });
      h.closeIdleSessionForMove.mockImplementation(async () => {
        prepared = true;
        return true;
      });
      await expect(
        updateSessionInDb(id, { workingDir: '/new/dir' }, undefined, {
          beforeUpdate: async () => undefined,
          assertCurrent: () => undefined,
          beforeWrite: async () => {
            await Promise.resolve();
            if (prepared)
              throw Object.assign(new Error('[PRECONDITION_FAILED] new worker running'), {
                code: 'PRECONDITION_FAILED',
              });
          },
        }),
      ).rejects.toThrow('new worker running');
      expect(prepared).toBe(true);
      expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(id)).toEqual({
        working_dir: '/old/dir',
      });
      expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    },
  );

  it.each(['during relocation', 'after commit'])(
    'keeps cwd and transcripts aligned when the account switches %s',
    async (phase) => {
      let current = true;
      const readCwd = () =>
        (
          h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local') as {
            working_dir: string;
          }
        ).working_dir;
      h.relocate.mockImplementationOnce(async () => {
        expect(readCwd()).toBe('/old/dir');
        if (phase === 'during relocation') current = false;
        return { persistedSdkSessionId: null };
      });
      await expect(
        updateSessionInDb(
          'cc-local',
          { workingDir: '/new/dir', workspaceKind: 'project' },
          undefined,
          {
            beforeUpdate: async () => undefined,
            assertCurrent: () => {
              if (phase === 'after commit' && readCwd() === '/new/dir') current = false;
              if (!current)
                throw Object.assign(new Error('[PRECONDITION_FAILED] account changed'), {
                  code: 'PRECONDITION_FAILED',
                });
            },
          },
        ),
      ).rejects.toThrow('account changed');
      expect(h.relocate).toHaveBeenCalledOnce();
      expect(readCwd()).toBe(phase === 'after commit' ? '/new/dir' : '/old/dir');
      expect(h.upsertRecentWorkdir).not.toHaveBeenCalled();
      expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    },
  );

  it('keeps the original cwd if persistence fails after transcript copying', async () => {
    h.sqlite!.exec(
      "CREATE TRIGGER reject_move BEFORE UPDATE OF working_dir ON sessions BEGIN SELECT RAISE(ABORT, 'move write failed'); END",
    );
    await expect(invokeUpdate('cc-local', { workingDir: '/new/dir' })).rejects.toThrow(
      'Worktree is busy or its recovery record could not be saved',
    );
    expect(h.relocate).toHaveBeenCalledOnce();
    expect(
      h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'),
    ).toEqual({ working_dir: '/old/dir' });
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('returns and broadcasts the sdkSessionId persisted during relocation', async () => {
    const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // 模拟真实编排:迁移把内存 id 持久化进 DB 并上报;handler 必须在迁移后才查
    // 返回行,并把该 id 并入广播 patch,renderer 才不会留着旧 resume id。
    h.relocate.mockImplementation(async () => {
      h.sqlite!.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(
        liveId,
        'cc-local',
      );
      return { persistedSdkSessionId: liveId };
    });

    const updated = (await invokeUpdate('cc-local', {
      workingDir: '/new/dir',
      workspaceKind: 'project',
    })) as { sdkSessionId: string | null };

    expect(updated.sdkSessionId).toBe(liveId);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'cc-local',
        patch: expect.objectContaining({ sdkSessionId: liveId }),
      }),
    );
  });

  it('does nothing when the patched workingDir equals the current one', async () => {
    await invokeUpdate('cc-local', { workingDir: '/old/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when a legacy Windows spelling normalizes to the patched workingDir', async () => {
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(
      'D:\\repo\\project',
      'cc-local',
    );

    await invokeUpdate('cc-local', { workingDir: 'D:/repo/project' });

    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when the patch has no workingDir (move back to dialogue)', async () => {
    await invokeUpdate('cc-local', { workspaceKind: 'dialogue' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing for codex sessions', async () => {
    await invokeUpdate('codex-local', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
    expect(h.closeSession).toHaveBeenCalledWith('codex-local');
  });

  it.each(['codex-local', 'pi-local'])(
    'uses registered move dependencies when updating %s directly without opts',
    async (sessionId) => {
      const workingDir = path.join(os.tmpdir(), 'moved-session');
      const storedWorkingDir = normalizeWorkingDirForStorage(workingDir);

      const updated = await updateSessionInDb(sessionId, { workingDir });

      expect(h.closeIdleSessionForMove).toHaveBeenCalledExactlyOnceWith(sessionId);
      expect(updated.workingDir).toBe(storedWorkingDir);
      expect(
        h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(sessionId),
      ).toEqual({ working_dir: storedWorkingDir });
    },
  );

  it('honors the registered busy-runtime result when updating directly without opts', async () => {
    h.closeIdleSessionForMove.mockResolvedValueOnce(false);

    await expect(
      updateSessionInDb('codex-local', { workingDir: path.join(os.tmpdir(), 'moved-session') }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');

    expect(h.closeIdleSessionForMove).toHaveBeenCalledExactlyOnceWith('codex-local');
    expect(
      h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('codex-local'),
    ).toEqual({ working_dir: '/old/dir' });
  });

  it('closes a local Pi runtime before moving its working directory', async () => {
    h.sqlite!.prepare('UPDATE sessions SET agent_kind = ? WHERE id = ?').run('pi', 'codex-local');

    await invokeUpdate('codex-local', { workingDir: '/new/dir' });

    expect(h.closeSession).toHaveBeenCalledWith('codex-local');
    expect(h.withRehydrateCloseSuppressed).toHaveBeenCalledWith(
      'codex-local',
      expect.any(Function),
    );
  });

  it('rejects moving a local Pi/Codex session whose turn became active', async () => {
    h.closeIdleSessionForMove.mockResolvedValueOnce(false);

    await expect(invokeUpdate('codex-local', { workingDir: '/new/dir' })).rejects.toThrow(
      '[PRECONDITION_FAILED]',
    );

    expect(
      h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('codex-local'),
    ).toEqual({ working_dir: '/old/dir' });
    expect(h.closeSession).not.toHaveBeenCalled();
  });

  it('does not reacquire the route lock for a combined workingDir and status patch', async () => {
    await invokeUpdate('codex-local', { workingDir: '/new/dir', status: 'active' });

    expect(h.routeLock).toHaveBeenCalledTimes(1);
  });

  it('does nothing for remote sessions', async () => {
    await invokeUpdate('cc-remote', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
    expect(h.closeSession).not.toHaveBeenCalled();
  });

  it('refuses to move a task whose working directory is a managed worktree', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktreeDir, 'cc-local');

    await expect(invokeUpdate('cc-local', { workingDir: '/new/dir' }))
      .rejects.toThrow(/cannot be moved outside its worktree/i);

    // 拒绝发生在任何写库/关 runtime 之前:归属分裂的“半移动”不会落盘。
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: worktreeDir });
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('still allows moving a worktree session back to a dialogue', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktreeDir, 'cc-local');

    // 「移到对话」的 patch 不带 workingDir:归属根本不参与判定,只改 workspaceKind,
    // 目录仍停在 worktree 里(与 renderer 预检、与 Main 的 beforeMove 门控同口径)。
    await invokeUpdate('cc-local', { workspaceKind: 'dialogue' });

    expect(
      h.sqlite!.prepare('SELECT working_dir, workspace_kind FROM sessions WHERE id = ?').get('cc-local'),
    ).toEqual({ working_dir: worktreeDir, workspace_kind: 'dialogue' });
  });

  it('allows moving between subdirectories of the same managed worktree', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    const from = path.join(worktreeDir, 'src');
    const to = path.join(worktreeDir, 'tests');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(from, 'cc-local');

    // 归属根相同（都是 steady-goodall）:不是跨 worktree 移动,与注释里的「子目录归到根」一致。
    await invokeUpdate('cc-local', { workingDir: to });

    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: to.replace(/\\/g, '/') });
  });

  it('refuses clearing the working directory of a worktree session', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktreeDir, 'cc-local');

    // 显式清空同样是改归属:不能因为「不是字符串」就放过。
    await expect(invokeUpdate('cc-local', { workingDir: null }))
      .rejects.toThrow(/cannot be moved outside its worktree/i);
    await expect(invokeUpdate('cc-local', { workingDir: '  ' }))
      .rejects.toThrow(/cannot be moved outside its worktree/i);
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: worktreeDir });

    // 普通会话不受影响;未传该键的 update(如移到对话)也照旧。
    await invokeUpdate('codex-local', { workingDir: null });
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('codex-local'))
      .toEqual({ working_dir: null });
  });

  it('refuses further moves for a session still bound to a worktree after an earlier half-move', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    // 旧版允许过的半移动存量行:cwd 已经落在普通项目,worktree 绑定还在旧 worktree。
    // 只看 cwd 会漏掉这类行,归属必须问 worktreeStore(组合层注入)。
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ?, worktree_path = ? WHERE id = ?')
      .run('/other/project', worktreeDir, 'cc-local');
    setSessionWorktreeBindingLookup((sessionId) => (sessionId === 'cc-local' ? worktreeDir : null));

    await expect(invokeUpdate('cc-local', { workingDir: '/another/project' }))
      .rejects.toThrow(/cannot be moved outside its worktree/i);
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: '/other/project' });

    // 移回它自己的 worktree 是修复而不是跨根,应当放行。
    await invokeUpdate('cc-local', { workingDir: worktreeDir });
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: worktreeDir.replace(/\\/g, '/') });
  });

  it('allows moving a session whose worktree was already recycled', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'recycled-name');
    // 回收后 store 里没有绑定(注入查询返回 null),但 cwd 与快照仍留着历史 worktree 路径:
    // 归属以 store 为准,这类会话不能被永久拦死。
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ?, worktree_path = ? WHERE id = ?')
      .run(worktreeDir, worktreeDir, 'cc-local');
    setSessionWorktreeBindingLookup(() => null);

    await invokeUpdate('cc-local', { workingDir: '/another/project' });

    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: '/another/project' });
  });

  it('does not treat a recycled worktree snapshot as a live binding', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'recycled-name');
    // 回收后 worktreeStore 删条目但保留 DB 快照(徽标以 store 为准):这类行不应被拦住。
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ?, worktree_path = ? WHERE id = ?')
      .run('/other/project', worktreeDir, 'cc-local');
    setSessionWorktreeBindingLookup(() => null);

    await invokeUpdate('cc-local', { workingDir: '/another/project' });

    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: '/another/project' });
  });

  it('refuses the same move through the shared entry point used by the MCP tools', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktreeDir, 'codex-local');

    // MCP 的 move_sessions 等非 IPC 调用方直接走 updateSessionInDb:守卫必须同样生效,
    // 且让调用方看到「需要 handoff」而不是笼统的移动失败。
    const rejected = await updateSessionInDb('codex-local', { workingDir: '/new/dir' })
      .then(() => null, (err: unknown) => err);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((rejected as Error).message).toMatch(/worktree handoff is required/i);
    // renderer 按共享契约识别这次拒绝(同一常量,两侧不手写漂移)。
    expect(isWorktreeMoveBlockedError(rejected)).toBe(true);

    expect(h.closeIdleSessionForMove).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('codex-local'))
      .toEqual({ working_dir: worktreeDir });
  });

  it('allows binding a task to the worktree created for it', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');

    await invokeUpdate('cc-local', { workingDir: worktreeDir });

    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: worktreeDir.replace(/\\/g, '/') });
  });

  it('allows a no-op move that stays inside the same worktree root', async () => {
    const worktreeDir = path.join(h.userDataDir!, '.cindy-worktrees', 'steady-goodall');
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktreeDir, 'cc-local');

    await invokeUpdate('cc-local', { workingDir: worktreeDir.replace(/\\/g, '/') });

    expect(h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('cc-local'))
      .toEqual({ working_dir: worktreeDir.replace(/\\/g, '/') });
  });
});

async function invokeSetPinnedCardSummaries(event: unknown, enabled: unknown): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:set-pinned-card-summaries');
  if (!handler) throw new Error('set-pinned-card-summaries handler not registered');
  return handler(event, enabled);
}

describe('local-db:sessions:set-pinned-card-summaries', () => {
  it('boolean 主路径先校验 sender 再通知摘要开关', async () => {
    await invokeSetPinnedCardSummaries({ senderFrame: { url: 'cindy://app' } }, true);
    await vi.dynamicImportSettled();

    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(1);
    expect(h.setPinnedSectionCardMode).toHaveBeenCalledWith(true);
  });

  it('非 boolean 走 INVALID_PARAMS,不改摘要开关', async () => {
    await expect(invokeSetPinnedCardSummaries({}, 'yes')).rejects.toThrow(/INVALID_PARAMS/);
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(1);
    expect(h.setPinnedSectionCardMode).not.toHaveBeenCalled();
  });

  it('sender 守卫失败时不加载摘要模块', async () => {
    vi.mocked(assertTrustedAppRendererEvent).mockImplementationOnce(() => {
      throw new Error('UNTRUSTED_RENDERER');
    });
    await expect(invokeSetPinnedCardSummaries({}, true)).rejects.toThrow('UNTRUSTED_RENDERER');
    expect(h.setPinnedSectionCardMode).not.toHaveBeenCalled();
  });
});

it('opens a normal renderer task through shared model admission', async () => {
  const admission = vi.fn(async (body: SessionOpenBody) => ({ ...body, agentKind: 'codex' as const,
    model: 'selected-model', providerId: 'selected-provider', effort: '', fastMode: false }));
  setSessionOpeningModelAdmission(admission);
  await invokeCreate({ id: 'normal-open', title: 'Normal task', workspaceKind: 'project', permissionMode: 'auto' });
  expect(admission).toHaveBeenCalledOnce();
  expect(h.sqlite!.prepare('SELECT model, provider_id, effort, permission_mode FROM sessions WHERE id = ?').get('normal-open'))
    .toEqual({ model: 'selected-model', provider_id: 'selected-provider', effort: '', permission_mode: 'auto' });
});
it('does not create a renderer task when common model admission fails', async () => {
  setSessionOpeningModelAdmission(async () => { throw new Error('model unavailable'); });
  await expect(invokeCreate({ id: 'rejected-open', title: 'Rejected task' })).rejects.toThrow('model unavailable');
  expect(h.sqlite!.prepare('SELECT id FROM sessions WHERE id = ?').get('rejected-open')).toBeUndefined();
});
