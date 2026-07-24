import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronMock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userData),
  },
}));

vi.mock('../localDb/index.js', () => ({
  getRawDb: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  importExternalClaudeCodeSessions,
  importExternalClaudeCodeMessagesForSession,
  parseClaudeCodeMessageLine,
  readClaudeCodeSessionScanSummary,
  readClaudeCodeSessionSummary,
  scanExternalClaudeCodeSessions,
} from '../maker-host/claude-local-sessions';
import { getRawDb } from '../localDb/index.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import * as schema from '../localDb/schema';
import { tx as runInprocTx } from '../localDb/worker/opHandlers/tx';

const sdkSessionId = '15356275-b340-401f-abd1-3bc2bd4824c5';
const sdkSessionId2 = '25356275-b340-401f-abd1-3bc2bd4824c5';
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3ykWQAAAABJRU5ErkJggg==';

function line(value: Record<string, unknown>): string {
  return JSON.stringify({
    sessionId: sdkSessionId,
    timestamp: '2026-05-13T04:33:34.204Z',
    ...value,
  });
}

function createLocalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
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
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
  return db;
}

function makeTestDbClient(db: Database.Database): DbClient {
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    tx: async (name: string, args: unknown) => runInprocTx(db, { name, args }) as never,
    drizzle: drizzle(db, { schema }),
    vecAvailable: true,
    dispose: async () => undefined,
  };
}

function setLocalDb(db: Database.Database, userId = 'test-user'): void {
  vi.mocked(getRawDb).mockReturnValue(db);
  setCurrentDbClient(makeTestDbClient(db), userId);
}

function insertImportedClaudeSession(
  db: Database.Database,
  sessionId: string,
  sdkSessionId: string,
): void {
  db.prepare(
    `
    INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
      context_window, fast_mode, cleared_at, pinned_at, user_send_at,
      agent_kind, parent_session_id, forked_at_message_id, worktree_path,
      source, feishu_open_id, feishu_bot_app_id, used_project_context,
      extra_dirs, created_at, updated_at
    )
    VALUES (
      ?, 'Imported', '/tmp/project', 'claude-sonnet-4-6', 'high', 'ask', 'active',
      ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
      'cc', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
    )
  `,
  ).run(sessionId, sdkSessionId);
}

function resetLocalDb(): void {
  vi.mocked(getRawDb).mockReset();
  clearCurrentDbClient();
}

