/**
 * Maker Memory 整理 (docs/product-rules/cindy-memory.md §3)。
 *
 * 保护的契约:
 *  - 自动整理只在触发线到了才调用模型 (改动满 10 条, 或索引近上限且有改动; 24 小时内不重试);
 *  - 模型只提议: 不合格的提议整项丢弃, 落盘按快照版本核对, 整理期间被改过的条目不覆盖;
 *  - 每次整理可撤销, 撤销不覆盖之后又被改过的条目;
 *  - 伙伴等独立作用域不参与。
 *
 * 新文件而不并入 manager.scope.test.ts: 那个文件的主题是账号边界守卫, 这里是另一个
 * 模块 (tidy.ts) 加它在 manager 上的入口; 用真 better-sqlite3 走生产的 store。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import { buildBotMemoryScopeKey } from './storage.js';
import { EMPTY_TIDY_STATE, isTidyDue, parseTidyPlan, validateTidyPlan, type TidyPlan } from './tidy.js';
import { DEFAULT_MEMORY_CONFIG, type MemoryRecord, type MemoryType } from './types.js';
import type { Logger } from '../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

vi.setConfig({ testTimeout: process.platform === 'win32' ? 30_000 : 5_000 });

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function record(filename: string, updatedAt: string, type: MemoryType = 'feedback'): MemoryRecord {
  return {
    filename,
    slug: filename.replace(/^[a-z]+_/, '').replace(/\.md$/, ''),
    frontmatter: { title: filename, description: 'd', type, updatedAt },
    body: 'body',
    sizeBytes: 10,
  };
}
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('isTidyDue', () => {
  const tidiedYesterday = { ...EMPTY_TIDY_STATE, lastTidyAt: iso(-2 * DAY), lastAttemptAt: iso(-2 * DAY) };
  const changed = (n: number) => Array.from({ length: n }, (_, i) => record(`feedback_new${i}.md`, iso(-DAY)));
  const old = (n: number) => Array.from({ length: n }, (_, i) => record(`feedback_old${i}.md`, iso(-9 * DAY)));
  const hard = DEFAULT_MEMORY_CONFIG.hardIndexBytes;

  it.each([
    ['改动满 10 条', [...changed(10)], tidiedYesterday, 100, true],
    ['改动不足且索引不大', [...changed(3), ...old(3)], tidiedYesterday, 100, false],
    ['索引近上限且有改动', [...changed(1), ...old(3)], tidiedYesterday, hard * 0.8, true],
    ['索引近上限但整理后没有改动 (不每天白跑)', old(4), tidiedYesterday, hard, false],
    ['24 小时内尝试过 (含失败) 不重试', changed(12), { ...tidiedYesterday, lastAttemptAt: iso(-DAY / 2) }, hard, false],
    ['不足两条没有可合并的对象', changed(1), EMPTY_TIDY_STATE, hard, false],
  ] as const)('%s', (_name, records, state, indexBytes, expected) => {
    expect(isTidyDue({ records, state, indexBytes, config: DEFAULT_MEMORY_CONFIG, now: NOW })).toBe(expected);
  });
});

describe('validateTidyPlan', () => {
  const records = [
    record('feedback_a.md', iso(-3 * DAY)),
    record('feedback_b.md', iso(-2 * DAY)),
    record('feedback_c.md', iso(-DAY)),
    record('project_p.md', iso(-DAY), 'project'),
  ];
  const merge = (sources: string[], over: Partial<TidyPlan['merges'][number]> = {}) => ({
    sources, title: 't', description: 'one line', body: 'merged', reason: 'same', ...over,
  });

  it('只留能安全执行的提议, 其余整项丢弃', () => {
    const plan: TidyPlan = {
      merges: [
        merge(['feedback_a.md', 'feedback_b.md']),
        merge(['feedback_b.md', 'feedback_c.md']), // b 已被上一项用掉
        merge(['feedback_c.md', 'project_p.md']), // 不同类
        merge(['feedback_c.md', 'feedback_missing.md']), // 快照里没有
        merge(['feedback_c.md', 'project_p.md'], { description: 'two\nlines' }),
      ],
      deletes: [
        { filename: 'feedback_c.md', supersededBy: 'feedback_a.md', reason: 'covered' },
        { filename: 'project_p.md', supersededBy: 'feedback_c.md', reason: '覆盖它的那条本轮也被删' },
        { filename: 'feedback_a.md', supersededBy: 'feedback_c.md', reason: '已在合并里' },
      ],
    };
    const valid = validateTidyPlan(plan, records, DEFAULT_MEMORY_CONFIG);
    expect(valid.merges.map((m) => m.sources)).toEqual([['feedback_a.md', 'feedback_b.md']]);
    expect(valid.deletes.map((d) => d.filename)).toEqual(['feedback_c.md']);
  });

  it('模型输出不是计划时返回 null (不猜)', () => {
    expect(parseTidyPlan('Sure! Here is my plan: nothing to do.')).toBeNull();
    expect(parseTidyPlan('```json\n{"merges":[],"deletes":[]}\n```')).toEqual({ merges: [], deletes: [] });
  });
});

describe('MakerMemoryManager.tidy', () => {
  let root: string;
  const WORKDIR = path.join(path.sep, 'tidy', 'project');
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'memory-tidy-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function managerWith(reply: (prompt: string) => string | null | Promise<string | null>) {
    const reviewOneShot = vi.fn(async (prompt: string) => reply(prompt));
    const manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory: (file) => new DatabaseCtor(file),
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
      isIndependentScope: (key) => key.startsWith('bot:'),
      reviewOneShot,
    });
    return { manager, reviewOneShot };
  }
  const write = (manager: MakerMemoryManager, name: string, body: string) =>
    manager.write(WORKDIR, { type: 'feedback', name, title: name, description: `${name} hook`, body });
  const mergePlan = JSON.stringify({
    merges: [{ sources: ['feedback_zh.md', 'feedback_zh2.md'], title: '中文回复', description: '始终用中文回复', body: '始终用中文回复。', reason: '同一件事' }],
    deletes: [],
  });

  it('自动整理没到触发线不调用模型; 手动整理合并重复并可撤销', async () => {
    const { manager, reviewOneShot } = managerWith(() => mergePlan);
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');
    await write(manager, 'other', '称用户不称主人');

    expect(await manager.tidy(WORKDIR, 'auto')).toEqual({ status: 'not-due' });
    expect(reviewOneShot).not.toHaveBeenCalled();

    const outcome = await manager.tidy(WORKDIR, 'manual');
    expect(outcome.status).toBe('done');
    const store = await manager.getStore(WORKDIR);
    const after = await store.list();
    expect(after.map((r) => r.filename).sort()).toEqual(['feedback_other.md', 'feedback_zh2.md']);
    expect(after.find((r) => r.filename === 'feedback_zh2.md')?.body).toBe('始终用中文回复。');

    const [run] = await manager.listTidyRuns(WORKDIR);
    expect(run?.changes.map((c) => `${c.kind}:${c.filename}`)).toEqual([
      'updated:feedback_zh2.md',
      'deleted:feedback_zh.md',
    ]);
    expect(await manager.undoTidy(WORKDIR, run!.id)).toEqual({ restored: 2, skipped: 0 });
    const restored = await store.list();
    expect(restored.find((r) => r.filename === 'feedback_zh.md')?.body).toBe('回复一律用中文');
    expect(restored.find((r) => r.filename === 'feedback_zh2.md')?.body).toBe('始终用中文回复');
    manager.dispose();
  });

  it('模型思考期间被改过的条目不覆盖, 整项跳过', async () => {
    let manager!: MakerMemoryManager;
    ({ manager } = managerWith(async () => {
      // 整理读完快照之后、落盘之前, 任务又改了其中一条。
      await manager.write(WORKDIR, {
        type: 'feedback', name: 'zh2', title: 'zh2', description: 'zh2 hook', body: '改成用英文回复', mode: 'update',
      });
      return mergePlan;
    }));
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');

    expect(await manager.tidy(WORKDIR, 'manual')).toEqual({ status: 'done', run: null });
    const after = await (await manager.getStore(WORKDIR)).list();
    expect(after.map((r) => r.body).sort()).toEqual(['回复一律用中文', '改成用英文回复'].sort());
    manager.dispose();
  });

  it('模型没有给出计划: 记忆不动, 并记下这次尝试以免逐轮重试', async () => {
    const { manager, reviewOneShot } = managerWith(() => 'I could not decide.');
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');

    expect(await manager.tidy(WORKDIR, 'manual')).toEqual({ status: 'failed' });
    expect((await (await manager.getStore(WORKDIR)).list()).length).toBe(2);
    expect((await (await manager.getStore(WORKDIR)).readTidyState()).lastAttemptAt).not.toBeNull();
    expect(reviewOneShot).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('辅助模型没有任何产出: 报「不可用」而不是「失败」, 界面据此指向模型设置', async () => {
    const { manager } = managerWith(() => null);
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');

    expect(await manager.tidy(WORKDIR, 'manual')).toEqual({ status: 'unavailable' });
    expect((await (await manager.getStore(WORKDIR)).list()).length).toBe(2);
    manager.dispose();
  });

  it('伙伴的记忆不参与整理', async () => {
    const { manager, reviewOneShot } = managerWith(() => mergePlan);
    expect(await manager.tidy(buildBotMemoryScopeKey('bot-1'), 'manual')).toEqual({ status: 'unavailable' });
    expect(await manager.tidyIfDue(buildBotMemoryScopeKey('bot-1'))).toEqual([]);
    expect(reviewOneShot).not.toHaveBeenCalled();
    manager.dispose();
  });
});
