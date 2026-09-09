import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildSnippetFromContent, cjkSeg, SNIPPET_SOURCE_MAX_CHARS } from '../cjkSeg';
import { registerCjkSeg } from '../registerCjkSeg';
import { buildMessagesFtsMatch, extractMessagesFtsTokens } from '../chatHistorySearch.pure';

const CORPUS = [
  '登录报错了',
  '边界',
  'login bug',
  '修复 login 问题',
  'foo登录bar',
  'ひらがなカタカナ한글',
  '登录，报错',
  '边，界',
  'ＡＢＣ',
  '',
  '探针',
  '甲́乙',
] as const;

describe('cjkSeg', () => {
  it('只在连续汉字中间插空格', () => {
    expect(cjkSeg('登录报错了')).toBe('登 录 报 错 了');
    expect(cjkSeg('边界')).toBe('边 界');
    expect(cjkSeg('login bug')).toBe('login bug');
    expect(cjkSeg('修复 login 问题')).toBe('修 复 login 问 题');
    expect(cjkSeg('foo登录bar')).toBe('foo 登 录 bar');
    expect(cjkSeg('login报错')).toBe('login 报 错');
    expect(cjkSeg('甲́乙')).toBe('甲́ 乙');
  });

  it('不处理假名、谚文、全角标点', () => {
    expect(cjkSeg('ひらがな')).toBe('ひらがな');
    expect(cjkSeg('カタカナ')).toBe('カタカナ');
    expect(cjkSeg('한글')).toBe('한글');
    expect(cjkSeg('登录，报错')).toBe('登 录，报 错');
    expect(cjkSeg('ＡＢＣ')).toBe('ＡＢＣ');
  });

  it('空串与 null 保持原样', () => {
    expect(cjkSeg('')).toBe('');
    expect(cjkSeg(null)).toBeNull();
    expect(cjkSeg(undefined)).toBeNull();
  });
});

