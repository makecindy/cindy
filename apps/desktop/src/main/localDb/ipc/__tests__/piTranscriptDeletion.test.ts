/**
 * piTranscriptDeletion.test.ts — Issue #4596 契约红证。
 *
 * 删除一个 pi 会话（status='deleted'）后，引擎侧父会话 transcript
 * （sessions.sdk_session_id 指向的 <userData>/pi-agent-home/sessions/*.jsonl）
 * 必须被回收；崩溃漏删场景由 resumeDeletedPiSubagentCleanup() 在下次启动补扫。
 * 归档不在回收范围（可取消归档继续使用，引擎文件必须保留）。
 *
 * 边界（与 issue 机器人验收建议一致：不把 DB 字段当作任意删除授权）：
 *  - 只删 <userData>/pi-agent-home/sessions/ 根目录之内、归属该会话的文件；
 *  - 根目录之外 / 非绝对路径 / 空值的 sdk_session_id 一律不删；
 *  - 带 remoteHostId 的会话，其文件在远端主机上，本机绝不删除；
 *  - 其他会话的 transcript 与 codex/cc 引擎文件保持不动（另案处理）。
 *
 * 断言只经过公共写入口（local-db:sessions:update / patch-meta /
 * resumeDeletedPiSubagentCleanup）观察真实文件系统结果，不约束实现落点。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { messages, recentWorkdirs, sessions } from '../../schema';
import type { SessionRouteLock } from '../../sessionRouteLock';

type SessionRouteLockMock = SessionRouteLock &
  MockInstance<(sessionId: string, task: () => Promise<unknown>) => Promise<unknown>>;

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  client: null as { drizzle: ReturnType<typeof drizzle> } | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  relocate: vi.fn(async (): Promise<{ persistedSdkSessionId: string | null }> => ({
    persistedSdkSessionId: null,
  })),
  closeSession: vi.fn(async (_sessionId: string) => undefined),
  tapWindowBroadcast: vi.fn(),
  windows: [] as Array<{
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
  upsertRecentWorkdir: vi.fn(async () => true),
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
  getDbClient: () => h.client,
  getCurrentDbClientUserId: () => 'test-user',
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
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
  isTrustedAppRendererWindow: (w: { isDestroyed: () => boolean }) => !w.isDestroyed(),
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
vi.mock('../../../maker-host/index.js', () => ({
  getMakerIfReady: h.getMakerIfReady,
  withRehydrateCloseSuppressed: h.withRehydrateCloseSuppressed,
}));
vi.mock('../../../turn-change-set/store.js', () => ({
  removeTurnChangeSetsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  notifyGhostSessionEvent: vi.fn(),
}));

import {
  patchSessionMetaInDb,
  registerSessionIpc,
  resumeDeletedPiSubagentCleanup,
  setSessionRuntimeCleanup,
  setSessionWorktreeRecycle,
} from '../sessions';
import { setSessionRouteLockImplementation } from '../../sessionRouteLock';

const SESSIONS_ROOT = 'pi-agent-home';

function piSessionsRoot(userData: string): string {
  return path.join(userData, SESSIONS_ROOT, 'sessions');
}

function createDb(): void {
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
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
  `);
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, recentWorkdirs, sessions } });
  h.client = { drizzle: h.db };
}

function insertSession(row: {
  id: string;
  agentKind: string;
  sdkSessionId?: string | null;
  remoteHostId?: string | null;
  status?: string;
}): void {
  h.sqlite!
    .prepare(
      `INSERT INTO sessions (id, agent_kind, sdk_session_id, remote_host_id, workspace_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'dialogue', ?, 1, 1)`,
    )
    .run(row.id, row.agentKind, row.sdkSessionId ?? null, row.remoteHostId ?? null, row.status ?? 'active');
}

function writeTranscript(userData: string, name: string): string {
  const file = path.join(piSessionsRoot(userData), name);
  writeFileSync(file, '{"type":"session"}\n');
  return file;
}

async function invokeUpdate(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:update');
  if (!handler) throw new Error('update handler not registered');
  return handler({}, id, patch);
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.relocate.mockImplementation(async () => ({ persistedSdkSessionId: null }));
  h.routeLock.mockImplementation(async (_sessionId, task) => task());
  h.upsertRecentWorkdir.mockImplementation(async () => true);
  h.captureOwnerScope = false;
  h.ownerCurrent = true;
  h.requestRecycle.mockResolvedValue(undefined);
  h.handlers.clear();
  h.windows = [];
  h.stopAndRemovePiSubagentRuns.mockClear();
  h.stopAndRemovePiSubagentRuns.mockImplementation(async () => true);
  h.writePiSubagentDeletedTombstone.mockImplementation(async () => undefined);
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
  h.userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-transcript-del-'));
  await mkdir(piSessionsRoot(h.userDataDir), { recursive: true });
  createDb();
  setSessionRouteLockImplementation(h.routeLock);
  setSessionRuntimeCleanup(h.runtimeCleanup);
  setSessionWorktreeRecycle(h.requestRecycle);
  registerSessionIpc(undefined, { closeIdleSessionForMove: h.closeIdleSessionForMove });
});

afterEach(() => {
  setSessionRuntimeCleanup(null);
  setSessionWorktreeRecycle(null);
  setSessionRouteLockImplementation(null);
  const dir = h.userDataDir;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    h.userDataDir = null;
  }
});

describe('Issue #4596 — deleted pi session must reclaim its engine transcript', () => {
  it('removes the transcript file when the session is deleted through the update handler', async () => {
    const userData = h.userDataDir!;
    const transcript = writeTranscript(userData, 'pi-a.jsonl');
    insertSession({ id: 'pi-a', agentKind: 'pi', sdkSessionId: transcript });

    await invokeUpdate('pi-a', { status: 'deleted' });

    await vi.waitFor(() => {
      expect(existsSync(transcript)).toBe(false);
    }, { timeout: 4_000 });
  }, 15_000);

  it('removes the transcript file when deleted through the remote patch-meta handler', async () => {
    const userData = h.userDataDir!;
    const transcript = writeTranscript(userData, 'pi-meta.jsonl');
    insertSession({ id: 'pi-meta', agentKind: 'pi', sdkSessionId: transcript });

    await patchSessionMetaInDb('pi-meta', { status: 'deleted' });

    await vi.waitFor(() => {
      expect(existsSync(transcript)).toBe(false);
    }, { timeout: 4_000 });
  }, 15_000);

  it('reclaims transcripts of deleted pi sessions left behind at startup resume', async () => {
    const userData = h.userDataDir!;
    const transcript = writeTranscript(userData, 'pi-crashed.jsonl');
    insertSession({
      id: 'pi-crashed',
      agentKind: 'pi',
      sdkSessionId: transcript,
      status: 'deleted',
    });

    await resumeDeletedPiSubagentCleanup();

    await vi.waitFor(() => {
      expect(existsSync(transcript)).toBe(false);
    }, { timeout: 4_000 });
  }, 15_000);

  it('leaves the transcript in place when the session is only archived', async () => {
    const userData = h.userDataDir!;
    const transcript = writeTranscript(userData, 'pi-archived.jsonl');
    insertSession({ id: 'pi-archived', agentKind: 'pi', sdkSessionId: transcript });

    await invokeUpdate('pi-archived', { status: 'archived' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(existsSync(transcript)).toBe(true);
  }, 15_000);

  it('does not touch other sessions, foreign paths, or non-pi engine files on delete', async () => {
    const userData = h.userDataDir!;
    const doomed = writeTranscript(userData, 'pi-del.jsonl');
    const sibling = writeTranscript(userData, 'pi-sibling.jsonl');
    insertSession({ id: 'pi-del', agentKind: 'pi', sdkSessionId: doomed });
    insertSession({ id: 'pi-sibling', agentKind: 'pi', sdkSessionId: sibling });

    // sdk_session_id 不是 pi-agent-home/sessions 根内的绝对路径 → 无删除授权。
    const outside = path.join(userData, 'somewhere-else.jsonl');
    writeFileSync(outside, 'x\n');
    insertSession({ id: 'pi-outside', agentKind: 'pi', sdkSessionId: outside });
    insertSession({ id: 'pi-relative', agentKind: 'pi', sdkSessionId: 'pi-rel.jsonl' });
    insertSession({ id: 'pi-empty', agentKind: 'pi', sdkSessionId: null });

    // 远端主机上的 pi 会话：本机不存在其文件，绝不按本机路径删。
    const remoteLookalike = writeTranscript(userData, 'pi-remote.jsonl');
    insertSession({
      id: 'pi-remote',
      agentKind: 'pi',
      sdkSessionId: remoteLookalike,
      remoteHostId: 'host-1',
    });

    // codex 的 sdk_session_id 是线程 id 而非本机路径；同路径字面量不得被误删。
    const codexFile = writeTranscript(userData, 'codex-lookalike.jsonl');
    insertSession({ id: 'codex-row', agentKind: 'codex', sdkSessionId: codexFile });

    await invokeUpdate('pi-del', { status: 'deleted' });
    await invokeUpdate('pi-outside', { status: 'deleted' });
    await invokeUpdate('pi-relative', { status: 'deleted' });
    await invokeUpdate('pi-empty', { status: 'deleted' });
    await invokeUpdate('pi-remote', { status: 'deleted' });
    await invokeUpdate('codex-row', { status: 'deleted' });

    await vi.waitFor(() => {
      expect(existsSync(doomed)).toBe(false);
    }, { timeout: 4_000 });

    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(remoteLookalike)).toBe(true);
    expect(existsSync(codexFile)).toBe(true);
  }, 15_000);

  it('a missing transcript file never breaks the delete flow', async () => {
    const userData = h.userDataDir!;
    const gone = path.join(piSessionsRoot(userData), 'pi-gone.jsonl');
    insertSession({ id: 'pi-gone', agentKind: 'pi', sdkSessionId: gone });

    await expect(invokeUpdate('pi-gone', { status: 'deleted' })).resolves.toMatchObject({
      status: 'deleted',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(gone)).toBe(false);
  }, 15_000);
});
