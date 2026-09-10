/**
 * moment 记忆类型 (#4124) — bot-only 情节记忆的存储契约:
 *  - moment 是合法存储类型, 但不进 CURATED_MEMORY_TYPES (全局索引 / system prompt 不感知);
 *  - 仅 bot scope store 允许写入 (store 级 invalid-type 门禁, MCP 层映射为 INVALID_PARAMS);
 *  - bot scope 的 MEMORY.md 渲染 moment 分区 (最近 N 条 + 检索提示), 全局 scope 永不渲染;
 *  - frontmatter 可选 occurredAt / significance / sourceSession: 确定性校验, update 保留旧值;
 *  - 旧分片 (无新字段) 仍可读、可更新、可 consolidate, 无需迁移。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adaptMemoryIndexForHarness,
  MEMORY_INDEX_SEARCH_HINT_MCP,
  MEMORY_INDEX_SEARCH_HINT_PI,
  MemoryStorage,
} from '../storage.js';
import { MakerMemoryStore } from '../store.js';
import {
  BOT_ONLY_MEMORY_TYPES,
  CURATED_MEMORY_TYPES,
  DEFAULT_MEMORY_CONFIG,
  MEMORY_TYPES,
} from '../types.js';
import type { MemoryConfig } from '../types.js';
import type { Logger } from '../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'memory-moment-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function createStore(botScope: boolean, config?: Partial<MemoryConfig>) {
  const db = new DatabaseCtor(':memory:');
  const store = new MakerMemoryStore({
    storageDir: path.join(root, botScope ? 'bot-store' : 'workdir-store'),
    absWorkdir: botScope ? 'bot:release-helper' : path.join(path.sep, 'repo', 'cindy'),
    db,
    logger: noopLogger,
    botScope,
    ...(config ? { config: { ...DEFAULT_MEMORY_CONFIG, ...config } } : {}),
  });
  return { store, db };
}

function momentArgs(name: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'moment' as const,
    name,
    title: '时刻 ' + name,
    description: '一条时刻记录',
    body: '用户的重要想法/重大时刻内容。',
    ...overrides,
  };
}

describe('moment 类型分类', () => {
  it('是合法存储类型, 但不是 curated 类型, 且在 bot-only 集合里', () => {
    expect(MEMORY_TYPES).toContain('moment');
    expect(CURATED_MEMORY_TYPES).not.toContain('moment');
    expect(BOT_ONLY_MEMORY_TYPES).toContain('moment');
  });
});

describe('bot scope 的 moment 写入', () => {
  it('写入成功, frontmatter 保留 occurredAt / significance / sourceSession', async () => {
    const { store, db } = createStore(true);
    try {
      const result = await store.write(momentArgs('first-deep-dive', {
        occurredAt: '2026-09-08',
        significance: 'high',
        sourceSession: 'session-abc',
      }));
      expect(result.ok).toBe(true);
      expect(result.filename).toBe('moment_first-deep-dive.md');

      const record = await store.read('moment_first-deep-dive.md');
      expect(record.frontmatter.type).toBe('moment');
      expect(record.frontmatter.occurredAt).toBe('2026-09-08');
      expect(record.frontmatter.significance).toBe('high');
      expect(record.frontmatter.sourceSession).toBe('session-abc');
    } finally {
      db.close();
    }
  });

  it('create 缺省 occurredAt = 写入时刻; update 缺省保留旧值', async () => {
    const { store, db } = createStore(true);
    try {
      await store.write(momentArgs('milestone', { occurredAt: '2026-09-01', significance: 'high' }));
      const updated = await store.write(momentArgs('milestone', {
        body: '更新后的内容。',
        mode: 'update',
      }));
      expect(updated.ok).toBe(true);
      const record = await store.read('moment_milestone.md');
      expect(record.frontmatter.occurredAt).toBe('2026-09-01');
      expect(record.frontmatter.significance).toBe('high');
      expect(record.body).toContain('更新后的内容。');
    } finally {
      db.close();
    }
  });

  it('索引渲染 moment 分区: 按 occurredAt 降序, 含日期标注', async () => {
    const { store, db } = createStore(true);
    try {
      await store.write(momentArgs('older', { occurredAt: '2026-08-01' }));
      await store.write(momentArgs('newer', { occurredAt: '2026-09-08' }));
      const index = await store.getIndex();
      expect(index).toContain('## moment');
      const olderPos = index.indexOf('moment_older.md');
      const newerPos = index.indexOf('moment_newer.md');
      expect(newerPos).toBeGreaterThan(-1);
      expect(olderPos).toBeGreaterThan(-1);
      expect(newerPos).toBeLessThan(olderPos);
      expect(index).toContain('2026-09-08');
    } finally {
      db.close();
    }
  });

  it('moment 分区有条数上限, 超出时提示用记忆检索更早内容', async () => {
    const { store, db } = createStore(true, { maxMomentIndexEntries: 2 });
    try {
      for (const [name, date] of [
        ['m1', '2026-06-01'],
        ['m2', '2026-07-01'],
        ['m3', '2026-08-01'],
      ] as const) {
        await store.write(momentArgs(name, { occurredAt: date }));
      }
      const index = await store.getIndex();
      expect(index).toContain('moment_m3.md');
      expect(index).toContain('moment_m2.md');
      expect(index).not.toContain('moment_m1.md');
      expect(index).toContain(MEMORY_INDEX_SEARCH_HINT_MCP);
      expect(index).not.toContain(MEMORY_INDEX_SEARCH_HINT_PI);
      expect(adaptMemoryIndexForHarness(index, 'pi')).toContain(MEMORY_INDEX_SEARCH_HINT_PI);
      expect(adaptMemoryIndexForHarness(index, 'pi')).not.toContain(MEMORY_INDEX_SEARCH_HINT_MCP);
      expect(adaptMemoryIndexForHarness(index, 'claude')).toContain(MEMORY_INDEX_SEARCH_HINT_MCP);
    } finally {
      db.close();
    }
  });

  it('bot scope 可将三条 moment 合并成一条 moment, 保留 frontmatter 并删除旧分片', async () => {
    const { store, db } = createStore(true);
    const sourceNames = ['old-a', 'old-b', 'old-c'];
    try {
      for (const [name, date] of sourceNames.map((name, index) => [name, `2026-09-0${index + 1}`] as const)) {
        await store.write(momentArgs(name, { occurredAt: date }));
      }

      const result = await store.consolidate({
        sources: sourceNames.map((name) => `moment_${name}.md`),
        target: momentArgs('chapter', {
          title: '合并后的时刻章节',
          description: '三条旧时刻的归纳',
          body: '三条旧时刻已合并为一条章节记忆。',
          occurredAt: '2026-09-08',
          significance: 'high',
          sourceSession: 'session-consolidate',
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.filename).toBe('moment_chapter.md');
      expect(result.deletedSources).toEqual(
        expect.arrayContaining(sourceNames.map((name) => `moment_${name}.md`)),
      );

      const record = await store.read('moment_chapter.md');
      expect(record.frontmatter.type).toBe('moment');
      expect(record.frontmatter.occurredAt).toBe('2026-09-08');
      expect(record.frontmatter.significance).toBe('high');
      expect(record.frontmatter.sourceSession).toBe('session-consolidate');
      for (const name of sourceNames) {
        await expect(store.read(`moment_${name}.md`)).rejects.toMatchObject({ code: 'not-found' });
      }
      expect((await store.list()).map((entry) => entry.filename)).toEqual(['moment_chapter.md']);
    } finally {
      db.close();
    }
  });

  it('校验拒绝非法 occurredAt / significance / sourceSession', async () => {
    const { store, db } = createStore(true);
    try {
      await expect(store.write(momentArgs('bad-date', { occurredAt: 'not-a-date' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
      await expect(store.write(momentArgs('feb-30', { occurredAt: '2026-02-30' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
      await expect(store.write(momentArgs('feb-29-nonleap', { occurredAt: '2026-02-29' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
      await expect(store.write(momentArgs('sep-31', { occurredAt: '2026-09-31' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
      const leap = await store.write(momentArgs('leap-day', { occurredAt: '2024-02-29' }));
      expect(leap.ok).toBe(true);
      await expect(store.write(momentArgs('bad-sig', { significance: 'mega' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
      await expect(store.write(momentArgs('bad-session', { sourceSession: 'a\nb' })))
        .rejects.toMatchObject({ code: 'invalid-frontmatter' });
    } finally {
      db.close();
    }
  });
});

describe('非 bot scope 的 moment 拒绝', () => {
  it('write 被确定性拒绝 (invalid-type), 分片不落盘', async () => {
    const { store, db } = createStore(false);
    try {
      await expect(store.write(momentArgs('rejected')))
        .rejects.toMatchObject({ code: 'invalid-type' });
      expect(await store.list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('consolidate 的 target 为 moment 同样被拒绝', async () => {
    const { store, db } = createStore(false);
    try {
      await store.write({ type: 'project', name: 'src', title: '源', description: '源分片', body: '内容' });
      await expect(store.consolidate({
        sources: ['project_src.md'],
        target: momentArgs('promoted'),
      })).rejects.toMatchObject({ code: 'invalid-type' });
    } finally {
      db.close();
    }
  });

  it('全局 scope 的 MEMORY.md 永不渲染 moment 分区 (即使分片被手工放入)', async () => {
    const dir = path.join(root, 'workdir-store');
    const storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG, undefined);
    await storage.init(path.sep + 'repo');
    await writeFile(
      path.join(dir, 'moment_manual.md'),
      '---\ntitle: 手工时刻\ndescription: 手工放入的时刻\ntype: moment\nupdatedAt: 2026-09-08T00:00:00.000Z\n---\n\n内容\n',
      'utf8',
    );
    await storage.rebuildIndex();
    const index = await storage.getIndex();
    expect(index).not.toContain('## moment');
    expect(index).not.toContain('moment_manual.md');
    // list()/FTS 侧仍可见 (分片本身合法), 但不进全局索引。
    expect((await storage.list()).map((r) => r.filename)).toEqual(['moment_manual.md']);
  });
});
