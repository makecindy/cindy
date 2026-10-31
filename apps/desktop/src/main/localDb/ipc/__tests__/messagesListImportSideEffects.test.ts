/**
 * messagesListImportSideEffects.test.ts — #318 A3。
 * ------------------------------------------------------------------------------------
 * 验证 `local-db:messages:list` 只为旧版导入的任务（codex-/claude- 前缀）运行一次存量接入：
 *   - 普通任务 → 不接入;
 *   - 旧导入任务 → 打开前接入这一条;
 *   - device-link 分页仍跳过;
 *   - 接入失败 → 被吞并(warn),不冒泡。
 * 既覆盖可注入纯函数 `runMessagesListImportSideEffects`,也通过真实 handler + 真实
 * `runDeviceLinkInvokeContext`(AsyncLocalStorage)做一次集成断言。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
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
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  classifyCodexHistoryOversized: vi.fn(async () => false),
}));
vi.mock('../../../session-import/legacy', () => ({
  adoptLegacySessionBeforeOpen: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { registerMessageIpc, runMessagesListImportSideEffects } from '../messages';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context';
import { adoptLegacySessionBeforeOpen } from '../../../session-import/legacy';

const adoptMock = vi.mocked(adoptLegacySessionBeforeOpen);

function createDb(sessionId = 's1'): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER
    );
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
    );
  `);
  sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run(sessionId);
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

describe('runMessagesListImportSideEffects (injectable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('device-link 分页路径(默认 opts)→ 跳过接入', async () => {
    const adoptLegacy = vi.fn(async () => undefined);
    await runMessagesListImportSideEffects('codex-s1', { isDeviceLink: () => true, adoptLegacy });
    expect(adoptLegacy).not.toHaveBeenCalled();
  });

  it('旧导入任务的首页请求(deviceLinkFirstPage)→ 接入这一条', async () => {
    const adoptLegacy = vi.fn(async () => undefined);
    await runMessagesListImportSideEffects('claude-s1', { isDeviceLink: () => true, adoptLegacy }, { deviceLinkFirstPage: true });
    expect(adoptLegacy).toHaveBeenCalledWith('claude-s1');
  });

  it('普通任务 → 不接入', async () => {
    const adoptLegacy = vi.fn(async () => undefined);
    await runMessagesListImportSideEffects('s1', { isDeviceLink: () => false, adoptLegacy });
    expect(adoptLegacy).not.toHaveBeenCalled();
  });

  it('接入失败被吞并,不冒泡', async () => {
    const adoptLegacy = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(runMessagesListImportSideEffects('codex-s1', { isDeviceLink: () => false, adoptLegacy })).resolves.toBeUndefined();
    expect(adoptLegacy).toHaveBeenCalledTimes(1);
  });
});

describe('local-db:messages:list × import side-effects (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.handlers.clear();
  });

  it('普通任务 invoke → 不接入', async () => {
    createDb('s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    await listHandler?.({}, 's1', { limit: 10 });

    expect(adoptMock).not.toHaveBeenCalled();
  });

  it('device-link 旧 Codex 导入任务首页 invoke → 接入这一条', async () => {
    createDb('codex-s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 'codex-s1', { limit: 10 }),
    );

    expect(adoptMock).toHaveBeenCalledTimes(1);
    expect(adoptMock).toHaveBeenCalledWith('codex-s1');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('device-link 分页 invoke(带 beforeTs)→ 跳过接入(#318 性能语义)', async () => {
    createDb('codex-s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 'codex-s1', { limit: 10, beforeTs: Date.now() }),
    );

    expect(adoptMock).not.toHaveBeenCalled();
    expect(Array.isArray(rows)).toBe(true);
  });
});
