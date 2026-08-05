/**
 * messagesListImportSideEffects.test.ts — #318 A3。
 * ------------------------------------------------------------------------------------
 * 验证 `local-db:messages:list` 在 device-link 远程读路径上跳过「外部 CLI 历史导入」副作用,
 * 而本机(非 device-link)路径仍按原有语义串行触发两个 importer:
 *   - device-link 路径(isDeviceLinkInvoke()=true)→ 两个 importer 都不调用;
 *   - 本机路径 → codex / claude importer 均按顺序调用一次;
 *   - importer reject → 被吞并(warn),不冒泡。
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
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { registerMessageIpc, runMessagesListImportSideEffects } from '../messages';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context';
import { importExternalCodexMessagesForSession } from '../../../maker-host/codex-local-sessions';
import { importExternalClaudeCodeMessagesForSession } from '../../../maker-host/claude-local-sessions';

const codexMock = vi.mocked(importExternalCodexMessagesForSession);
const claudeMock = vi.mocked(importExternalClaudeCodeMessagesForSession);

function createDb(): Database.Database {
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
  sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

describe('runMessagesListImportSideEffects (injectable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('device-link 分页路径(默认 opts)→ 跳过两个 importer', async () => {
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects('s1', {
      isDeviceLink: () => true,
      importCodex,
      importClaude,
    });

    expect(importCodex).not.toHaveBeenCalled();
    expect(importClaude).not.toHaveBeenCalled();
  });

  it('device-link 首页请求(deviceLinkFirstPage)→ 照跑 importer', async () => {
    // 被控端可能从未本机打开该会话,rollout 从未导入 —— 首页请求必须补导入,
    // 否则崩溃前 CLI 已写的产出不进 DB,中断行滞留尾部(review P2)。
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects(
      's1',
      { isDeviceLink: () => true, importCodex, importClaude },
      { deviceLinkFirstPage: true },
    );

    expect(importCodex).toHaveBeenCalledExactlyOnceWith('s1');
    expect(importClaude).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('本机路径 → 按顺序调用 codex 再 claude importer', async () => {
    const order: string[] = [];
    const importCodex = vi.fn(async () => {
      order.push('codex');
    });
    const importClaude = vi.fn(async () => {
      order.push('claude');
    });

    await runMessagesListImportSideEffects('s1', {
      isDeviceLink: () => false,
      importCodex,
      importClaude,
    });

    expect(importCodex).toHaveBeenCalledExactlyOnceWith('s1');
    expect(importClaude).toHaveBeenCalledExactlyOnceWith('s1');
    expect(order).toEqual(['codex', 'claude']);
  });

  it('本机路径 → importer reject 被吞并,不冒泡', async () => {
    const importCodex = vi.fn(async () => {
      throw new Error('boom-codex');
    });
    const importClaude = vi.fn(async () => {
      throw new Error('boom-claude');
    });

    await expect(
      runMessagesListImportSideEffects('s1', {
        isDeviceLink: () => false,
        importCodex,
        importClaude,
      }),
    ).resolves.toBeUndefined();

    // codex reject 不应阻断 claude importer 触发(沿用原串行 + 各自 .catch 语义)。
    expect(importCodex).toHaveBeenCalledTimes(1);
    expect(importClaude).toHaveBeenCalledTimes(1);
  });
});

describe('local-db:messages:list × import side-effects (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.handlers.clear();
  });

  it('本机 invoke → 触发真实 importer(默认依赖)', async () => {
    createDb();
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    await listHandler?.({}, 's1', { limit: 10 });

    expect(codexMock).toHaveBeenCalledExactlyOnceWith('s1');
    expect(claudeMock).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('device-link 首页 invoke → 照跑真实 importer(补被控端从未本机打开的导入)', async () => {
    createDb();
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 's1', { limit: 10 }),
    );

    expect(codexMock).toHaveBeenCalledExactlyOnceWith('s1');
    expect(claudeMock).toHaveBeenCalledExactlyOnceWith('s1');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('device-link 分页 invoke(带 beforeTs)→ 跳过真实 importer(#318 性能语义)', async () => {
    createDb();
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 's1', { limit: 10, beforeTs: Date.now() }),
    );

    expect(codexMock).not.toHaveBeenCalled();
    expect(claudeMock).not.toHaveBeenCalled();
    expect(Array.isArray(rows)).toBe(true);
  });
});
