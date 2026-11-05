/**
 * 个人飞书 bot 的启动补写只能动个人 bot 的行。官方飞书 / Lark 机器人(hook)的任务
 * 同样写 source='feishu', 但没有 feishuBotAppId; 补写曾按 source 一刀切, 每次启动把
 * 用户在飞书里选进项目的官方任务挪回「对话」分组(PR #8947 review)。
 * 真 SQLite: 过滤条件写在 UPDATE ... WHERE 里, 只有真库能答出到底改了哪些行。
 * 表结构由 `getTableConfig(sessions)` 从生产 schema 现推, 不手抄。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, vi } from 'vitest';

import { sessions } from '../../../localDb/schema';
import { backfillPersonalFeishuSessions } from '../legacySessionBackfill';

function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

describe('backfillPersonalFeishuSessions', () => {
  it('补写个人飞书会话的分组与旧标题, 不动官方飞书 hook 任务', async () => {
    const raw = new Database(':memory:');
    raw.exec(createTableSql());
    const db = drizzle(raw);
    const row = (id: string, title: string, feishuBotAppId: string | null) =>
      ({
        id,
        title,
        status: 'active',
        agentKind: 'cc',
        model: 'm',
        permissionMode: 'auto',
        workingDir: '/Users/me/project',
        workspaceKind: 'project',
        source: 'feishu',
        feishuBotAppId,
        createdAt: 1,
        updatedAt: 1,
      }) as typeof sessions.$inferInsert;
    await db.insert(sessions).values([
      row('personal', '飞书 · 567890', 'cli_personal_bot'),
      row('official', '飞书 · 周报整理', null),
    ]);

    const warn = vi.fn();
    await backfillPersonalFeishuSessions(db, { warn });

    const rows = Object.fromEntries(
      (await db.select().from(sessions)).map((r) => [r.id, r]),
    );
    expect(rows.personal).toMatchObject({ workspaceKind: 'dialogue', title: '[飞书·DM] 567890', updatedAt: 1 });
    expect(rows.official).toMatchObject({ workspaceKind: 'project', title: '飞书 · 周报整理', updatedAt: 1 });
    expect(warn).not.toHaveBeenCalled();
  });
});
