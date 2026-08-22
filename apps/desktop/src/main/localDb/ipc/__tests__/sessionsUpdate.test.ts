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

import { messages, sessions } from '../../schema';
import type { SessionRouteLock } from '../../sessionRouteLock';

type SessionRouteLockMock = SessionRouteLock &
  MockInstance<(sessionId: string, task: () => Promise<unknown>) => Promise<unknown>>;

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  relocate: vi.fn(async (): Promise<{ persistedSdkSessionId: string | null }> => ({
    persistedSdkSessionId: null,
  })),
  tapWindowBroadcast: vi.fn(),
  summarizeSession: vi.fn(async () => undefined),
  stopAndRemovePiSubagentRuns: vi.fn(async (_root: string) => true),
  writePiSubagentDeletedTombstone: vi.fn(async (_agentHome: string, _sessionId: string) => undefined),
  clearPiSubagentDeletedTombstone: vi.fn(async (_agentHome: string, _sessionId: string) => undefined),
  getMakerIfReady: vi.fn((): {
    isSessionAlive: (id: string) => boolean;
    closeSession: (id: string) => Promise<void>;
  } | null => null),
  setPinnedSectionCardMode: vi.fn(),
  upsertRecentWorkdir: vi.fn(async () => undefined),
  routeLock: vi.fn(async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> =>
    task(),
  ) as SessionRouteLockMock,
  userDataDir: null as string | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
  // status 写路径(removeHookAttachmentDir / removeTurnChangeSetsForSession)会调
  // app.getPath('userData') 并对真实文件系统做 fire-and-forget fs.rm。这里返回每次
  // 测试用 mkdtemp 生成的独立目录，避免并发 worktree 共享同一字面量路径互相删 fixture，
  // 也避免 Windows 把 POSIX 字面量解析成盘符根相对路径。
  app: { getPath: () => h.userDataDir },
}));
vi.mock('@cindy/maker-core/pi-subagent-runs', () => ({
  piSubagentRunRoot: (agentHome: string, sessionId: string) =>
    path.join(agentHome, 'runtime', 'pi-subagent-runs', sessionId),
  stopAndRemovePiSubagentRuns: h.stopAndRemovePiSubagentRuns,
  writePiSubagentDeletedTombstone: h.writePiSubagentDeletedTombstone,
  clearPiSubagentDeletedTombstone: h.clearPiSubagentDeletedTombstone,
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
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: h.upsertRecentWorkdir }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../../sessionTaskSummary.js', () => ({
  maybeGenerateSessionTaskSummary: h.summarizeSession,
  setPinnedSectionCardMode: h.setPinnedSectionCardMode,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../maker-host/claude-transcript-relocation.js', () => ({
  relocateClaudeTranscriptsForSessionMove: h.relocate,
}));
// Loaded dynamically by the cleanup's launcher gate; the real module pulls in
// the whole Host.
vi.mock('../../../maker-host/index.js', () => ({
  getMakerIfReady: h.getMakerIfReady,
}));
// delete 路径的 removeHookAttachmentDir 会真删 turn change-set;归档路径动态
// import cindy-brain(重副作用模块)。两者都 mock 掉,本文件只断言广播行为。
vi.mock('../../../turn-change-set/store.js', () => ({
  removeTurnChangeSetsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  notifyGhostSessionEvent: vi.fn(),
}));

import { registerSessionIpc, resumeDeletedPiSubagentCleanup } from '../sessions';
import { retireDeletedPiSubagentState } from '../piSubagentDeletion';
import { setSessionRouteLockImplementation } from '../../sessionRouteLock';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';

function createDb(): void {
  const sqlite = new Database(':memory:');
  // 与 schema.ts 的 sessions/messages 全列对齐(selectSessionWithCount select 全列)。
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
      codex_plan_json TEXT,
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
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

async function invokeUpdate(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:update');
  if (!handler) throw new Error('update handler not registered');
  return handler({}, id, patch);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.relocate.mockImplementation(async () => ({ persistedSdkSessionId: null }));
  h.routeLock.mockImplementation(async (_sessionId, task) => task());
  h.handlers.clear();
  h.stopAndRemovePiSubagentRuns.mockClear();
  h.stopAndRemovePiSubagentRuns.mockImplementation(async () => true);
  h.writePiSubagentDeletedTombstone.mockClear();
  h.writePiSubagentDeletedTombstone.mockImplementation(async () => undefined);
  h.clearPiSubagentDeletedTombstone.mockClear();
  h.clearPiSubagentDeletedTombstone.mockImplementation(async () => undefined);
  h.getMakerIfReady.mockReset();
  h.getMakerIfReady.mockReturnValue(null);
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cindy-sessions-update-'));
  createDb();
  setSessionRouteLockImplementation(h.routeLock);
  registerSessionIpc();
});

afterEach(async () => {
  setSessionRouteLockImplementation(null);
  const dir = h.userDataDir;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    h.userDataDir = null;
  }
});

describe('local-db:sessions:update handler wiring', () => {
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
      async () => new Promise((resolve) => { setTimeout(resolve, 40); }),
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
      userData, 'pi-agent-home', 'runtime', 'pi-subagent-runs', 'codex-local',
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
      () => { expect(closeSession.mock.calls.length).toBeGreaterThanOrEqual(2); },
      { timeout: 5_000 },
    );
    expect(closeSession).toHaveBeenCalledWith('codex-local');
    // Nothing was scanned or removed while the launcher could still fire.
    expect(h.stopAndRemovePiSubagentRuns).not.toHaveBeenCalled();
    expect(existsSync(runRoot)).toBe(true);

    // The parent finally goes away; the backoff retry re-runs the same gate.
    alive = false;
    await vi.waitFor(
      () => { expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalledWith(runRoot); },
      { timeout: 5_000 },
    );
  }, 20_000);

  it('leaves no runner behind when a launch races the scan of a deleted task', async () => {
    // The timing the finding describes, end to end: parent alive at cleanup
    // time, and a launch entering the moment the scan declares the root empty.
    const userData = h.userDataDir!;
    const runRoot = path.join(
      userData, 'pi-agent-home', 'runtime', 'pi-subagent-runs', 'codex-local',
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
    await vi.waitFor(() => { expect(h.stopAndRemovePiSubagentRuns).toHaveBeenCalled(); });

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
  });

  it('does nothing for remote sessions', async () => {
    await invokeUpdate('cc-remote', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
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
