import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { DbClient } from '../client/DbClient';
import {
  messageCreateToRow,
  messageToCamel,
  serializePersistedAgentMeta,
} from '../mapper';
import { patchMessageAgentMetaWithResultRow } from '../messageMutations';

// 测试价值（engineering-conventions.md §3.2）：
// 1. 依据：sessionEventPreparation 在活跃轮次子事件上附带默认 botPrivateReply:false 与
//    botTaskCoordination:false；持久层查询与旧版本历史读取对缺省/NULL 与 false 语义一致。
// 2. 覆盖缺口：验证新写入行收敛为 NULL/精简 JSON、显式终态 false（samplingAttemptPending/turnCompleted）保留、
//    以及旧版本遗留含 false 的行在回读、SQL 过滤和补丁更新下的向后/降级兼容性。
// 3. 最小失败输入：{ botPrivateReply: false, botTaskCoordination: false } 落库，及对含该旧格式的行执行 patchMessageAgentMetaWithResultRow。
// 4. tier：unit（内存合成 SQLite，耗时 < 50ms）。
describe('messageCreateToRow & patchMessageAgentMetaWithResultRow — lossless agent_meta sparsification', () => {
  it('collapses default-false bot routing flags to null when no other metadata exists', () => {
    const row = messageCreateToRow(
      'msg-1',
      'session-1',
      {
        clientId: 'client-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        agentMeta: {
          botPrivateReply: false,
          botTaskCoordination: false,
        },
      },
      1_700_000_000_000,
    );

    expect(row.agentMeta).toBeNull();
    const hydrated = messageToCamel({
      ...row,
      toolUseId: row.toolUseId ?? null,
      agentMeta: row.agentMeta ?? null,
      agentKind: row.agentKind ?? null,
      rewindAt: null,
    });
    expect(hydrated.agentMeta).toBeNull();
  });

  it('strips only default-false bot flags while preserving sibling routing and usage fields', () => {
    const row = messageCreateToRow(
      'msg-2',
      'session-1',
      {
        clientId: 'client-2',
        role: 'tool_use',
        content: { toolUseId: 'tool-2', toolName: 'Read', input: {} },
        toolUseId: 'tool-2',
        agentMeta: {
          replyToClientId: 'user-1',
          sdkSessionId: 'sdk-1',
          botPrivateReply: false,
          botTaskCoordination: false,
        },
      },
      1_700_000_000_000,
    );

    expect(row.agentMeta).toBe('{"replyToClientId":"user-1","sdkSessionId":"sdk-1"}');
  });

  it('preserves true bot flags and explicit terminal false markers required by hydration', () => {
    expect(
      serializePersistedAgentMeta({
        botPrivateReply: true,
        botTaskCoordination: true,
        samplingAttemptPending: false,
        turnCompleted: false,
      }),
    ).toBe(
      '{"botPrivateReply":true,"botTaskCoordination":true,"samplingAttemptPending":false,"turnCompleted":false}',
    );
  });

  it('maintains SQL predicate parity with legacy rows and compacts legacy false flags on patch', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, cleared_at INTEGER);
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
        INSERT INTO sessions VALUES ('s1', 'active', NULL);
      `);
      // Legacy row written by older version with explicit false flags, new sparse NULL row, and private-reply row.
      sqlite
        .prepare(
          'INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)',
        )
        .run(
          'legacy',
          'c-legacy',
          's1',
          'assistant',
          '"public legacy"',
          '{"botPrivateReply":false,"botTaskCoordination":false,"model":"m1"}',
          1000,
        );
      const sparseInsert = messageCreateToRow(
        'sparse',
        's1',
        {
          clientId: 'c-sparse',
          role: 'assistant',
          content: 'public sparse',
          agentMeta: { botPrivateReply: false, botTaskCoordination: false },
        },
        1001,
      );
      sqlite
        .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(
          sparseInsert.id,
          sparseInsert.clientId,
          sparseInsert.sessionId,
          sparseInsert.role,
          sparseInsert.content,
          sparseInsert.toolUseId ?? null,
          sparseInsert.agentMeta ?? null,
          sparseInsert.agentKind ?? null,
          sparseInsert.createdAt,
        );
      sqlite
        .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)')
        .run('priv', 'c-priv', 's1', 'assistant', '"private"', '{"botPrivateReply":true}', 1002);

      // Exact predicate from localDb/ipc/bots.ts: public visibility matches both legacy false and sparse NULL.
      const publicIds = sqlite
        .prepare(
          `SELECT id FROM messages
            WHERE (agent_meta IS NULL OR json_extract(agent_meta, '$.botPrivateReply') IS NOT 1)
            ORDER BY created_at`,
        )
        .all() as Array<{ id: string }>;
      expect(publicIds.map((r) => r.id)).toEqual(['legacy', 'sparse']);

      const client = { drizzle: drizzle(sqlite) } as unknown as DbClient;
      await patchMessageAgentMetaWithResultRow(client, 's1', 'c-legacy', { turnCompleted: true });
      const patched = sqlite
        .prepare('SELECT agent_meta FROM messages WHERE id = ?')
        .get('legacy') as { agent_meta: string | null };
      expect(patched.agent_meta).toBe('{"model":"m1","turnCompleted":true}');
    } finally {
      sqlite.close();
    }
  });
});
