import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDbWorkerBundle } from '../../__tests__/dbWorkerTestUtils.js';
import type { DbClient } from '../DbClient.js';
import { createDbClient } from '../DbClient.js';

const INIT_SQL = `
CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE migration_history (
  seq INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Maker',
  working_dir TEXT,
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  provider_id TEXT,
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
  orca_role TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'project',
  codex_history_has_product_prompt INTEGER,
  parent_session_id TEXT,
  forked_at_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE orca_teams (
  id TEXT PRIMARY KEY,
  lead_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE orca_workers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  label TEXT,
  worktree_branch TEXT,
  role TEXT NOT NULL DEFAULT 'developer',
  focused INTEGER NOT NULL DEFAULT 0,
  idle_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uniq_orca_workers_team_label ON orca_workers (team_id, lower(label));
CREATE TABLE orca_worker_creation_reservations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uniq_orca_worker_creation_reservations_team_label
  ON orca_worker_creation_reservations (team_id, lower(label));
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
  rewind_at INTEGER,
  UNIQUE(session_id, client_id)
);
CREATE TABLE im_bindings (
  channel TEXT NOT NULL,
  bot_context_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  attached_at INTEGER NOT NULL,
  attached_via_card_message_id TEXT,
  PRIMARY KEY(channel, bot_context_id, user_id, scope_key)
);
CREATE INDEX idx_im_bindings_target ON im_bindings(target_session_id);
CREATE TABLE embedding_jobs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  vec_table TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at INTEGER NOT NULL,
  locked_at INTEGER,
  UNIQUE(source, source_id, chunk_index, model_id)
);
CREATE TABLE chat_vec (rowid INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
`;

let workerBundleDir: string;
let workerScriptPath: string;

