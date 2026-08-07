import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  client: null as unknown,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => holder.client,
  tryGetDbClient: () => holder.client,
}));

import {
  GROUP_CONTEXT_CURSOR_RETENTION_MS,
  GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES,
  assembleGroupWindowContext,
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
    query: async <T>(sql: string, params: unknown[] = []) => {
      holder.queries.push({ sql, params });
      return sqlite.prepare(sql).all(...params) as T[];
    },
  };
}

function installGroupHistoryMigrations(): void {
  sqlite.exec(readMigration('0087_'));
  sqlite.exec(readMigration('0088_'));
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
  rawSequence = 0;
  holder.queries = [];
  installClient();
});

afterEach(() => sqlite.close());

describe('group history FTS', () => {
  it('migration 回填老行，并用仓内 LIKE 兜底召回中文子串', async () => {
    insertRaw({ messageId: 'legacy', text: '发布边界索引配置说明' });
    installGroupHistoryMigrations();

    const hits = await searchGroupHistory({ lane: LANE, query: '边界' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ messageId: 'legacy', source: 'like' });
    await expect(getGroupWindowNamespaceStats(LANE.provider)).resolves.toEqual({
      rows: 1,
      textBytes: Buffer.byteLength('发布边界索引配置说明', 'utf8'),
    });
  });

  it('MATCH 与 LIKE 都在 SQL 内强制 provider/chat/thread lane 隔离', async () => {
    installGroupHistoryMigrations();
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
    const likeQuery = holder.queries.findLast(({ sql }) => sql.includes('NOT IN'));
    expect(likeQuery?.sql).toContain('matched.provider = ?');
    expect(likeQuery?.sql).toContain('matched.chat_id = ?');
    expect(likeQuery?.sql).toContain('matched.thread_id = ?');
    expect(likeQuery?.params.slice(-5)).toEqual([
      '"边界"',
      LANE.provider,
      LANE.chatId,
      LANE.threadId,
      8,
    ]);

    await expect(
      searchGroupHistory({ lane: { ...LANE, provider: '' }, query: 'rollback' }),
    ).rejects.toThrow('provider is required');
  });

  it('insert/update/delete 触发器保持派生索引同步', async () => {
    installGroupHistoryMigrations();
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
    installGroupHistoryMigrations();
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

  it('容量统计由 migration 回填和触发器增量维护，不扫描永久历史', async () => {
    let expectedBytes = 0;
    const insertHistory = sqlite.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const text = `永久历史-${index}`;
        expectedBytes += Buffer.byteLength(text, 'utf8');
        insertRaw({ text });
      }
    });
    insertHistory();
    installGroupHistoryMigrations();

    await expect(getGroupWindowNamespaceStats(LANE.provider)).resolves.toEqual({
      rows: 1_000,
      textBytes: expectedBytes,
    });

    await recordGroupWindowEntry({
      ...LANE,
      messageId: 'incremental',
      author: { name: 'alice' },
      text: '新增正文',
      sentAt: Date.now(),
    });
    expectedBytes += Buffer.byteLength('新增正文', 'utf8');
    await expect(getGroupWindowNamespaceStats(LANE.provider)).resolves.toEqual({
      rows: 1_001,
      textBytes: expectedBytes,
    });

    sqlite.prepare('DELETE FROM hook_group_messages WHERE message_id = ?').run('incremental');
    await expect(getGroupWindowNamespaceStats(LANE.provider)).resolves.toEqual({
      rows: 1_000,
      textBytes: expectedBytes - Buffer.byteLength('新增正文', 'utf8'),
    });
    const plan = sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT row_count, text_bytes FROM hook_group_message_stats WHERE provider = ?',
      )
      .all(LANE.provider) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('SEARCH hook_group_message_stats'))).toBe(
      true,
    );
  });

  it('仍有历史时保留过期高水位，重启或内存淘汰后不重复回放', async () => {
    installGroupHistoryMigrations();
    insertRaw({ messageId: 'before-restart', text: '已经消费的群历史' });
    const cursorKey = 'stable-lane';
    const assemble = (cursors: Map<string, number>) =>
      assembleGroupWindowContext({
        ...LANE,
        cursors,
        cursorKey,
        triggerMessageId: null,
        neutralize: (value) => value,
        log: { info: vi.fn(), warn: vi.fn() } as never,
      });

    const initial = await assemble(new Map());
    expect(initial.prefix).toContain('已经消费的群历史');
    await initial.commit();

    const now = Date.now();
    sqlite
      .prepare('UPDATE hook_group_context_cursors SET updated_at = ? WHERE cursor_key = ?')
      .run(now - GROUP_CONTEXT_CURSOR_RETENTION_MS - 1, cursorKey);

    await expect(sweepExpiredGroupWindowCursors(now)).resolves.toBe(0);
    const restarted = await assemble(new Map());
    expect(restarted.prefix).toBe('');

    sqlite.prepare('DELETE FROM hook_group_messages WHERE provider = ?').run(LANE.provider);
    await expect(sweepExpiredGroupWindowCursors(now)).resolves.toBe(1);
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM hook_group_context_cursors WHERE provider = ?')
        .get(LANE.provider),
    ).toEqual({ count: 0 });
  });
});
