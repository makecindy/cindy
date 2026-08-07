import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => holder.client,
  tryGetDbClient: () => holder.client,
}));

import {
  GROUP_CONTEXT_CURSOR_RETENTION_MS,
  GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES,
  getGroupWindowNamespaceStats,
  recordGroupWindowEntry,
  sweepExpiredGroupWindowCursors,
} from '../groupWindowCore';
import { searchGroupHistory } from '../groupHistorySearch';

function readMigration(prefix: string): string {
  const dir = path.resolve(__dirname, '../../../../../drizzle');
  const file = fs.readdirSync(dir).find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`${prefix} migration not found`);
  return fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('--> statement-breakpoint', ';');
}

const LANE = { provider: 'telegram:owner-a', chatId: '-900', threadId: '' };
let sqlite: InstanceType<typeof Database>;
let rawSequence = 0;

function installClient(): void {
  holder.client = {
    drizzle: drizzle(sqlite),
    query: async <T>(sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(...params) as T[],
  };
}

function insertRaw(
  overrides: Partial<{
    provider: string;
    chatId: string;
    threadId: string;
    messageId: string;
    text: string;
    author: string;
    sentAt: number;
  }> = {},
): void {
  rawSequence += 1;
  const row = {
    provider: LANE.provider,
    chatId: LANE.chatId,
    threadId: LANE.threadId,
    messageId: `m-${rawSequence}`,
    text: '默认正文',
    author: 'alice',
    sentAt: Date.now(),
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO hook_group_messages
        (provider, chat_id, thread_id, message_id, chat_name, author, is_bot, text, file_names, sent_at, created_at)
       VALUES (?, ?, ?, ?, 'Ops', ?, 0, ?, NULL, ?, ?)`,
    )
    .run(
      row.provider,
      row.chatId,
      row.threadId,
      row.messageId,
      row.author,
      row.text,
      row.sentAt,
      Date.now(),
    );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readMigration('0083_'));
  sqlite.exec(readMigration('0086_'));
  installClient();
});

afterEach(() => sqlite.close());

describe('group history FTS', () => {
  it('migration 回填老行，并用仓内 LIKE 兜底召回中文子串', async () => {
    insertRaw({ messageId: 'legacy', text: '发布边界索引配置说明' });
    sqlite.exec(readMigration('0087_'));

    const hits = await searchGroupHistory({ lane: LANE, query: '边界' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ messageId: 'legacy', source: 'like' });
  });

  it('MATCH 与 LIKE 都在 SQL 内强制 provider/chat/thread lane 隔离', async () => {
    sqlite.exec(readMigration('0087_'));
    insertRaw({ messageId: 'allowed', text: 'deploy rollback checklist' });
    insertRaw({
      provider: 'telegram:owner-b',
      messageId: 'other-provider',
      text: 'deploy rollback checklist',
    });
    insertRaw({ chatId: '-901', messageId: 'other-chat', text: 'deploy rollback checklist' });
    insertRaw({ threadId: '77', messageId: 'other-thread', text: 'deploy rollback checklist' });

    const hits = await searchGroupHistory({ lane: LANE, query: 'rollback' });
    expect(hits.map((hit) => hit.messageId)).toEqual(['allowed']);

    insertRaw({ messageId: 'allowed-cjk', text: '发布边界核验说明' });
    insertRaw({
      provider: 'telegram:owner-b',
      messageId: 'other-provider-cjk',
      text: '跨命名空间边界核验说明',
    });
    insertRaw({
      chatId: '-901',
      messageId: 'other-chat-cjk',
      text: '跨群边界核验说明',
    });
    insertRaw({
      threadId: '77',
      messageId: 'other-thread-cjk',
      text: '跨话题边界核验说明',
    });
    const cjkHits = await searchGroupHistory({ lane: LANE, query: '边界' });
    expect(cjkHits.map((hit) => hit.messageId)).toEqual(['allowed-cjk']);
    expect(cjkHits[0]?.source).toBe('like');

    await expect(
      searchGroupHistory({ lane: { ...LANE, provider: '' }, query: 'rollback' }),
    ).rejects.toThrow('provider is required');
  });

  it('insert/update/delete 触发器保持派生索引同步', async () => {
    sqlite.exec(readMigration('0087_'));
    await recordGroupWindowEntry({
      ...LANE,
      messageId: 'live',
      author: { name: 'alice' },
      text: 'alpha release',
      sentAt: Date.now(),
    });
    expect((await searchGroupHistory({ lane: LANE, query: 'alpha' }))[0]?.messageId).toBe('live');

    sqlite
      .prepare('UPDATE hook_group_messages SET text = ? WHERE message_id = ?')
      .run('beta release', 'live');
    expect(await searchGroupHistory({ lane: LANE, query: 'alpha' })).toHaveLength(0);
    expect((await searchGroupHistory({ lane: LANE, query: 'beta' }))[0]?.messageId).toBe('live');

    sqlite.prepare('DELETE FROM hook_group_messages WHERE message_id = ?').run('live');
    expect(await searchGroupHistory({ lane: LANE, query: 'beta' })).toHaveLength(0);
  });
});

describe('group window storage guardrails', () => {
  it('正文按 UTF-8 约 16KB 硬上限安全截断，统计按命名空间给出行数与字节', async () => {
    const text = '中'.repeat(6_000);
    await recordGroupWindowEntry({
      ...LANE,
      messageId: 'oversized',
      author: { name: 'alice' },
      text,
      sentAt: Date.now(),
    });
    const row = sqlite.prepare('SELECT text FROM hook_group_messages').get() as { text: string };
    expect(Buffer.byteLength(row.text, 'utf8')).toBeLessThanOrEqual(
      GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES,
    );
    expect(row.text).not.toContain('\ufffd');
    await expect(getGroupWindowNamespaceStats(LANE.provider)).resolves.toEqual({
      rows: 1,
      textBytes: Buffer.byteLength(row.text, 'utf8'),
    });
  });

  it('游标 retention 只删除 180 天未更新行', async () => {
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO hook_group_context_cursors (provider, cursor_key, cursor_id, updated_at)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      )
      .run(
        LANE.provider,
        'stale',
        1,
        now - GROUP_CONTEXT_CURSOR_RETENTION_MS - 1,
        LANE.provider,
        'fresh',
        2,
        now - GROUP_CONTEXT_CURSOR_RETENTION_MS + 1,
      );

    await expect(sweepExpiredGroupWindowCursors(now)).resolves.toBe(1);
    const rows = sqlite
      .prepare('SELECT cursor_key AS cursorKey FROM hook_group_context_cursors ORDER BY cursor_key')
      .all() as Array<{ cursorKey: string }>;
    expect(rows).toEqual([{ cursorKey: 'fresh' }]);
  });
});