interface TestSessionRow {
  id: string;
  title: string;
  workingDir: string | null;
  model: string;
  providerId: string | null;
  effort: string;
  permissionMode: string;
  status: string;
  sdkSessionId: string | null;
  totalTokenUsage: number;
  totalCostUsd: number;
  contextTokens: number;
  contextWindow: number;
  fastMode: boolean;
  clearedAt: number | null;
  pinnedAt: number | null;
  userSendAt: number | null;
  agentKind: string;
  orcaRole: string | null;
  workspaceKind: string;
  codexHistoryHasProductPrompt: boolean | null;
  parentSessionId: string | null;
  forkedAtMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

describe('db worker tx handlers', () => {
  beforeAll(async () => {
    workerBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-tx-worker-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(workerBundleDir, 'build'));
  });

  afterAll(() => {
    if (workerBundleDir) {
      fs.rmSync(workerBundleDir, { recursive: true, force: true });
    }
  });

  it('codex.importMessages skips likely local duplicates and upserts imported rows', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['local-1', 'local-1', 's1', 'user', JSON.stringify('same'), 1000],
      );

      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          { lineNo: 1, role: 'user', text: 'same', content: 'same', createdAt: 1001 },
          { lineNo: 2, role: 'assistant', text: 'new', content: 'new', createdAt: 2000 },
        ],
      });

      expect(result).toEqual({ changed: 1 });
      await expect(
        client.query('SELECT client_id, agent_meta FROM messages WHERE client_id LIKE ?', [
          'codex-import:%',
        ]),
      ).resolves.toEqual([
        {
          client_id: 'codex-import:2',
          agent_meta: JSON.stringify({ sdkSessionId: 'thread-1', model: 'gpt-5' }),
        },
      ]);
    });
  });

  it('codex.importMessages dedupes pre-upgrade local rows that still carry raw citation markers', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      // 升级前经流式路径落库的本地 assistant 行:正文仍是原始 citation 标记。
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          'local-1',
          'local-1',
          's1',
          'assistant',
          JSON.stringify('已保存::codex-file-citation{path="/tmp/报告.docx" purpose="output"},请查收。'),
          1000,
        ],
      );

      // 升级后再导入同一条回复:导入侧文本已归一化。两侧指纹统一规范化后应判定为
      // 同一条,不插入第二份(review 反馈)。
      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          {
            lineNo: 1,
            role: 'assistant',
            text: '已保存:`/tmp/报告.docx`,请查收。',
            content: '已保存:`/tmp/报告.docx`,请查收。',
            createdAt: 1001,
          },
        ],
      });

      expect(result).toEqual({ changed: 0 });
      await expect(
        client.query('SELECT client_id FROM messages WHERE session_id = ?', ['s1']),
      ).resolves.toEqual([{ client_id: 'local-1' }]);
    });
  });

  it('codex.importMessages keeps distinct replies that differ only by Markdown formatting', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      // 仅 Markdown 格式不同的两条**不同**回复:canon 有损比较只在「至少一侧含
      // 原始标记字面量」时启用,这里两侧都不含 → 原文精确比较,不得误判成重复
      // (review 反馈:无条件去反引号会把 `Use \`foo\`` 与 `Use foo` 判成同一条)。
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['local-1', 'local-1', 's1', 'assistant', JSON.stringify('Use `foo`'), 1000],
      );

      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          { lineNo: 1, role: 'assistant', text: 'Use foo', content: 'Use foo', createdAt: 1001 },
        ],
      });

      expect(result).toEqual({ changed: 1 });
      await expect(
        client.query('SELECT client_id FROM messages WHERE session_id = ? ORDER BY client_id', [
          's1',
        ]),
      ).resolves.toEqual([{ client_id: 'codex-import:1' }, { client_id: 'local-1' }]);
    });
  });

  it('codex.importMessages dedupes unfinished-marker rows against finalized plain text', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      // 升级前落库的残尾行:生成被打断,正文停在未闭合标记。导入侧同一条回复
      // finalize 后是**不含标记/反引号的纯文本**——纯文本也要有规范形候选指纹,
      // 否则永远配不上残尾行的规范形(review 反馈)。
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          'local-1',
          'local-1',
          's1',
          'assistant',
          JSON.stringify('Result :codex-file-citation{path="/tmp/x'),
          1000,
        ],
      );

      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          { lineNo: 1, role: 'assistant', text: 'Result', content: 'Result', createdAt: 1001 },
        ],
      });

      expect(result).toEqual({ changed: 0 });
      await expect(
        client.query('SELECT client_id FROM messages WHERE session_id = ?', ['s1']),
      ).resolves.toEqual([{ client_id: 'local-1' }]);
    });
  });

  it('codex.importMessages dedupes marker-literal filenames (指纹不动点规范形)', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      // 极端文件名:路径解码后本身是完整标记字面量。展示形二次处理不幂等,指纹
      // 用不动点规范形让原始行与展示形行收敛到同一形。
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          'local-1',
          'local-1',
          's1',
          'assistant',
          JSON.stringify('保存 :codex-file-citation{path="/tmp/a:codex-file-citation{path=\\"/b\\"}.md"} 完成'),
          1000,
        ],
      );

      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          {
            lineNo: 1,
            role: 'assistant',
            text: '保存 `/tmp/a:codex-file-citation{path="/b"}.md` 完成',
            content: '保存 `/tmp/a:codex-file-citation{path="/b"}.md` 完成',
            createdAt: 1001,
          },
        ],
      });

      expect(result).toEqual({ changed: 0 });
      await expect(
        client.query('SELECT client_id FROM messages WHERE session_id = ?', ['s1']),
      ).resolves.toEqual([{ client_id: 'local-1' }]);
    });
  });

  it('codex.importMessages does not rewrite tombstoned imported messages', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['deleted', 'codex-import:2', 's1', 'message_tombstone', 'null', null, 2000, 5000],
      );

      const result = await client.tx('codex.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'codex-import:',
        sdkSessionId: 'thread-1',
        model: 'gpt-5',
        rows: [
          {
            lineNo: 2,
            role: 'assistant',
            text: 'secret body',
            content: 'secret body',
            createdAt: 2000,
          },
        ],
      });

      expect(result).toEqual({ changed: 0 });
      await expect(
        client.queryOne('SELECT role, content, agent_meta, rewind_at FROM messages WHERE id = ?', [
          'deleted',
        ]),
      ).resolves.toEqual({
        role: 'message_tombstone',
        content: 'null',
        agent_meta: null,
        rewind_at: 5000,
      });
    });
  });

  it('claude.importMessages upserts imported message parts', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      const result = await client.tx('claude.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'claude-import:',
        sdkSessionId: 'sdk-1',
        rows: [
          {
            lineNo: 7,
            partIndex: 0,
            role: 'assistant',
            content: { text: 'hello' },
            toolUseId: 'tool-1',
            agentMeta: { uuid: 'u1' },
            createdAt: 3000,
          },
        ],
      });

      expect(result).toEqual({ changed: 1 });
      await expect(
        client.queryOne('SELECT id, client_id, tool_use_id, agent_meta FROM messages'),
      ).resolves.toEqual({
        id: 'claude-import-sdk-1-7-0',
        client_id: 'claude-import:7-0',
        tool_use_id: 'tool-1',
        agent_meta: JSON.stringify({ uuid: 'u1' }),
      });
    });
  });

  it('claude.importMessages does not rewrite rewound imported messages', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['deleted', 'claude-import:7-0', 's1', 'message_tombstone', 'null', null, null, 3000, 5000],
      );

      const result = await client.tx('claude.importMessages', {
        sessionId: 's1',
        importClientIdPrefix: 'claude-import:',
        sdkSessionId: 'sdk-1',
        rows: [
          {
            lineNo: 7,
            partIndex: 0,
            role: 'assistant',
            content: { text: 'secret body' },
            toolUseId: 'tool-1',
            agentMeta: { uuid: 'u1' },
            createdAt: 3000,
          },
        ],
      });

      expect(result).toEqual({ changed: 0 });
      await expect(
        client.queryOne(
          'SELECT role, content, tool_use_id, agent_meta, rewind_at FROM messages WHERE id = ?',
          ['deleted'],
        ),
      ).resolves.toEqual({
        role: 'message_tombstone',
        content: 'null',
        tool_use_id: null,
        agent_meta: null,
        rewind_at: 5000,
      });
    });
  });

  it('rewind.commit soft-deletes target-and-after messages and resets session context', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        ['m1', 'c1', 's1', 'user', 'before', 100, 'm2', 'c2', 's1', 'assistant', 'after', 200],
      );

      await client.tx('rewind.commit', {
        sessionId: 's1',
        targetCreatedAt: 200,
        sdkSessionId: 'sdk-after-rewind',
        now: 999,
      });

      await expect(client.query('SELECT id, rewind_at FROM messages ORDER BY id')).resolves.toEqual(
        [
          { id: 'm1', rewind_at: null },
          { id: 'm2', rewind_at: 999 },
        ],
      );
      await expect(
        client.queryOne(
          'SELECT user_send_at, context_tokens, context_window, sdk_session_id FROM sessions WHERE id = ?',
          ['s1'],
        ),
      ).resolves.toEqual({
        user_send_at: 999,
        context_tokens: 0,
        context_window: 0,
        sdk_session_id: 'sdk-after-rewind',
      });
    });
  });

  it('rewind.commit uses target message id to avoid same-timestamp over-delete', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
        [
          'aaa-before-target',
          'c-before',
          's1',
          'user',
          'same ms but before target',
          200,
          'target',
          'target-client',
          's1',
          'user',
          'target',
          200,
          'zzz-after-target',
          'c-after',
          's1',
          'assistant',
          'after target',
          200,
        ],
      );

      await client.tx('rewind.commit', {
        sessionId: 's1',
        targetCreatedAt: 200,
        targetMessageId: 'target',
        targetClientId: 'target-client',
        now: 999,
      });

      await expect(client.query('SELECT id, rewind_at FROM messages ORDER BY id')).resolves.toEqual(
        [
          { id: 'aaa-before-target', rewind_at: null },
          { id: 'target', rewind_at: 999 },
          { id: 'zzz-after-target', rewind_at: 999 },
        ],
      );
    });
  });

  it('sessions.renameTitles applies title changes atomically with preconditions', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1', {
        title: 'Old title',
        workingDir: '/repo',
        updatedAt: Date.parse('2026-06-23T00:00:00.000Z'),
      });

      const applied = await client.tx('sessions.renameTitles', {
        changes: [
          {
            sessionId: 's1',
            title: 'New title',
            expectedCurrentTitle: 'Old title',
            expectedUpdatedAt: '2026-06-23T00:00:00.000Z',
          },
        ],
      });

      expect(applied).toEqual([
        {
          sessionId: 's1',
          currentTitle: 'Old title',
          newTitle: 'New title',
          workingDir: '/repo',
          updatedAt: expect.stringMatching(/^20\d{2}-\d{2}-\d{2}T/),
        },
      ]);
      await expect(
        client.queryOne('SELECT title FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({
        title: 'New title',
      });

      await expect(
        client.tx('sessions.renameTitles', {
          changes: [
            {
              sessionId: 's1',
              title: 'Stale overwrite',
              expectedUpdatedAt: '2026-06-23T00:00:00.000Z',
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(
        client.queryOne('SELECT title FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({
        title: 'New title',
      });
    });
  });

  it('rewind.commit follows transcript parent links and preserves the prior assistant when timestamps are inverted', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        `INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          'prior',
          'prior-client',
          's1',
          'assistant',
          'prior conclusion',
          JSON.stringify({ uuid: 'prior-asst' }),
          201,
          'target',
          'target-client',
          's1',
          'user',
          'target question',
          JSON.stringify({ uuid: 'target-user', transcriptParentUuid: 'prior-asst' }),
          200,
          'child',
          'child-client',
          's1',
          'assistant',
          'target answer',
          JSON.stringify({ uuid: 'child-asst', transcriptParentUuid: 'target-user' }),
          202,
          'unrelated',
          'unrelated-client',
          's1',
          'assistant',
          'not in branch',
          JSON.stringify({ uuid: 'other-asst', transcriptParentUuid: 'outside' }),
          203,
        ],
      );

      await client.tx('rewind.commit', {
        sessionId: 's1',
        targetCreatedAt: 200,
        targetClientId: 'target-client',
        targetMessageUuid: 'target-user',
        preserveMessageUuid: 'prior-asst',
        now: 999,
      });

      await expect(client.query('SELECT id, rewind_at FROM messages ORDER BY id')).resolves.toEqual(
        [
          { id: 'child', rewind_at: 999 },
          { id: 'prior', rewind_at: null },
          { id: 'target', rewind_at: 999 },
          { id: 'unrelated', rewind_at: null },
        ],
      );
    });
  });

  it('rewind.commit falls back to time tail when the target user has no SDK uuid', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec(
        `INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          'prior',
          'prior-client',
          's1',
          'assistant',
          'prior conclusion',
          JSON.stringify({ uuid: 'prior-asst' }),
          100,
          'target',
          'target-client',
          's1',
          'user',
          'legacy target',
          null,
          200,
          'child',
          'child-client',
          's1',
          'assistant',
          'target answer',
          JSON.stringify({ uuid: 'child-asst', transcriptParentUuid: 'unknown-target-user' }),
          201,
        ],
      );

      await client.tx('rewind.commit', {
        sessionId: 's1',
        targetCreatedAt: 200,
        targetClientId: 'target-client',
        preserveMessageUuid: 'prior-asst',
        now: 999,
      });

      await expect(client.query('SELECT id, rewind_at FROM messages ORDER BY id')).resolves.toEqual(
        [
          { id: 'child', rewind_at: 999 },
          { id: 'prior', rewind_at: null },
          { id: 'target', rewind_at: 999 },
        ],
      );
    });
  });

  it('fork.session inserts the new session and copies/remaps source messages', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'src');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'm1',
          'c1',
          'src',
          'assistant',
          'copy',
          JSON.stringify({ uuid: 'old', parentUuid: 'parent', transcriptParentUuid: 'old-parent' }),
          'cc',
          100,
          'm2',
          'c2',
          'src',
          'user',
          'skip',
          null,
          'codex',
          300,
        ],
      );

      const result = await client.tx('fork.session', {
        sourceSessionId: 'src',
        targetCreatedAt: 200,
        // providerId 走凭证形态推导,fork 丢掉它会让新会话与原会话形态漂移(2026-07-03 排队假死回归)。
        newSession: sessionRow('forked', {
          workingDir: 'D:\\repo\\project',
          parentSessionId: 'src',
          forkedAtMessageId: 'c2',
          providerId: 'xd',
        }),
        uuidMap: [
          ['old', 'new'],
          ['parent', 'new-parent-tool'],
          ['old-parent', 'new-parent'],
        ],
        newMessageIds: [{ id: 'copy-id-1', clientId: 'copy-client-1' }],
      });

      expect(result).toEqual({ messageCount: 1 });
      await expect(
        client.queryOne(
          'SELECT working_dir, parent_session_id, forked_at_message_id, provider_id FROM sessions WHERE id = ?',
          ['forked'],
        ),
      ).resolves.toEqual({
        working_dir: 'D:/repo/project',
        parent_session_id: 'src',
        forked_at_message_id: 'c2',
        provider_id: 'xd',
      });
      const copied = await client.queryOne<{
        id: string;
        client_id: string;
        agent_meta: string;
        agent_kind: string;
      }>('SELECT id, client_id, agent_meta, agent_kind FROM messages WHERE session_id = ?', [
        'forked',
      ]);
      expect(copied?.id).toBe('copy-id-1');
      expect(copied?.client_id).toBe('copy-client-1');
      expect(copied?.agent_kind).toBe('cc');
      expect(JSON.parse(copied?.agent_meta ?? '{}')).toEqual({
        uuid: 'new',
        parentUuid: 'new-parent-tool',
        transcriptParentUuid: 'new-parent',
      });
    });
  });

  it('fork.session filters pre-clear/same-ms tail rows and detaches copied parked sessions', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'src');
      const switchContent = JSON.stringify({
        fromAgentKind: 'codex',
        toAgentKind: 'cc',
        fromModel: 'gpt-5.4',
        toModel: 'claude-sonnet-4-6',
        fromSdkSessionId: 'parent-parked-codex',
        handoff: 'carry context',
        consumed: true,
      });
      await client.exec(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
        [
          'pre-clear',
          'pre-clear-client',
          'src',
          'user',
          'old',
          50,
          'switch',
          'switch-client',
          'src',
          'agent_switch',
          switchContent,
          100,
          'same-before',
          'same-before-client',
          'src',
          'assistant',
          'keep',
          200,
          'target',
          'target-client',
          'src',
          'user',
          'exclude target',
          200,
          'same-after',
          'same-after-client',
          'src',
          'assistant',
          'exclude tail',
          200,
        ],
      );
      const target = await client.queryOne<{ rowid: number }>(
        'SELECT rowid FROM messages WHERE id = ?',
        ['target'],
      );
      expect(target).not.toBeNull();

      await client.tx('fork.session', {
        sourceSessionId: 'src',
        sourceClearedAt: 75,
        targetCreatedAt: 200,
        targetRowid: target!.rowid,
        newSession: sessionRow('forked', { parentSessionId: 'src' }),
        uuidMap: [],
        detachAgentSwitchSessions: true,
        resetHandoffBoundaryClientId: 'switch-client',
        newMessageIds: [
          { id: 'copy-switch', clientId: 'copy-switch-client' },
          { id: 'copy-same-before', clientId: 'copy-same-before-client' },
        ],
      });

      const copied = await client.query<{
        id: string;
        role: string;
        content: string;
      }>('SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY created_at, rowid', [
        'forked',
      ]);
      expect(copied.map((row) => row.id)).toEqual(['copy-switch', 'copy-same-before']);
      expect(JSON.parse(copied[0].content)).toMatchObject({
        fromSdkSessionId: null,
        handoff: 'carry context',
        consumed: false,
      });
    });
  });

  it('fork.session normalizes legacy Claude transcript parent metadata before remapping', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'src');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'legacy-message',
          'legacy-client',
          'src',
          'assistant',
          'legacy copy',
          JSON.stringify({ uuid: 'legacy-asst', parentUuid: 'legacy-user' }),
          'cc',
          100,
        ],
      );

      await client.tx('fork.session', {
        sourceSessionId: 'src',
        targetCreatedAt: 200,
        newSession: sessionRow('forked', { parentSessionId: 'src' }),
        uuidMap: [
          ['legacy-asst', 'new-asst'],
          ['legacy-user', 'new-user'],
        ],
        legacyTranscriptParentUuids: ['legacy-asst'],
        newMessageIds: [{ id: 'copy-id', clientId: 'copy-client' }],
      });

      const copied = await client.queryOne<{ agent_meta: string }>(
        'SELECT agent_meta FROM messages WHERE session_id = ?',
        ['forked'],
      );
      expect(JSON.parse(copied?.agent_meta ?? '{}')).toEqual({
        uuid: 'new-asst',
        transcriptParentUuid: 'new-user',
      });
    });
  });

  it('fork.session preserves imported Claude tool-use parents absent from uuidMap', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'src');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'tool-message',
          'tool-client',
          'src',
          'assistant',
          'tool child',
          JSON.stringify({ uuid: 'asst', parentUuid: 'toolu_external' }),
          'cc',
          100,
        ],
      );

      await client.tx('fork.session', {
        sourceSessionId: 'src',
        targetCreatedAt: 200,
        newSession: sessionRow('forked', { parentSessionId: 'src' }),
        uuidMap: [['asst', 'new-asst']],
        toolParentUuids: ['toolu_external'],
        newMessageIds: [{ id: 'copy-id', clientId: 'copy-client' }],
      });

      const copied = await client.queryOne<{ agent_meta: string }>(
        'SELECT agent_meta FROM messages WHERE session_id = ?',
        ['forked'],
      );
      expect(JSON.parse(copied?.agent_meta ?? '{}')).toEqual({
        uuid: 'new-asst',
        parentUuid: 'toolu_external',
      });
    });
  });

  it('fork.session rejects when newMessageIds length does not match copied source messages', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'src');
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['m1', 'c1', 'src', 'assistant', 'copy', 100],
      );

      await expect(
        client.tx('fork.session', {
          sourceSessionId: 'src',
          targetCreatedAt: 200,
          newSession: sessionRow('forked', { parentSessionId: 'src', forkedAtMessageId: 'c1' }),
          uuidMap: [],
          newMessageIds: [],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    });
  });

  it('session.agentSwitchFallback atomically clears sdk id and rewrites boundary', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec('UPDATE sessions SET sdk_session_id = ? WHERE id = ?', ['stale-sdk', 's1']);
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['sw', 'sw-client', 's1', 'agent_switch', '{"handoff":"delta"}', 100],
      );
      await client.tx('session.agentSwitchFallback', {
        sessionId: 's1',
        boundaryClientId: 'sw-client',
        boundaryContent: '{"handoff":"full","resumed":false}',
        updatedAt: 500,
      });
      await expect(
        client.queryOne('SELECT sdk_session_id, updated_at FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({ sdk_session_id: null, updated_at: 500 });
      await expect(
        client.queryOne('SELECT content FROM messages WHERE session_id = ? AND client_id = ?', [
          's1',
          'sw-client',
        ]),
      ).resolves.toEqual({ content: '{"handoff":"full","resumed":false}' });
    });
  });

  it('session.agentSwitchFallback missing boundary rolls back sdk id clear', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec('UPDATE sessions SET sdk_session_id = ? WHERE id = ?', ['stale-sdk', 's1']);
      await expect(
        client.tx('session.agentSwitchFallback', {
          sessionId: 's1',
          boundaryClientId: 'missing',
          boundaryContent: '{}',
          updatedAt: 500,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        client.queryOne('SELECT sdk_session_id FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({ sdk_session_id: 'stale-sdk' });
    });
  });

  it('message.delete scrubs the selected AI round and invalidates native context atomically', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec('UPDATE sessions SET sdk_session_id = ? WHERE id = ?', [
        'old-native',
        's1',
      ]);
      for (const [id, role, createdAt] of [
        ['before', 'user', 100],
        ['target', 'assistant', 200],
        ['thinking', 'thinking', 225],
        ['auto-resume', 'user', 250],
        ['tool', 'tool_result', 275],
        ['after', 'user', 300],
      ] as const) {
        await client.exec(
          'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, id, 's1', role, JSON.stringify(id), createdAt],
        );
      }
      const job = await client.exec(
        "INSERT INTO embedding_jobs (source, source_id, model_id, vec_table, scheduled_at) VALUES ('chat', ?, 'test', 'chat_vec', 0)",
        ['target'],
      );
      await client.exec('INSERT INTO chat_vec (rowid, embedding) VALUES (?, ?)', [
        job.lastInsertRowid,
        Buffer.from([1, 2, 3]),
      ]);

      await expect(
        client.tx('message.delete', {
          sessionId: 's1',
          clientIds: ['target', 'thinking', 'auto-resume', 'tool'],
          contextMarker: {
            id: 'ctx-id',
            clientId: 'ctx-client',
            content: '{"handoff":"before + after","consumed":false}',
            createdAt: 400,
          },
          updatedAt: 500,
        }),
      ).resolves.toEqual({
        messages: [
          { messageId: 'target', clientId: 'target' },
          { messageId: 'thinking', clientId: 'thinking' },
          { messageId: 'auto-resume', clientId: 'auto-resume' },
          { messageId: 'tool', clientId: 'tool' },
        ],
      });

      await expect(
        client.query<{
          id: string;
          role: string;
          content: string;
          agent_meta: string | null;
          rewind_at: number | null;
        }>(
          'SELECT id, role, content, agent_meta, rewind_at FROM messages WHERE session_id = ? ORDER BY created_at',
          ['s1'],
        ),
      ).resolves.toEqual([
        { id: 'before', role: 'user', content: '"before"', agent_meta: null, rewind_at: null },
        {
          id: 'target',
          role: 'message_tombstone',
          content: 'null',
          agent_meta: null,
          rewind_at: 500,
        },
        {
          id: 'thinking',
          role: 'message_tombstone',
          content: 'null',
          agent_meta: null,
          rewind_at: 500,
        },
        {
          id: 'auto-resume',
          role: 'message_tombstone',
          content: 'null',
          agent_meta: null,
          rewind_at: 500,
        },
        {
          id: 'tool',
          role: 'message_tombstone',
          content: 'null',
          agent_meta: null,
          rewind_at: 500,
        },
        { id: 'after', role: 'user', content: '"after"', agent_meta: null, rewind_at: null },
        {
          id: 'ctx-id',
          role: 'context_rebuild',
          content: '{"handoff":"before + after","consumed":false}',
          agent_meta: null,
          rewind_at: 400,
        },
      ]);
      await expect(
        client.queryOne('SELECT sdk_session_id, updated_at FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({ sdk_session_id: null, updated_at: 500 });
      await expect(
        client.query('SELECT rowid FROM embedding_jobs WHERE source_id = ?', ['target']),
      ).resolves.toEqual([]);
      await expect(client.query('SELECT rowid FROM chat_vec')).resolves.toEqual([]);
    });
  });

  it('message.delete rejects non-deletable rows without clearing the sdk binding', async () => {
    await withClient(async (client) => {
      await seedSession(client, 's1');
      await client.exec('UPDATE sessions SET sdk_session_id = ? WHERE id = ?', [
        'old-native',
        's1',
      ]);
      await client.exec(
        'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['switch', 'switch', 's1', 'agent_switch', '{}', 100],
      );
      await expect(
        client.tx('message.delete', {
          sessionId: 's1',
          clientIds: ['switch'],
          contextMarker: {
            id: 'ctx-id',
            clientId: 'ctx-client',
            content: '{"handoff":"empty","consumed":false}',
            createdAt: 400,
          },
          updatedAt: 500,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        client.queryOne('SELECT sdk_session_id FROM sessions WHERE id = ?', ['s1']),
      ).resolves.toEqual({ sdk_session_id: 'old-native' });
    });
  });

  it('im.replaceBinding atomically replaces the target owner and the identity old target', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'desktop-target');
      await seedSession(client, 'discord-old-target');
      await client.exec(
        `INSERT INTO im_bindings (
          channel, bot_context_id, user_id, scope_key, target_session_id,
          attached_at, attached_via_card_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          'feishu',
          'feishu-bot',
          'ou_old',
          '',
          'desktop-target',
          100,
          'feishu-card',
          'discord',
          'discord-bot',
          '123456',
          '',
          'discord-old-target',
          150,
          'discord-old-card',
        ],
      );

      await client.tx('im.replaceBinding', {
        channel: 'discord',
        botContextId: 'discord-bot',
        userId: '123456',
        scopeKey: '',
        targetSessionId: 'desktop-target',
        attachedAt: 200,
        attachedViaCardMessageId: 'discord-card',
      });

      await expect(
        client.query(
          `SELECT channel, bot_context_id, user_id, scope_key, target_session_id,
                  attached_at, attached_via_card_message_id
           FROM im_bindings`,
        ),
      ).resolves.toEqual([
        {
          channel: 'discord',
          bot_context_id: 'discord-bot',
          user_id: '123456',
          scope_key: '',
          target_session_id: 'desktop-target',
          attached_at: 200,
          attached_via_card_message_id: 'discord-card',
        },
      ]);
    });
  });

  it('im.replaceBinding restores the previous owner when the new insert fails', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'desktop-target');
      await client.exec(
        `INSERT INTO im_bindings (
          channel, bot_context_id, user_id, scope_key, target_session_id,
          attached_at, attached_via_card_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['feishu', 'feishu-bot', 'ou_old', '', 'desktop-target', 100, 'feishu-card'],
      );
      await client.exec(
        `CREATE TRIGGER reject_discord_binding
         BEFORE INSERT ON im_bindings
         WHEN NEW.channel = 'discord'
         BEGIN
           SELECT RAISE(ABORT, 'simulated binding insert failure');
         END`,
      );

      await expect(
        client.tx('im.replaceBinding', {
          channel: 'discord',
          botContextId: 'discord-bot',
          userId: '123456',
          scopeKey: '',
          targetSessionId: 'desktop-target',
          attachedAt: 200,
          attachedViaCardMessageId: 'discord-card',
        }),
      ).rejects.toThrow('simulated binding insert failure');

      await expect(
        client.query(
          `SELECT channel, bot_context_id, user_id, scope_key, target_session_id,
                  attached_at, attached_via_card_message_id
           FROM im_bindings`,
        ),
      ).resolves.toEqual([
        {
          channel: 'feishu',
          bot_context_id: 'feishu-bot',
          user_id: 'ou_old',
          scope_key: '',
          target_session_id: 'desktop-target',
          attached_at: 100,
          attached_via_card_message_id: 'feishu-card',
        },
      ]);
    });
  });

  it('im.deleteBindings rolls back every startup cleanup when a later delete fails', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'desktop-target');
      await client.exec(
        `INSERT INTO im_bindings (
          channel, bot_context_id, user_id, scope_key, target_session_id,
          attached_at, attached_via_card_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          'feishu',
          'feishu-bot',
          'ou_old',
          '',
          'desktop-target',
          100,
          'feishu-card',
          'discord',
          'discord-bot',
          '123456',
          '',
          'desktop-target',
          150,
          'discord-card',
        ],
      );
      await client.exec(
        `CREATE TRIGGER reject_discord_binding_delete
         BEFORE DELETE ON im_bindings
         WHEN OLD.channel = 'discord'
         BEGIN
           SELECT RAISE(ABORT, 'simulated binding delete failure');
         END`,
      );

      await expect(
        client.tx('im.deleteBindings', {
          identities: [
            {
              channel: 'feishu',
              botContextId: 'feishu-bot',
              userId: 'ou_old',
              scopeKey: '',
            },
            {
              channel: 'discord',
              botContextId: 'discord-bot',
              userId: '123456',
              scopeKey: '',
            },
          ],
        }),
      ).rejects.toThrow('simulated binding delete failure');

      await expect(
        client.query(
          `SELECT channel, bot_context_id, user_id, scope_key, target_session_id,
                  attached_at, attached_via_card_message_id
           FROM im_bindings
           ORDER BY attached_at`,
        ),
      ).resolves.toEqual([
        {
          channel: 'feishu',
          bot_context_id: 'feishu-bot',
          user_id: 'ou_old',
          scope_key: '',
          target_session_id: 'desktop-target',
          attached_at: 100,
          attached_via_card_message_id: 'feishu-card',
        },
        {
          channel: 'discord',
          bot_context_id: 'discord-bot',
          user_id: '123456',
          scope_key: '',
          target_session_id: 'desktop-target',
          attached_at: 150,
          attached_via_card_message_id: 'discord-card',
        },
      ]);
    });
  });

  it('embedding.markDone marks jobs done without writing vectors', async () => {
    await withClient(async (client) => {
      const rowid = await insertJob(client, { sourceId: 'm1' });
      await client.tx('embedding.markDone', { rowids: [rowid] });
      await expect(
        client.queryOne('SELECT status, last_error FROM embedding_jobs WHERE rowid = ?', [rowid]),
      ).resolves.toEqual({
        status: 'done',
        last_error: null,
      });
    });
  });

  it('embedding.commit writes Float32Array blobs and marks jobs done', async () => {
    await withClient(async (client) => {
      const rowid = await insertJob(client, { sourceId: 'm1' });
      const embedding = new Float32Array([1, 2, 3, 4]);
      await client.tx('embedding.commit', { items: [{ rowid, vecTable: 'chat_vec', embedding }] }, [
        embedding.buffer,
      ]);

      await expect(
        client.queryOne('SELECT status FROM embedding_jobs WHERE rowid = ?', [rowid]),
      ).resolves.toEqual({
        status: 'done',
      });
      await expect(
        client.queryOne('SELECT rowid, length(embedding) AS len FROM chat_vec'),
      ).resolves.toEqual({
        rowid,
        len: 16,
      });
      expect(embedding.buffer.byteLength).toBe(0);
    });
  });

  it('embedding.commit does not restore a vector after its job was deleted', async () => {
    await withClient(async (client) => {
      const rowid = await insertJob(client, { sourceId: 'deleted-message' });
      await client.exec('INSERT INTO chat_vec (rowid, embedding) VALUES (?, ?)', [
        rowid,
        Buffer.from([1, 2, 3, 4]),
      ]);
      await client.exec('DELETE FROM embedding_jobs WHERE rowid = ?', [rowid]);

      const lateEmbedding = new Float32Array([9, 9, 9, 9]);
      await client.tx(
        'embedding.commit',
        { items: [{ rowid, vecTable: 'chat_vec', embedding: lateEmbedding }] },
        [lateEmbedding.buffer],
      );

      await expect(client.query('SELECT rowid FROM chat_vec')).resolves.toEqual([]);
    });
  });

  // 锁定 idempotent 重试:同一 rowid 的 vec 行已存在时,再次 commit 不应撞 UNIQUE,
  // 旧 embedding 应被新值覆盖。原 INSERT OR REPLACE 写法在生产 sqlite-vec vec0 虚表
  // 上不生效,改成 DELETE + plain INSERT 后必须保证此行为不退化(回归)。
  it('embedding.commit replaces existing vec row on retry without UNIQUE conflict', async () => {
    await withClient(async (client) => {
      const rowid = await insertJob(client, { sourceId: 'm1' });
      const first = new Float32Array([1, 2, 3, 4]);
      await client.tx(
        'embedding.commit',
        { items: [{ rowid, vecTable: 'chat_vec', embedding: first }] },
        [first.buffer],
      );

      // 模拟 retry 场景:vec 行已存在,jobs 重置回 pending,再次 commit 应成功 + 覆盖。
      await client.exec(`UPDATE embedding_jobs SET status = 'pending' WHERE rowid = ?`, [rowid]);
      const second = new Float32Array([9, 9, 9, 9, 9, 9, 9, 9]);
      await client.tx(
        'embedding.commit',
        { items: [{ rowid, vecTable: 'chat_vec', embedding: second }] },
        [second.buffer],
      );

      await expect(
        client.queryOne('SELECT status FROM embedding_jobs WHERE rowid = ?', [rowid]),
      ).resolves.toEqual({
        status: 'done',
      });
      await expect(
        client.queryOne('SELECT COUNT(*) AS n FROM chat_vec WHERE rowid = ?', [rowid]),
      ).resolves.toEqual({
        n: 1,
      });
      await expect(
        client.queryOne('SELECT rowid, length(embedding) AS len FROM chat_vec'),
      ).resolves.toEqual({
        rowid,
        len: 32,
      });
    });
  });

  it('embedding.recordFailures reschedules retries and marks exhausted jobs failed', async () => {
    await withClient(async (client) => {
      const retryRowid = await insertJob(client, { sourceId: 'retry', attempts: 0 });
      const failRowid = await insertJob(client, { sourceId: 'fail', attempts: 4 });
      const result = await client.tx('embedding.recordFailures', {
        jobs: [
          { rowid: retryRowid, attempts: 0 },
          { rowid: failRowid, attempts: 4 },
        ],
        errMsg: 'boom',
        now: 10_000,
      });

      expect(result).toEqual({ failCount: 1 });
      await expect(
        client.query(
          'SELECT rowid, status, attempts, scheduled_at FROM embedding_jobs ORDER BY rowid',
        ),
      ).resolves.toEqual([
        { rowid: retryRowid, status: 'pending', attempts: 1, scheduled_at: 11_000 },
        { rowid: failRowid, status: 'failed', attempts: 5, scheduled_at: 0 },
      ]);
    });
  });

  it('embedding.enqueue inserts only new natural-key jobs', async () => {
    await withClient(async (client) => {
      const result = await client.tx('embedding.enqueue', {
        source: 'chat',
        now: 123,
        items: [
          { sourceId: 'm1', modelId: 'voyage', vecTable: 'chat_vec' },
          { sourceId: 'm1', modelId: 'voyage', vecTable: 'chat_vec' },
          { sourceId: 'm2', chunkIndex: 1, modelId: 'voyage', vecTable: 'chat_vec' },
        ],
      });

      expect(result).toEqual({ inserted: 2, skipped: 1 });
      await expect(
        client.query(
          'SELECT source_id, chunk_index, scheduled_at FROM embedding_jobs ORDER BY rowid',
        ),
      ).resolves.toEqual([
        { source_id: 'm1', chunk_index: 0, scheduled_at: 123 },
        { source_id: 'm2', chunk_index: 1, scheduled_at: 123 },
      ]);
    });
  });

  it('orca.removeWorker deletes the worker and archives its session atomically', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'lead');
      await seedSession(client, 'worker', { orcaRole: 'worker' });
      await client.exec(
        'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['team-1', 'lead', 'active', 1, 1],
      );
      await client.exec(
        'INSERT INTO orca_workers (id, team_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['worker-1', 'team-1', 'worker', 'idle', 1, 1],
      );

      const archivedSessionId = await client.tx<string | null>('orca.removeWorker', {
        workerId: 'worker-1',
        now: 999,
      });
      const missingSessionId = await client.tx<string | null>('orca.removeWorker', {
        workerId: 'missing',
        now: 1000,
      });

      expect(archivedSessionId).toBe('worker');
      expect(missingSessionId).toBeNull();
      await expect(
        client.queryOne('SELECT id FROM orca_workers WHERE id = ?', ['worker-1']),
      ).resolves.toBeUndefined();
      await expect(
        client.queryOne('SELECT status, orca_role, updated_at FROM sessions WHERE id = ?', [
          'worker',
        ]),
      ).resolves.toEqual({
        status: 'archived',
        orca_role: null,
        updated_at: 999,
      });
    });
  });

  it('serializes the same worker label across independent database workers', async () => {
    await withTwoClients(async ([first, second]) => {
      await seedSession(first, 'lead');
      await first.exec(
        'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['team-1', 'lead', 'active', 1, 1],
      );
      const results = await Promise.all([
        first.tx('orca.reserveWorkerCreation', {
          reservationId: 'first',
          teamId: 'team-1',
          label: 'tester',
          hardLimit: 5,
          now: 100,
          expiresAt: 200,
        }),
        second.tx('orca.reserveWorkerCreation', {
          reservationId: 'second',
          teamId: 'team-1',
          label: 'TESTER',
          hardLimit: 5,
          now: 100,
          expiresAt: 200,
        }),
      ]);
      expect(results).toContainEqual({ ok: true, occupiedSlotsBefore: 0 });
      expect(results).toContainEqual({ ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' });
    });
  });

  it('counts terminal workers until their sessions are archived', async () => {
    await withClient(async (client) => {
      await seedSession(client, 'lead');
      await seedSession(client, 'done-worker', { orcaRole: 'worker' });
      await seedSession(client, 'errored-worker', { orcaRole: 'worker' });
      await client.exec(
        'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['team-1', 'lead', 'active', 1, 1],
      );
      await client.exec(
        `INSERT INTO orca_workers (
          id, team_id, session_id, status, label, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['worker-1', 'team-1', 'done-worker', 'done', 'done', 'tester', 1, 1],
      );
      await client.exec(
        `INSERT INTO orca_workers (
          id, team_id, session_id, status, label, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['worker-2', 'team-1', 'errored-worker', 'error', 'errored', 'reviewer', 1, 1],
      );

      await expect(
        client.tx('orca.reserveWorkerCreation', {
          reservationId: 'blocked',
          teamId: 'team-1',
          label: 'blocked',
          hardLimit: 2,
          now: 100,
          expiresAt: 200,
        }),
      ).resolves.toEqual({ ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' });

      await client.exec("UPDATE sessions SET status = 'archived' WHERE id = ?", ['done-worker']);

      await expect(
        client.tx('orca.reserveWorkerCreation', {
          reservationId: 'replacement',
          teamId: 'team-1',
          label: 'replacement',
          hardLimit: 2,
          now: 100,
          expiresAt: 200,
        }),
      ).resolves.toEqual({ ok: true, occupiedSlotsBefore: 1 });
    });
  });
});

async function withClient(fn: (client: DbClient) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-tx-'));
  const drizzleDir = path.join(dir, 'drizzle');
  const dbPath = path.join(dir, 'xdt-maker-test-user.db');
  fs.mkdirSync(drizzleDir);
  fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), INIT_SQL, 'utf-8');
  createMigratedTxDb(dbPath);
  let client: DbClient | undefined;
  try {
    client = await createDbClient({
      userId: 'test-user',
      dbPath,
      drizzleDir,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      workerScriptPath,
    });
    await fn(client);
  } finally {
    if (client) {
      await client.dispose();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTwoClients(fn: (clients: [DbClient, DbClient]) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-tx-two-'));
  const drizzleDir = path.join(dir, 'drizzle');
  const dbPath = path.join(dir, 'xdt-maker-test-user.db');
  fs.mkdirSync(drizzleDir);
  fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), INIT_SQL, 'utf-8');
  createMigratedTxDb(dbPath);
  const clients: DbClient[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      clients.push(
        await createDbClient({
          userId: `test-user-${index}`,
          dbPath,
          drizzleDir,
          betterSqliteModulePath: require.resolve('better-sqlite3'),
          workerScriptPath,
        }),
      );
    }
    await fn(clients as [DbClient, DbClient]);
  } finally {
    await Promise.all(clients.map((client) => client.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMigratedTxDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(INIT_SQL);
    db.prepare("INSERT INTO migration_meta (key, value) VALUES ('schema_version', '0')").run();
  } finally {
    db.close();
  }
}

async function seedSession(
  client: DbClient,
  id: string,
  overrides: Partial<TestSessionRow> = {},
): Promise<void> {
  const s = sessionRow(id, overrides);
  await client.exec(
    `INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
      context_window, fast_mode, cleared_at, pinned_at, user_send_at,
      agent_kind, orca_role, workspace_kind, parent_session_id, forked_at_message_id,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.id,
      s.title,
      s.workingDir,
      s.model,
      s.effort,
      s.permissionMode,
      s.status,
      s.sdkSessionId,
      s.totalTokenUsage,
      s.totalCostUsd,
      s.contextTokens,
      s.contextWindow,
      s.fastMode ? 1 : 0,
      s.clearedAt,
      s.pinnedAt,
      s.userSendAt,
      s.agentKind,
      s.orcaRole,
      s.workspaceKind,
      s.parentSessionId,
      s.forkedAtMessageId,
      s.createdAt,
      s.updatedAt,
    ],
  );
}

function sessionRow(id: string, overrides: Partial<TestSessionRow> = {}): TestSessionRow {
  return {
    id,
    title: `Session ${id}`,
    workingDir: null,
    model: 'claude',
    providerId: null,
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: `sdk-${id}`,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 10,
    contextWindow: 100,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: 1,
    agentKind: 'cc',
    orcaRole: null,
    workspaceKind: 'project',
    codexHistoryHasProductPrompt: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function insertJob(
  client: DbClient,
  opts: { sourceId: string; attempts?: number },
): Promise<number> {
  const info = await client.exec(
    `INSERT INTO embedding_jobs
      (source, source_id, chunk_index, model_id, vec_table, status, attempts, scheduled_at)
     VALUES (?, ?, 0, ?, ?, 'pending', ?, 0)`,
    ['chat', opts.sourceId, 'voyage', 'chat_vec', opts.attempts ?? 0],
  );
  return Number(info.lastInsertRowid);
}
