import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import { latestMessage, regenerateTitleMaterial } from '../latestMessageText.js';
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
    insert.run(
      'm1',
      'c1',
      'user',
      JSON.stringify({ text: '继续' }),
      JSON.stringify({ autoResume: true }),
      1,
    );
    insert.run('m2', 'c2', 'user', JSON.stringify({ text: '真实需求：修复标题' }), null, 2);
    insert.run(
      'm3',
      'c3',
      'assistant',
      JSON.stringify('已完成修复'),
      JSON.stringify({ turnCompleted: true }),
      3,
    );

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
    insert.run(
      'm2',
      'c2',
      'assistant',
      JSON.stringify('历史答复'),
      JSON.stringify({ turnCompleted: true }),
      2,
    );

    let stateReads = 0;
    const material = await regenerateTitleMaterial('s1', 8, () => {
      stateReads += 1;
      if (stateReads === 1) {
        insert.run('m3', 'c3', 'user', JSON.stringify({ text: '新一轮需求' }), null, 3);
        insert.run(
          'm4',
          'c4',
          'assistant',
          JSON.stringify('施工播报'),
          JSON.stringify({ uuid: 'progress' }),
          4,
        );
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

describe('regenerateTitleMaterial hook user text', () => {
  it.each([false, true])(
    'uses the authored body for opening and recent messages (JSON content: %s)',
    async (jsonContent) => {
      const { sqlite } = createHarness();
      sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
      const insert = sqlite.prepare(`
      INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
      VALUES (?, ?, 's1', ?, ?, ?, ?)
    `);
      const background = `<group_chat_context>${'旧群聊背景'.repeat(100)}</group_chat_context>`;
      const opening = '修复手机滚动卡顿';
      const latest = '总结本周手机流畅性修改，包括草稿';
      for (const [index, body] of [opening, latest].entries()) {
        const text = background + body;
        insert.run(
          `u${index}`,
          `cu${index}`,
          'user',
          jsonContent ? JSON.stringify({ text }) : text,
          JSON.stringify({ hookSource: { im: 'telegram', userText: body } }),
          index * 2 + 1,
        );
        insert.run(
          `a${index}`,
          `ca${index}`,
          'assistant',
          JSON.stringify('已整理修改'),
          JSON.stringify({ turnCompleted: true, hookSource: { userText: '不应替换助手回复' } }),
          index * 2 + 2,
        );
      }
      const material = await regenerateTitleMaterial('s1', 2, false, { preferHookUserText: true });
      const predictionMaterial = await regenerateTitleMaterial('s1', 2);
      expect(predictionMaterial.opening.text).toBe(background + opening);
      expect(predictionMaterial.recent.map((m) => m.text)).toEqual([
        background + latest,
        '已整理修改',
      ]);
      expect(material.opening.text).toBe(opening);
      expect(material.recent.map((m) => m.text)).toEqual([latest, '已整理修改']);
      expect(material.recent[0].text.slice(0, 300)).toBe(latest);
    },
  );

  it.each([
    null,
    '{broken',
    '[]',
    JSON.stringify({ hookSource: null }),
    JSON.stringify({ hookSource: [] }),
    JSON.stringify({ hookSource: { im: 'telegram' } }),
    JSON.stringify({ hookSource: { userText: 42 } }),
    JSON.stringify({ hookSource: { userText: '' } }),
    JSON.stringify({ hookSource: { userText: '   ' } }),
  ])('preserves legacy and ordinary content for metadata %s', async (meta) => {
    const { sqlite } = createHarness();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    sqlite
      .prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
      VALUES ('u1', 'cu1', 's1', 'user', ?, ?, 1)`,
      )
      .run(JSON.stringify({ text: '原始用户正文' }), meta);
    const material = await regenerateTitleMaterial('s1', 8, false, { preferHookUserText: true });
    expect(material.opening.text).toBe('原始用户正文');
    expect(material.recent.map((m) => m.text)).toEqual(['原始用户正文']);
  });
});

describe('latestMessage visibility', () => {
  it('reads the clear boundary and latest non-rewound message in one statement', async () => {
    const { sqlite, statements } = createHarness();
    sqlite.exec("INSERT INTO sessions (id, cleared_at) VALUES ('s1', NULL)");
    const insert = sqlite.prepare(`INSERT INTO messages
      (id, client_id, session_id, role, content, created_at, rewind_at)
      VALUES (?, ?, 's1', 'assistant', ?, ?, ?)`);
    insert.run('a', 'a', JSON.stringify('old'), 100, null);
    insert.run('b', 'b', JSON.stringify('visible'), 200, null);
    insert.run('c', 'c', JSON.stringify('rewound'), 300, 400);
    statements.length = 0;
    expect(await latestMessage('s1', 'assistant')).toEqual({ text: 'visible', createdAt: 200 });
    const reads = statements.filter((s) => /^select/i.test(s));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/inner join "sessions"/i);
    expect(reads[0]).toContain('"sessions"."cleared_at"');
    sqlite.exec("UPDATE sessions SET cleared_at = 200 WHERE id = 's1'");
    expect(await latestMessage('s1', 'assistant')).toEqual({ text: '', createdAt: null });
  });
});
