import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import { regenerateTitleMaterial } from '../latestMessageText.js';
import * as schema from '../schema.js';

interface Harness {
  sqlite: Database.Database;
  client: DbClient;
  statements: string[];
}

let activeHarness: Harness | null = null;

function createHarness(): Harness {
  const statements: string[] = [];
  const sqlite = new Database(':memory:', {
    verbose: (statement) => {
      if (typeof statement === 'string') statements.push(statement);
    },
  });
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
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  const client = { drizzle: drizzle(sqlite, { schema }) } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
  activeHarness = { sqlite, client, statements };
  return activeHarness;
}

afterEach(() => {
  if (!activeHarness) return;
  clearCurrentDbClient(activeHarness.client);
  activeHarness.sqlite.close();
  activeHarness = null;
});

describe('regenerateTitleMaterial pagination', () => {
  it('reads past progress-only pages and stops once the effective budget has a complete turn', async () => {
    const { sqlite, statements } = createHarness();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (?, ?, 's1', ?, ?, NULL, ?, 1000, NULL)
    `);
    let sequence = 0;
    const add = (
      role: 'user' | 'assistant',
      text: string,
      agentMeta: Record<string, unknown> | null = null,
    ): void => {
      sequence += 1;
      insert.run(
        `m${sequence}`,
        `c${sequence}`,
        role,
        role === 'user' ? JSON.stringify({ text }) : JSON.stringify(text),
        agentMeta ? JSON.stringify(agentMeta) : null,
      );
    };

    sqlite.transaction(() => {
      for (let index = 0; index < 150; index += 1) {
        add('user', `历史轮次 ${index}`);
        add('assistant', `历史答复 ${index}`, { turnCompleted: true });
      }
      add('user', '当前需求：修复任务标题');
      for (let index = 0; index < 513; index += 1) {
        add('assistant', `施工播报 ${index}`, { uuid: `progress-${index}` });
      }
    })();
    statements.length = 0;

    const material = await regenerateTitleMaterial('s1', 3, true);

    expect(material.recent.map((message) => message.text)).toEqual([
      '历史轮次 149',
      '历史答复 149',
      '当前需求：修复任务标题',
    ]);
    expect(material.recent.every((message) => !message.text.startsWith('施工播报'))).toBe(true);

    const descendingRecentQueries = statements.filter(
      (statement) =>
        statement.includes('from "messages"') &&
        statement.includes('order by "messages"."created_at" desc') &&
        statement.includes('rowid desc'),
    );
    expect(descendingRecentQueries).toHaveLength(5);
  });

  it('excludes autoResume from both recent transcript and conversation opening', async () => {
    const { sqlite } = createHarness();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (?, ?, 's1', ?, ?, NULL, ?, ?, NULL)
    `);
    insert.run('m1', 'c1', 'user', JSON.stringify({ text: '继续' }), JSON.stringify({ autoResume: true }), 1);
    insert.run('m2', 'c2', 'user', JSON.stringify({ text: '真实需求：修复标题' }), null, 2);
    insert.run('m3', 'c3', 'assistant', JSON.stringify('已完成修复'), JSON.stringify({ turnCompleted: true }), 3);

    const material = await regenerateTitleMaterial('s1', 8);

    expect(material.opening).toMatchObject({ text: '真实需求：修复标题', rowid: 2 });
    expect(material.recent.map((message) => message.text)).toEqual([
      '真实需求：修复标题',
      '已完成修复',
    ]);
  });

  it('rechecks live turn state at the rowid snapshot boundary', async () => {
    const { sqlite } = createHarness();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (?, ?, 's1', ?, ?, NULL, ?, ?, NULL)
    `);
    insert.run('m1', 'c1', 'user', JSON.stringify({ text: '原始需求' }), null, 1);
    insert.run('m2', 'c2', 'assistant', JSON.stringify('历史答复'), JSON.stringify({ turnCompleted: true }), 2);

    let stateReads = 0;
    const material = await regenerateTitleMaterial('s1', 8, () => {
      stateReads += 1;
      if (stateReads === 1) {
        insert.run('m3', 'c3', 'user', JSON.stringify({ text: '新一轮需求' }), null, 3);
        insert.run('m4', 'c4', 'assistant', JSON.stringify('施工播报'), JSON.stringify({ uuid: 'progress' }), 4);
      }
      return true;
    });

    expect(stateReads).toBe(2);
    expect(material.recent.map((message) => message.text)).toEqual([
      '原始需求',
      '历史答复',
      '新一轮需求',
    ]);
    expect(material.recent.some((message) => message.text === '施工播报')).toBe(false);
  });
});
