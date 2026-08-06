/**
 * MemoryFts 单测 — 用真 better-sqlite3 内存库。
 *
 * 重点覆盖 #1537: unicode61 tokenizer 把连续 CJK 文本当一个 token,
 * phrase MATCH 无法命中中文子串, 必须由 LIKE 兜底捞回 (模式对齐 contacts/fts.ts)。
 * 另覆盖 buildFilename 对带 type 前缀 slug 的拒绝 (#1652 附带小 bug)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { MemoryFts } from '../fts.js';
import { buildFilename } from '../storage.js';
import type { MemoryRecord } from '../types.js';

function record(filename: string, body: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  // 按 MemoryRecord 契约: slug 是去掉 <type>_ 前缀与 .md 后缀的部分 (types.ts)
  const slug = filename.replace(/\.md$/, '').replace(/^(user|feedback|project|reference|digest)_/, '');
  const type = (filename.match(/^(user|feedback|project|reference|digest)_/) ?? ['digest'])[0].replace(/_$/, '') as MemoryRecord['frontmatter']['type'];
  return {
    filename,
    slug,
    frontmatter: {
      type,
      title: `标题 ${filename}`,
      description: `描述 ${filename}`,
      updatedAt: '2026-08-06T00:00:00.000Z',
    },
    body,
    sizeBytes: body.length,
    ...overrides,
  };
}

describe('MemoryFts', () => {
  let db: Database.Database;
  let fts: MemoryFts;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    fts = new MemoryFts(db);
    fts.init();
  });

  afterEach(() => {
    db.close();
  });

  it('中文子串查询命中 (LIKE 兜底, #1537 主场景)', () => {
    fts.upsert(record('project_a.md', 'MaxCompute 数据分析链路性能优化'));
    fts.upsert(record('project_b.md', '边界索引配置说明'));

    // 复现 issue: 无通配符的精确中文查询
    const hits = fts.search('边界');
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_b.md');
  });

  it('英文精确查询仍走 MATCH 优先 (score = bm25 非 0)', () => {
    fts.upsert(record('project_a.md', 'MaxCompute link 优化'));

    const hits = fts.search('MaxCompute');
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_a.md');
    expect(hits[0].score).not.toBe(Number.MAX_SAFE_INTEGER); // 走 MATCH 路径才带 bm25
  });

  it('MATCH 命中不足时合并 LIKE 兜底并按 filename 去重', () => {
    // A: MATCH('link') 与 LIKE('%link%') 双命中
    fts.upsert(record('project_a.md', '数据链路分析与 link 优化'));
    // B: token 是 LinkedIn, MATCH('link') 不命中, 但 LIKE 大小写不敏感可命中
    fts.upsert(record('project_b.md', 'LinkedIn 社交平台分析'));
    // C: 双不命中
    fts.upsert(record('project_c.md', 'MaxCompute 边界索引'));

    const hits = fts.search('link');
    const filenames = hits.map((h) => h.filename).sort();
    expect(filenames).toEqual(['project_a.md', 'project_b.md']);
    // 去重: A 只出现一次
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it('type filter 对 MATCH 与 LIKE 兜底都生效', () => {
    fts.upsert(record('project_a.md', '边界索引配置说明'));
    fts.upsert(record('feedback_b.md', '边界相关反馈'));

    const all = fts.search('边界');
    expect(all.length).toBe(2);

    const filtered = fts.search('边界', { type: 'feedback' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].filename).toBe('feedback_b.md');
  });

  it('空查询返回空', () => {
    fts.upsert(record('project_a.md', '内容'));
    expect(fts.search('')).toEqual([]);
    expect(fts.search('   ')).toEqual([]);
  });

  it('特殊字符查询不抛 (语法错被吞, 由 LIKE 兜底接管)', () => {
    fts.upsert(record('project_a.md', '括号 (nested) 与引号 "quote" 内容'));
    const hits = fts.search('"quote" 括号');
    // 不抛异常即可; 能命中引号词更好
    expect(Array.isArray(hits)).toBe(true);
  });

  it('limit 生效', () => {
    for (let i = 0; i < 20; i++) {
      fts.upsert(record(`project_${String(i).padStart(2, '0')}.md`, `共同词 内容 ${i}`));
    }
    expect(fts.search('共同词', { limit: 3 }).length).toBe(3);
    expect(fts.search('共同词', { limit: 100 }).length).toBe(20); // 上限 50 不越界即可
  });

  it('MATCH 命中满 limit 时为 LIKE-only 子串命中预留 1 个名额', () => {
    const spy = vi.spyOn(fts as unknown as { searchLike: (q: string, o: unknown, n: number) => unknown }, 'searchLike');
    try {
      // 7 条整 token 命中 (>= limit 3, 满额; 且 7 > limit*2=6, LIKE 全扫也排在前面) +
      // 1 条 LIKE-only (LinkedIn, MATCH 不中) 在物理顺序最后 — 若 SQL 先 LIMIT 会被截掉
      for (let i = 0; i < 7; i++) {
        fts.upsert(record(`project_${String(i).padStart(2, '0')}.md`, `link 内容 ${i}`));
      }
      fts.upsert(record('project_linkedin.md', 'LinkedIn 社交平台'));
      const hits = fts.search('link', { limit: 3 });
      expect(spy).toHaveBeenCalled(); // 子串检索仍执行
      expect(hits.length).toBe(3);
      // 预留名额生效: 唯一的 LIKE-only 命中必须可见
      expect(hits.some((h) => h.filename === 'project_linkedin.md')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('limit=1 且 MATCH 满额时不预留 (保住唯一最佳 MATCH)', () => {
    fts.upsert(record('project_a.md', 'link 内容'));
    fts.upsert(record('project_linkedin.md', 'LinkedIn 社交平台'));
    const hits = fts.search('link', { limit: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_a.md'); // MATCH 优先, 不被 LIKE 挤掉
  });

  it('upsert 按 filename 去重, delete/count/rebuild 基本行为', () => {
    fts.upsert(record('project_a.md', 'v1 边界'));
    fts.upsert(record('project_a.md', 'v2 索引'));
    expect(fts.count()).toBe(1);

    fts.delete('project_a.md');
    expect(fts.count()).toBe(0);

    fts.upsert(record('project_b.md', '边界内容'));
    fts.rebuild([record('project_b.md', '边界内容'), record('project_c.md', 'MaxCompute 链路')]);
    expect(fts.count()).toBe(2);
    expect(fts.search('MaxCompute').length).toBe(1);
  });
});

describe('buildFilename · 拒绝 type 前缀 slug (#1652 附带小 bug)', () => {
  it('slug 已带同 type 前缀时拒绝 (而非剥离), 避免存量分片定位错位', () => {
    // 存量 feedback_feedback_foo.md 被 parseFilename 解析为 slug 'feedback_foo',
    // 若剥离成 'foo' 会定位到不存在的 feedback_foo.md (not-found 或静默改错分片)
    expect(() => buildFilename('feedback', 'feedback_foo')).toThrow(/invalid-slug/);
    expect(() => buildFilename('project', 'project_pricing')).toThrow(/invalid-slug/);
  });

  it('不带前缀的纯 slug 原样拼装', () => {
    expect(buildFilename('feedback', 'foo')).toBe('feedback_foo.md');
  });

  it('slug 恰好等于 type 名时报 invalid-slug', () => {
    expect(() => buildFilename('feedback', 'feedback')).toThrow(/invalid-slug/);
  });

  it('只带前缀没有实体的 slug 报 invalid-slug', () => {
    expect(() => buildFilename('feedback', 'feedback_')).toThrow(/invalid-slug/);
  });
});