describe('buildSnippetFromContent', () => {
  it('插入空格不出现在 snippet，原文空格原样保留（P1 回归）', () => {
    // 中英相邻：不得多出假空格。
    expect(buildSnippetFromContent('foo登录bar', ['foo登录bar'])).toBe('<mark>foo登录bar</mark>');
    // 原文真实空格：不得被吞。
    expect(buildSnippetFromContent('登录 报错', ['登录'])).toBe('<mark>登录</mark> 报错');
    // 多命中区间分开高亮；英文 token 独立命中。
    expect(buildSnippetFromContent('foo登录bar后 login 失败', ['foo登录bar', 'login'])).toBe(
      '<mark>foo登录bar</mark>后 <mark>login</mark> 失败',
    );
    expect(buildSnippetFromContent('纯英文 hello world', ['hello'])).toBe(
      '纯英文 <mark>hello</mark> world',
    );
    // 星光面字符在命中位置之前：必须按码点下标定位，不能用 UTF-16 indexOf。
    expect(buildSnippetFromContent('😀登录报错', ['登录'])).toBe('😀<mark>登录</mark>报错');
    expect(buildSnippetFromContent('😀😀甲乙', ['甲乙'])).toBe('😀😀<mark>甲乙</mark>');
    // 英文大小写折叠：召回不区分大小写，高亮也应跟上。
    expect(buildSnippetFromContent('please login now', ['Login'])).toBe(
      'please <mark>login</mark> now',
    );
    // 原文里的真 <mark> 必须转义，不能被消费端当成控制标记。
    expect(buildSnippetFromContent('see <mark>here</mark> 登录', ['登录'])).toBe(
      'see &lt;mark&gt;here&lt;/mark&gt; <mark>登录</mark>',
    );
    expect(buildSnippetFromContent('a & b < c', ['a'])).toBe(
      '<mark>a</mark> &amp; b &lt; c',
    );
    // 窗边缘空格是原文的一部分，不能在生成端丢掉。
    expect(buildSnippetFromContent('  登录  ', ['登录'])).toBe(
      '  <mark>登录</mark>  ',
    );
  });

  it('跨很长间距的两处命中只保留一段窗口，不返回整条消息', () => {
    const long = `needle${'占'.repeat(400)}needle`;
    const snippet = buildSnippetFromContent(long, ['needle']);
    expect(snippet.length).toBeLessThan(200);
    expect(snippet).toContain('<mark>needle</mark>');
    expect(snippet.startsWith('<mark>needle</mark>') || snippet.endsWith('<mark>needle</mark>')).toBe(true);
  });

  it('长文本截窗 + 省略号；空内容与未命中退化为纯文本恒返回 string', () => {
    const long = `前缀${'占'.repeat(40)}登录报错${'尾'.repeat(40)}`;
    const snippet = buildSnippetFromContent(long, ['登录']);
    expect(snippet).toContain('<mark>登录</mark>');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(buildSnippetFromContent('', [])).toBe('');
    expect(buildSnippetFromContent(null, ['任意'])).toBe('');
    // 未命中不打高亮、不截出假空格。
    expect(buildSnippetFromContent('很长的原文内容'.repeat(10), ['不存在词'])).not.toContain('<mark>');
    expect(buildSnippetFromContent('短文本', ['任意'])).toBe('短文本');
  });

  it('超长原文只扫前缀，尾部命中退回文首 fallback', () => {
    const long = `${'前'.repeat(SNIPPET_SOURCE_MAX_CHARS)}登录`;
    const snippet = buildSnippetFromContent(long, ['登录']);
    expect(snippet).not.toContain('<mark>');
    expect(snippet.startsWith('前')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('真实 FTS 链路：snippet 不篡改中英相邻与原文真实空格', () => {
    const db = new Database(':memory:');
    registerCjkSeg(db);
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content,
        tokenize='porter unicode61'
      );
    `);
    try {
      const add = (id: string, content: string) => {
        db.prepare(
          'INSERT INTO messages_fts(message_id, session_id, role, content) VALUES (?,?,?,?)',
        ).run(id, 's', 'user', cjkSeg(content));
      };
      add('m1', 'foo登录bar');
      add('m2', '登录 报错了');

      for (const [query, id, orig, expectSnippet] of [
        ['foo登录bar', 'm1', 'foo登录bar', '<mark>foo登录bar</mark>'],
        // 「登录 报错」拆成两个 token，命中区间各自高亮。
        ['登录 报错', 'm2', '登录 报错了', '<mark>登录</mark> <mark>报错</mark>了'],
        // 单 token 整段命中：mark 覆盖整个相邻 run（含其中的原文空格）。
        ['登录报错了', 'm2', '登录 报错了', '<mark>登录 报错了</mark>'],
      ] as const) {
        // 真 MATCH 命中该行 —— 证明 snippet 用的正是召回链路的同一份 token 口径。
        const hit = db
          .prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?')
          .all(buildMessagesFtsMatch(query))
          .map((r) => String((r as { message_id: string }).message_id));
        expect(hit).toContain(id);
        expect(buildSnippetFromContent(orig, extractMessagesFtsTokens(query))).toBe(expectSnippet);
      }
    } finally {
      db.close();
    }
  });
});

describe('cjkSeg 跨副本一致性', () => {
  it('0099 companion 内嵌快照与正本输出一致', async () => {
    const { default: migration } = (await import(
      '../../../../drizzle/scripts/0100_segment_messages_fts_cjk'
    )) as { default: { run: (db: Database.Database) => void } };
    const db = new Database(':memory:');
    try {
      migration.run(db);
      const sqlSeg = db.prepare('SELECT cjk_seg(?) AS v');
      for (const sample of CORPUS) {
        expect((sqlSeg.get(sample) as { v: string | null }).v).toBe(cjkSeg(sample));
      }
      expect((sqlSeg.get(null) as { v: string | null }).v).toBe(cjkSeg(null));
    } finally {
      db.close();
    }
  });

  it('inline worker 内嵌副本与正本输出一致', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../client/WorkerThreadTransport.ts'),
      'utf8',
    );
    const start = source.indexOf('function registerCjkSeg(nextDb) {');
    const end = source.indexOf('\nfunction hashMigrationFile', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const restored = source.slice(start, end).replaceAll(String.raw`\\p`, String.raw`\p`);
    const { register, ensure } = new Function(
      `"use strict"; ${restored}; return { register: registerCjkSeg, ensure: ensureCjkFtsTempTriggersInstalled };`,
    )() as {
      register: (db: Database.Database) => void;
      ensure: (db: Database.Database) => void;
    };
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          rewind_at INTEGER
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content,
          tokenize='porter unicode61'
        );
        CREATE TABLE messages_fts_rows (
          fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          message_id TEXT NOT NULL
        );
        CREATE UNIQUE INDEX messages_fts_rows_message_id_idx ON messages_fts_rows(message_id);
      `);
      register(db);
      const sqlSeg = db.prepare('SELECT cjk_seg(?) AS v');
      for (const sample of CORPUS) {
        expect((sqlSeg.get(sample) as { v: string | null }).v).toBe(cjkSeg(sample));
      }
      expect((sqlSeg.get(null) as { v: string | null }).v).toBe(cjkSeg(null));
      const installed = db.prepare(
        "SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger' AND name IN ('messages_fts_insert_cjk','messages_fts_update_cjk')",
      ).get() as { n: number };
      expect(installed.n).toBe(2);
      db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_insert_cjk');
      db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_update_cjk');
      ensure(db);
      ensure(db);
      expect(
        (db.prepare(
          "SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger' AND name IN ('messages_fts_insert_cjk','messages_fts_update_cjk')",
        ).get() as { n: number }).n,
      ).toBe(2);
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 's', 'user', '登录报错了')",
      ).run();
      expect(
        (db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('m1') as { content: string }).content,
      ).toBe('登 录 报 错 了');
    } finally {
      db.close();
    }
  });
});