describe('parseClaudeCodeMessageLine', () => {
  it('maps plain user text into XD user messages', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        message: { role: 'user', content: '继续对战斗系统模拟器和文档的事情吧' },
      }),
      7,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineNo: 7,
      partIndex: 0,
      role: 'user',
      content: '继续对战斗系统模拟器和文档的事情吧',
      toolUseId: null,
      agentMeta: { uuid: 'user-1', sdkSessionId },
    });
  });

  it('removes complete IDE opened-file context blocks from imported user text', () => {
    const ideContextA = '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>';
    const ideContextB = '<ide_opened_file>The user opened /tmp/b.ts in the IDE.</ide_opened_file>';
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        uuid: 'user-ide-context',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${ideContextA}\n${ideContextB}` },
            { type: 'text', text: 'Please fix the parser' },
            { type: 'text', text: ideContextA },
          ],
        },
      }),
      8,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'user',
      content: 'Please fix the parser',
    });
  });

  it('skips IDE-only user messages but preserves malformed IDE tags', () => {
    const ideOnly = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>',
        },
      }),
      9,
      sdkSessionId,
      'claude-sonnet-4-6',
    );
    const malformed = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: 'Keep this <ide_opened_file>unfinished context',
        },
      }),
      10,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(ideOnly).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.content).toBe('Keep this <ide_opened_file>unfinished context');
  });

  it('maps assistant text, tool use, and thinking blocks into XD roles', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-7-20260501',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          content: [
            { type: 'thinking', thinking: 'check files' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.md' } },
            { type: 'text', text: 'Done' },
          ],
        },
      }),
      8,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows.map((row) => row.role)).toEqual(['thinking', 'tool_use', 'assistant']);
    expect(rows[0].content).toEqual({ text: 'check files', durationMs: 0, isRedacted: false });
    expect(rows[1]).toMatchObject({
      toolUseId: 'toolu_1',
      content: { toolUseId: 'toolu_1', toolName: 'Read', input: { file_path: '/tmp/a.md' } },
    });
    expect(rows[2].content).toBe('Done');
    expect(rows[2].agentMeta).toMatchObject({
      uuid: 'assistant-1',
      sdkSessionId,
      model: 'claude-opus-4-7',
      stopReason: 'tool_use',
      requestId: 'msg_1',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
    });
  });

  it('keeps transcript parentage separate from tool/subagent parentage', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'assistant',
        uuid: 'assistant-imported',
        parentUuid: 'preceding-user-record',
        message: {
          id: 'msg_imported',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Imported answer' }],
        },
      }),
      10,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].agentMeta).toMatchObject({
      uuid: 'assistant-imported',
      transcriptParentUuid: 'preceding-user-record',
      sdkSessionId,
    });
    expect(rows[0].agentMeta).not.toHaveProperty('parentUuid');
  });

  it('preserves real tool parent metadata while also recording the transcript parent', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'assistant',
        uuid: 'assistant-tool-owned',
        parent_uuid: 'preceding-tool-result-record',
        parent_tool_use_id: 'toolu_agent_1',
        message: {
          id: 'msg_tool_owned',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Subagent answer' }],
        },
      }),
      11,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].agentMeta).toMatchObject({
      uuid: 'assistant-tool-owned',
      transcriptParentUuid: 'preceding-tool-result-record',
      parentUuid: 'toolu_agent_1',
      sdkSessionId,
    });
  });

  it('stores sourceToolAssistantUUID as transcript parent on user/tool records', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        uuid: 'user-tool-result',
        sourceToolAssistantUUID: 'source-assistant-uuid',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
      }),
      12,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].agentMeta).toMatchObject({
      uuid: 'user-tool-result',
      transcriptParentUuid: 'source-assistant-uuid',
      sdkSessionId,
    });
    expect(rows[0].agentMeta).not.toHaveProperty('parentUuid');
  });

  it('normalizes opus-4-8 full model id to short form', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'assistant',
        uuid: 'assistant-opus48',
        message: {
          id: 'msg_opus48',
          model: 'claude-opus-4-8-20260601',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
      10,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].agentMeta).toMatchObject({ model: 'claude-opus-4-8' });
  });

  it('maps Claude task notifications back to tool_result instead of user text', () => {
    const rows = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        uuid: 'task-result-1',
        message: {
          role: 'user',
          content: [
            '<task-notification>',
            '<tool-use-id>toolu_task</tool-use-id>',
            '<summary>Agent completed</summary>',
            '<result>Subtask output</result>',
            '</task-notification>',
          ].join('\n'),
        },
      }),
      9,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'tool_result',
      content: 'Subtask output',
      toolUseId: 'toolu_task',
    });
  });

  it('skips subagent sidechains and local command synthetic user messages', () => {
    const sidechain = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'sidechain prompt' },
      }),
      10,
      sdkSessionId,
      'claude-sonnet-4-6',
    );
    const command = parseClaudeCodeMessageLine(
      line({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/effort</command-name>\n<command-message>effort</command-message>',
        },
      }),
      11,
      sdkSessionId,
      'claude-sonnet-4-6',
    );

    expect(sidechain).toEqual([]);
    expect(command).toEqual([]);
  });

  it('uses the latest Claude cwd for XD project grouping', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-session-'));
    const projectDir = path.join(dir, '-Users-carol');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      [
        line({
          type: 'user',
          uuid: 'user-home',
          cwd: '/Users/carol',
          message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' },
        }),
        line({
          type: 'system',
          cwd: '/Users/carol/Projects/Github/ExampleOrg/cli-app',
          subtype: 'turn_duration',
        }),
        line({
          type: 'user',
          uuid: 'user-project',
          cwd: '/Users/carol/Projects/Github/ExampleOrg/cli-app',
          message: { role: 'user', content: '继续写 V4 文档' },
        }),
      ].join('\n'),
    );

    try {
      const summary = await readClaudeCodeSessionSummary(file);
      expect(summary).toMatchObject({
        sdkSessionId,
        cwd: '/Users/carol/Projects/Github/ExampleOrg/cli-app',
        title: '继续写 V4 文档',
        archived: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the next real user input for full and scan titles after IDE-only context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-title-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    const ideContext = '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>';
    fs.writeFileSync(
      file,
      [
        line({
          type: 'user',
          uuid: 'user-ide-only',
          cwd: '/tmp/project',
          message: { role: 'user', content: ideContext },
        }),
        line({
          type: 'user',
          uuid: 'user-real-input',
          cwd: '/tmp/project',
          message: { role: 'user', content: `${ideContext}\nPlease fix the parser` },
        }),
      ].join('\n'),
    );

    try {
      const summary = await readClaudeCodeSessionSummary(file);
      const scanSummary = await readClaudeCodeSessionScanSummary(file);

      expect(summary?.title).toBe('Please fix the parser');
      expect(scanSummary?.title).toBe('Please fix the parser');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips unchanged Claude JSONL files after importing them once', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );

    const db = createLocalDb();
    insertImportedClaudeSession(db, `claude-${sdkSessionId}`, sdkSessionId);

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const tx = vi.fn(
      async (name: string, args: unknown) => runInprocTx(db, { name, args }) as never,
    );
    vi.mocked(getRawDb).mockReturnValue(db);
    setCurrentDbClient({ ...makeTestDbClient(db), tx }, 'test-user');

    try {
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);

      expect(tx).toHaveBeenCalledTimes(1);
      const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
      expect(count.count).toBe(1);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not reuse unchanged Claude JSONL cache across current DB users', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );

    const dbA = createLocalDb();
    const dbB = createLocalDb();
    insertImportedClaudeSession(dbA, `claude-${sdkSessionId}`, sdkSessionId);
    insertImportedClaudeSession(dbB, `claude-${sdkSessionId}`, sdkSessionId);

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const txA = vi.fn(
      async (name: string, args: unknown) => runInprocTx(dbA, { name, args }) as never,
    );
    const txB = vi.fn(
      async (name: string, args: unknown) => runInprocTx(dbB, { name, args }) as never,
    );

    try {
      vi.mocked(getRawDb).mockReturnValue(dbA);
      setCurrentDbClient({ ...makeTestDbClient(dbA), tx: txA }, 'user-a');
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);
      expect(txA).toHaveBeenCalledTimes(1);

      vi.mocked(getRawDb).mockReturnValue(dbB);
      setCurrentDbClient({ ...makeTestDbClient(dbB), tx: txB }, 'user-b');
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);

      expect(txB).toHaveBeenCalledTimes(1);
      const count = dbB.prepare('SELECT COUNT(*) AS count FROM messages').get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      dbA.close();
      dbB.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('imports newly appended Claude JSONL messages while the session only has imported history', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );

    const db = createLocalDb();
    db.prepare(
      `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Imported', '/tmp/project', 'claude-sonnet-4-6', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'cc', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
    ).run(`claude-${sdkSessionId}`, sdkSessionId);

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);
      fs.appendFileSync(
        file,
        `${line({
          type: 'assistant',
          uuid: 'assistant-1',
          cwd: '/tmp/project',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'world' }],
          },
        })}\n`,
      );
      await importExternalClaudeCodeMessagesForSession(`claude-${sdkSessionId}`);

      const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
      expect(count.count).toBe(2);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('updates existing imported Claude user rows when screenshots become available', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    const userData = path.join(home, 'xdt-user-data');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    electronMock.userData = userData;
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: pngBase64,
              },
            },
          ],
        },
      })}\n`,
    );

    const sessionId = `claude-${sdkSessionId}`;
    const db = createLocalDb();
    db.prepare(
      `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Imported', '/tmp/project', 'claude-sonnet-4-6', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'cc', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
    ).run(sessionId, sdkSessionId);
    db.prepare(
      `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      )
      VALUES (
        'old-imported-user', ?, ?, 'user', ?, NULL, NULL, 1, NULL
      )
    `,
    ).run(`claude-import:${sdkSessionId}:1-0`, sessionId, JSON.stringify('look at this'));

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      await importExternalClaudeCodeMessagesForSession(sessionId);

      const row = db
        .prepare('SELECT content FROM messages WHERE client_id = ?')
        .get(`claude-import:${sdkSessionId}:1-0`) as { content: string } | undefined;
      const parsed = JSON.parse(row?.content ?? 'null') as {
        text: string;
        images: Array<{ url: string; mimeType: string; originalName: string }>;
        files: unknown[];
      };
      expect(parsed.text).toBe('look at this');
      expect(parsed.files).toEqual([]);
      expect(parsed.images).toHaveLength(1);
      expect(parsed.images[0]).toMatchObject({
        mimeType: 'image/png',
        originalName: 'claude-import-1-0-0.png',
      });
      const filename = decodeURIComponent(new URL(parsed.images[0].url).pathname.slice(1));
      expect(fs.existsSync(path.join(userData, 'cc-agent', 'images', sessionId, filename))).toBe(
        true,
      );
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('applies the import cap after filtering invalid Claude JSONL files', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const olderValidFile = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      olderValidFile,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );
    fs.utimesSync(olderValidFile, new Date(1_000), new Date(1_000));
    const newerValidFile = path.join(projectsDir, `${sdkSessionId2}.jsonl`);
    fs.writeFileSync(
      newerValidFile,
      `${line({
        sessionId: sdkSessionId2,
        type: 'user',
        uuid: 'user-2',
        cwd: '/tmp/project-newer',
        message: { role: 'user', content: 'newer' },
      })}\n`,
    );
    fs.utimesSync(newerValidFile, new Date(2_000), new Date(2_000));
    const invalidFile = path.join(projectsDir, 'invalid-newest.jsonl');
    fs.writeFileSync(invalidFile, 'not json\n');
    fs.utimesSync(invalidFile, new Date(3_000), new Date(3_000));

    const db = createLocalDb();
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      const scan = await scanExternalClaudeCodeSessions({ maxSessionsPerRoot: 1 });

      expect(scan.rejectedCount).toBe(1);
      expect(scan.candidates.map((item) => item.id)).toEqual([sdkSessionId2]);
      const result = await importExternalClaudeCodeSessions([sdkSessionId2]);
      expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
      const rows = db.prepare('SELECT id, working_dir AS workingDir FROM sessions').all();
      expect(rows).toEqual([{ id: `claude-${sdkSessionId2}`, workingDir: '/tmp/project-newer' }]);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('scans without writing and imports only explicitly selected Claude Code sessions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const firstFile = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    const secondFile = path.join(projectsDir, `${sdkSessionId2}.jsonl`);
    fs.writeFileSync(
      firstFile,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'import me' },
      })}\n`,
    );
    fs.writeFileSync(
      secondFile,
      `${line({
        sessionId: sdkSessionId2,
        type: 'user',
        uuid: 'user-2',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'leave me' },
      })}\n`,
    );

    const db = createLocalDb();
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      const scan = await scanExternalClaudeCodeSessions();

      expect(scan.candidates.map((item) => item.id).sort()).toEqual(
        [sdkSessionId, sdkSessionId2].sort(),
      );
      const countBefore = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
        count: number;
      };
      expect(countBefore.count).toBe(0);

      const result = await importExternalClaudeCodeSessions([sdkSessionId]);

      expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
      const rows = db.prepare('SELECT id, title FROM sessions ORDER BY id').all();
      expect(rows).toEqual([{ id: `claude-${sdkSessionId}`, title: 'import me' }]);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('normalizes Windows backslash cwd to storage form on import (#537)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', 'D--Project-001');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: 'D:\\Project-001\\',
        message: { role: 'user', content: 'windows session' },
      })}\n`,
    );

    const db = createLocalDb();
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      const result = await importExternalClaudeCodeSessions([sdkSessionId]);

      expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
      const rows = db.prepare('SELECT id, working_dir AS workingDir FROM sessions').all();
      expect(rows).toEqual([{ id: `claude-${sdkSessionId}`, workingDir: 'D:/Project-001' }]);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('imports normally when the sdk session id is only held by a deleted (non-local) session', async () => {
    // #599 follow-up 回归:分享导入的会话(UUID id,非 claude- 前缀)被软删后,
    // 残留行不该继续挡 CLI 导入——否则扫描侧(只看存活行)重新出候选,点导入
    // 却被这里静默 skip,幽灵候选在「已删除」场景回归。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );

    const db = createLocalDb();
    // 模拟分享导入后被软删的会话行:UUID id(非 claude- 前缀)+ status deleted
    insertImportedClaudeSession(db, 'aaaa1111-dead-beef-0000-000000000001', sdkSessionId);
    db.prepare(`UPDATE sessions SET status = 'deleted' WHERE id = ?`).run(
      'aaaa1111-dead-beef-0000-000000000001',
    );

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      const result = await importExternalClaudeCodeSessions([sdkSessionId]);

      expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
      const rows = db.prepare(`SELECT id, status FROM sessions ORDER BY id`).all();
      expect(rows).toEqual([
        { id: 'aaaa1111-dead-beef-0000-000000000001', status: 'deleted' },
        { id: `claude-${sdkSessionId}`, status: 'active' },
      ]);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('scan summary reads only the file head: tail-only cwd changes are ignored and updatedAt is mtime', async () => {
    // 扫描摘要是头部有界读取(未响应修复的核心不变量):标题/cwd 取自头部窗口,
    // 之后的内容不再读——大转录文件不会在扫描期被全文 JSON.parse。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-head-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    const filler = Array.from({ length: 500 }, (_, i) =>
      line({
        type: 'system',
        subtype: 'noise',
        cwd: '/tmp/tail-project',
        seq: i,
      }),
    );
    fs.writeFileSync(
      file,
      [
        line({
          type: 'user',
          uuid: 'user-1',
          cwd: '/tmp/head-project',
          message: { role: 'user', content: 'head title' },
        }),
        ...filler,
      ].join('\n'),
    );
    fs.utimesSync(file, new Date(5_000_000), new Date(5_000_000));

    try {
      const summary = await readClaudeCodeSessionScanSummary(file);
      expect(summary).toEqual({
        sdkSessionId,
        title: 'head title',
        cwd: '/tmp/head-project',
        updatedAt: 5_000_000,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues within the byte window when IDE-only rows exceed the normal scan line cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-ide-extension-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    const ideContext = '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>';
    const ideOnlyRows = Array.from({ length: 401 }, (_, index) =>
      line({
        type: 'user',
        uuid: `user-ide-${index}`,
        cwd: '/tmp/project',
        message: { role: 'user', content: ideContext },
      }),
    );
    fs.writeFileSync(
      file,
      [
        ...ideOnlyRows,
        line({
          type: 'user',
          uuid: 'user-real-after-cap',
          cwd: '/tmp/project',
          message: { role: 'user', content: 'Please fix the parser after the normal line cap' },
        }),
      ].join('\n'),
    );

    try {
      const summary = await readClaudeCodeSessionScanSummary(file);

      expect(summary?.title).toBe('Please fix the parser after the normal line cap');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inspects an IDE-only first overflow row before deciding whether to extend the scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-ide-boundary-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    const noiseRows = Array.from({ length: 400 }, (_, index) =>
      line({
        type: 'system',
        subtype: 'noise',
        cwd: '/tmp/project',
        seq: index,
      }),
    );
    fs.writeFileSync(
      file,
      [
        ...noiseRows,
        line({
          type: 'user',
          uuid: 'user-ide-at-boundary',
          cwd: '/tmp/project',
          message: {
            role: 'user',
            content: '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>',
          },
        }),
        line({
          type: 'user',
          uuid: 'user-real-after-boundary',
          cwd: '/tmp/project',
          message: { role: 'user', content: 'Please use the input after the boundary row' },
        }),
      ].join('\n'),
    );

    try {
      const summary = await readClaudeCodeSessionScanSummary(file);

      expect(summary?.title).toBe('Please use the input after the boundary row');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scan summary is cached by (mtime, size) and re-parsed when the file changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-cache-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    const makeContent = (title: string) =>
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: title },
      })}\n`;
    fs.writeFileSync(file, makeContent('AAAA'));
    fs.utimesSync(file, new Date(5_000_000), new Date(5_000_000));

    try {
      const first = await readClaudeCodeSessionScanSummary(file);
      expect(first?.title).toBe('AAAA');

      // 同字节数改写 + 复原 mtime → (mtime, size) 未变,命中缓存返回旧摘要
      fs.writeFileSync(file, makeContent('BBBB'));
      fs.utimesSync(file, new Date(5_000_000), new Date(5_000_000));
      const cached = await readClaudeCodeSessionScanSummary(file);
      expect(cached?.title).toBe('AAAA');

      // mtime 变化 → 缓存失效,重新解析出新标题
      fs.utimesSync(file, new Date(6_000_000), new Date(6_000_000));
      const reparsed = await readClaudeCodeSessionScanSummary(file);
      expect(reparsed?.title).toBe('BBBB');
      expect(reparsed?.updatedAt).toBe(6_000_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scan summary rejects files without top-level events in the head window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-reject-'));
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      [
        line({ type: 'system', subtype: 'noise', cwd: '/tmp/project' }),
        line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain' } }),
      ].join('\n'),
    );

    try {
      expect(await readClaudeCodeSessionScanSummary(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not upsert an imported row when a native Claude session already owns the sdk session id', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-home-'));
    const projectsDir = path.join(home, '.claude', 'projects', '-tmp-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, `${sdkSessionId}.jsonl`);
    fs.writeFileSync(
      file,
      `${line({
        type: 'user',
        uuid: 'user-1',
        cwd: '/tmp/project',
        message: { role: 'user', content: 'hello' },
      })}\n`,
    );

    const db = createLocalDb();
    db.prepare(
      `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        'native-claude-session', 'Native', '/tmp/project', 'claude-sonnet-4-6', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'cc', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
    ).run(sdkSessionId);

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    setLocalDb(db);

    try {
      const result = await importExternalClaudeCodeSessions([sdkSessionId]);

      expect(result).toMatchObject({ scanned: 1, inserted: 0, updated: 0 });
      const rows = db.prepare('SELECT id, title FROM sessions ORDER BY id').all();
      expect(rows).toEqual([{ id: 'native-claude-session', title: 'Native' }]);
    } finally {
      homedir.mockRestore();
      resetLocalDb();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
