import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { count, eq } from 'drizzle-orm';

import { createDbClient } from '../DbClient.js';
import { messages, sessions } from '../../schema.js';
import * as schema from '../../schema.js';

// drizzle proxy 只验证 Drizzle builder → worker op 的映射语义。这里用最小表结构
// 覆盖当前 schema.ts 中被 select(sessions/messages) 展开的列，避免为 proxy 单测
// 回放整条 migration 链，也避免 sqlite-vec 虚表缺失时留下依赖它的 trigger。
const DRIZZLE_PROXY_SCHEMA = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      summary TEXT,
      provider_id TEXT,
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
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      one_m INTEGER NOT NULL DEFAULT 0,
      codex_plan_json TEXT,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  `
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER,
      UNIQUE(session_id, client_id)
    )
  `,
];

describe('drizzle proxy', () => {
  it('maps nested select rows with drizzle mapResultRow semantics', async () => {
    const inProc = new Database(':memory:');
    const client = await createDbClient({ useInlineWorker: true });
    try {
      applyDrizzleProxySchema(inProc);
      await applyDrizzleProxySchema(client);
      for (const target of [inProc, client] as const) {
        if ('prepare' in target) {
          target
            .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run('s1', 'Session 1', 1, 2);
          target
            .prepare(
              'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run('m1', 'c1', 's1', 'user', '"hello"', 3);
        } else {
          await target.exec(
            'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
            ['s1', 'Session 1', 1, 2],
          );
          await target.exec(
            'INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['m1', 'c1', 's1', 'user', '"hello"', 3],
          );
        }
      }

      const query = (db: BetterSQLite3Database<typeof schema>) =>
        db
          .select({ session: sessions, messageCount: count(messages.id) })
          .from(sessions)
          .leftJoin(messages, eq(messages.sessionId, sessions.id))
          .groupBy(sessions.id)
          .get();

      expect(await query(client.drizzle)).toEqual(await query(drizzle(inProc, { schema })));
    } finally {
      inProc.close();
      await client.dispose();
    }
  });

  it('routes INSERT/UPDATE/DELETE through run op (not query) so .all() does not throw', async () => {
    // 回归测试 — 防退化:bootstrap-electron startup 后 IPC 'local-db:sessions:create'
    // 报 "TypeError: This statement does not return data. Use run() instead"。
    // 根因:drizzleProxy.executeAll 对非 select builder fallthrough 到 worker 'query'
    // op(stmt.all),better-sqlite3 对 INSERT/UPDATE/DELETE 走 .all() 抛错。
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await applyDrizzleProxySchema(client);

      // INSERT — await db.insert(...).values(...) 触发隐式 terminal
      await client.drizzle
        .insert(sessions as never)
        .values({ id: 's1', title: 'a', createdAt: 1, updatedAt: 1 } as never)
        .onConflictDoNothing()
        .run();
      // 也测一遍纯 await(不显式 .run())触发 then → executeAll 路径
      await client.drizzle
        .insert(sessions as never)
        .values({ id: 's2', title: 'b', createdAt: 2, updatedAt: 2 } as never);

      // UPDATE
      await client.drizzle.update(sessions).set({ title: 'updated' }).where(eq(sessions.id, 's1'));

      // DELETE
      await client.drizzle.delete(sessions).where(eq(sessions.id, 's2'));

      const remaining = await client.drizzle.select().from(sessions);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe('s1');
      expect(remaining[0]?.title).toBe('updated');
    } finally {
      await client.dispose();
    }
  });

  it('explicit .run() 透传 worker 的 { changes };隐式 await 会丢弃写结果', async () => {
    // 回归测试 — 防退化:scheduler claimDueFire 的 CAS 认领依赖 UPDATE 的 changes
    // 判胜负。executeAll(隐式 await)对非 SELECT 固定返回 [],changes 只能从
    // executeRun(显式 .run())拿到;这条契约破了,所有靠 changes 的写路径
    // (认领互斥、未读计数)会静默失效或按新 throw 语义死循环。
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await applyDrizzleProxySchema(client);
      await client.drizzle
        .insert(sessions as never)
        .values({ id: 's1', title: 'a', createdAt: 1, updatedAt: 1 } as never);

      // 命中 1 行
      const hit = await client.drizzle
        .update(sessions)
        .set({ title: 'claimed' })
        .where(eq(sessions.id, 's1'))
        .run();
      expect(hit.changes).toBe(1);

      // 条件不匹配 → changes=0(CAS 判负路径)
      const miss = await client.drizzle
        .update(sessions)
        .set({ title: 'nope' })
        .where(eq(sessions.id, 'no-such-row'))
        .run();
      expect(miss.changes).toBe(0);

      // DELETE 同样透传
      const del = await client.drizzle.delete(sessions).where(eq(sessions.id, 's1')).run();
      expect(del.changes).toBe(1);
    } finally {
      await client.dispose();
    }
  });
});

function applyDrizzleProxySchema(target: Database.Database): void;
function applyDrizzleProxySchema(target: Awaited<ReturnType<typeof createDbClient>>): Promise<void>;
function applyDrizzleProxySchema(
  target: Database.Database | Awaited<ReturnType<typeof createDbClient>>,
): Promise<void> | void {
  if ('prepare' in target) {
    for (const statement of DRIZZLE_PROXY_SCHEMA) target.exec(statement);
    return;
  }

  return applyDrizzleProxySchemaToClient(target);
}

async function applyDrizzleProxySchemaToClient(
  client: Awaited<ReturnType<typeof createDbClient>>,
): Promise<void> {
  for (const statement of DRIZZLE_PROXY_SCHEMA) await client.exec(statement);
}
