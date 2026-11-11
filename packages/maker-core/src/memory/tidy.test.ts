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

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import { buildBotMemoryScopeKey, memoryScopeDirName, MemoryStorage } from './storage.js';
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

  function managerWith(
    reply: (prompt: string) => string | null | Promise<string | null>,
    config?: { hardIndexBytes: number },
    ownerScopeKey?: () => string,
  ) {
    const reviewOneShot = vi.fn(async (prompt: string) => reply(prompt));
    const manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory: (file) => new DatabaseCtor(file),
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
      isIndependentScope: (key) => key.startsWith('bot:'),
      reviewOneShot,
      ...(config ? { config } : {}),
      ...(ownerScopeKey ? { ownerScopeKey } : {}),
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

  // 评审 (Codex P1 / Greptile P1): 提议是按快照做的, 落盘时参与判断的每一条记忆都得核对, 否则会按旧内容误删。
  it('合并的来源在模型思考期间被改过: 整项不动, 保留的那条也不被改写', async () => {
    let manager!: MakerMemoryManager;
    ({ manager } = managerWith(async () => {
      await manager.write(WORKDIR, {
        type: 'feedback', name: 'zh', title: 'zh', description: 'zh hook', body: '这条刚被改过', mode: 'update',
      });
      return mergePlan;
    }));
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');

    expect(await manager.tidy(WORKDIR, 'manual')).toEqual({ status: 'done', run: null });
    const bodies = Object.fromEntries((await (await manager.getStore(WORKDIR)).list()).map((r) => [r.filename, r.body]));
    expect(bodies).toEqual({ 'feedback_zh.md': '这条刚被改过', 'feedback_zh2.md': '始终用中文回复' });
    manager.dispose();
  });

  it('覆盖方在模型思考期间被删: 不删被它覆盖的那条, 否则这件事不再有任何副本', async () => {
    let manager!: MakerMemoryManager;
    ({ manager } = managerWith(async () => {
      await (await manager.getStore(WORKDIR)).delete('feedback_zh2.md');
      return JSON.stringify({
        merges: [],
        deletes: [{ filename: 'feedback_zh.md', supersededBy: 'feedback_zh2.md', reason: '被覆盖' }],
      });
    }));
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');

    expect(await manager.tidy(WORKDIR, 'manual')).toEqual({ status: 'done', run: null });
    expect((await (await manager.getStore(WORKDIR)).list()).map((r) => r.filename)).toEqual(['feedback_zh.md']);
    manager.dispose();
  });

  // 评审 (Codex P2 / Greptile P1): 满额的记忆正是最需要整理的, 预算要按合并后的结果算。
  it('索引已到硬上限时整理仍能合并 (中间态会超限、结果更小), 并可撤销', async () => {
    const plan = JSON.stringify({
      merges: [{
        sources: ['feedback_zh.md', 'feedback_zh2.md'],
        title: '始终用中文回复(含总结)', description: '用户要求全程使用中文交流和回复，包括总结', body: '始终用中文回复。', reason: '同一件事',
      }],
      deletes: [],
    });
    const seed = managerWith(() => plan);
    await seed.manager.write(WORKDIR, { type: 'feedback', name: 'zh', title: '回复一律用中文', description: '用户要求所有回复一律使用中文', body: '回复一律用中文' });
    await seed.manager.write(WORKDIR, { type: 'feedback', name: 'zh2', title: '始终用中文回复', description: '用户要求全程使用中文交流', body: '始终用中文回复' });
    const full = await (await seed.manager.getStore(WORKDIR)).getIndexSize();
    seed.manager.dispose();
    // 上限正好等于现在的索引: 先改写保留的那条 (标题更长) 时来源还在, 中间态会超限; 合并完成后索引更小。
    const tight = managerWith(() => plan, { hardIndexBytes: full });
    const store = await tight.manager.getStore(WORKDIR);

    const outcome = await tight.manager.tidy(WORKDIR, 'manual');
    expect(outcome.status).toBe('done');
    expect((await store.list()).map((r) => r.filename)).toEqual(['feedback_zh2.md']);

    // 撤销把两条都恢复出来; 恢复的是整理前已经存在的内容, 不能被索引上限挡住。
    const [run] = await tight.manager.listTidyRuns(WORKDIR);
    expect(await tight.manager.undoTidy(WORKDIR, run!.id)).toEqual({ restored: 2, skipped: 0 });
    expect((await store.list()).map((r) => r.filename).sort()).toEqual(['feedback_zh.md', 'feedback_zh2.md']);
    tight.manager.dispose();
  });

  it('索引原本就超过硬上限 (旧记忆并入后): 撤销仍能完整恢复, 不把预算失败算成「整理后被改过」', async () => {
    const plan = JSON.stringify({
      merges: [{ sources: ['feedback_zh.md', 'feedback_zh2.md'], title: 'z', description: 'z', body: 'z', reason: '同一件事' }],
      deletes: [],
    });
    const { manager } = managerWith(() => plan);
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');
    await write(manager, 'other', '称用户不称主人');
    manager.dispose();
    // 上限比现在的索引小很多: 等于升级前就超限的库。
    const over = managerWith(() => plan, { hardIndexBytes: 120 });
    expect((await over.manager.tidy(WORKDIR, 'manual')).status).toBe('done');
    const [run] = await over.manager.listTidyRuns(WORKDIR);
    expect(await over.manager.undoTidy(WORKDIR, run!.id)).toEqual({ restored: 2, skipped: 0 });
    expect((await over.manager.listTidyRuns(WORKDIR))[0]?.undoneAt).toBeTruthy();
    over.manager.dispose();
  });

  // 评审 (Greptile P1): 整理等模型的时候用户撤销了旧记录, 整理结束不能把那个标记冲掉。
  it('整理期间撤销了旧记录: 整理提交后那条的「已撤销」标记还在, 新记录也在', async () => {
    const first = managerWith(() => mergePlan);
    await write(first.manager, 'zh', '回复一律用中文');
    await write(first.manager, 'zh2', '始终用中文回复');
    await first.manager.tidy(WORKDIR, 'manual');
    const [oldRun] = await first.manager.listTidyRuns(WORKDIR);
    first.manager.dispose();

    let manager!: MakerMemoryManager;
    const plan = JSON.stringify({
      merges: [{ sources: ['feedback_zh2.md', 'feedback_x.md'], title: 'x', description: 'x', body: 'x', reason: '同一件事' }],
      deletes: [],
    });
    ({ manager } = managerWith(async () => {
      await manager.undoTidy(WORKDIR, oldRun!.id);
      return plan;
    }));
    await write(manager, 'x', '新的一条');
    // undo 把 zh 写回来了; 再造出第二轮整理要用到的两条。
    const outcome = await manager.tidy(WORKDIR, 'manual');
    expect(outcome.status).toBe('done');
    const runs = await manager.listTidyRuns(WORKDIR);
    expect(runs.find((r) => r.id === oldRun!.id)?.undoneAt).toBeTruthy();
    expect(runs.length).toBe(outcome.status === 'done' && outcome.run ? 2 : 1);
    manager.dispose();
  });

  // 评审 (Codex P2): 存量的双前缀分片 (`user_user_xxx.md`) 能被整理删除, 撤销必须能按原名建回。
  it('撤销能恢复被整理删掉的存量双前缀分片', async () => {
    const plan = JSON.stringify({
      merges: [{ sources: ['feedback_feedback_zh.md', 'feedback_zh2.md'], title: 'z', description: 'z', body: 'z', reason: '同一件事' }],
      deletes: [],
    });
    const { manager } = managerWith(() => plan);
    await write(manager, 'zh', '回复一律用中文');
    const dir = path.join(root, 'maker-memory', memoryScopeDirName(WORKDIR));
    await copyFile(path.join(dir, 'feedback_zh.md'), path.join(dir, 'feedback_feedback_zh.md'));
    await write(manager, 'zh2', '始终用中文回复');
    await write(manager, 'other', '称用户不称主人');

    expect((await manager.tidy(WORKDIR, 'manual')).status).toBe('done');
    const store = await manager.getStore(WORKDIR);
    expect((await store.list()).map((r) => r.filename)).not.toContain('feedback_feedback_zh.md');
    const [run] = await manager.listTidyRuns(WORKDIR);
    expect(run?.changes.map((c) => `${c.kind}:${c.filename}`)).toContain('deleted:feedback_feedback_zh.md');

    expect(await manager.undoTidy(WORKDIR, run!.id)).toEqual({ restored: 2, skipped: 0 });
    expect((await store.list()).map((r) => r.filename)).toContain('feedback_feedback_zh.md');
    manager.dispose();
  });

  // 评审 (Codex P1): 发出的整理请求带着整份记忆, 账号在请求之前切换时不能发出去。
  it('写完尝试记录后账号已切换: 不把旧账号的记忆发给辅助模型', async () => {
    let owner = 'account-a';
    const { manager, reviewOneShot } = managerWith(() => mergePlan, undefined, () => owner);
    await write(manager, 'zh', '回复一律用中文');
    await write(manager, 'zh2', '始终用中文回复');
    const store = await manager.getStore(WORKDIR);
    const realUpdate = store.updateTidyState.bind(store);
    vi.spyOn(store, 'updateTidyState').mockImplementation(async (update) => {
      const next = await realUpdate(update);
      owner = 'account-b';
      return next;
    });

    await expect(manager.tidy(WORKDIR, 'manual')).rejects.toThrow(/not-ready|memory/);
    expect(reviewOneShot).not.toHaveBeenCalled();
    manager.dispose();
  });

  // 评审 (Codex P1, 同一族: 一次操作跨多份 store 时, 每次打开前按入口账号复核)。
  it('一轮任务整理多份记忆: 前一份之后账号切换, 后面的不再整理', async () => {
    let owner = 'account-a';
    const { manager } = managerWith(() => null, undefined, () => owner);
    const tidy = vi.spyOn(manager, 'tidy').mockImplementation(async () => {
      owner = 'account-b';
      return { status: 'not-due' };
    });

    await expect(manager.tidyIfDue(WORKDIR)).rejects.toThrow(/not-ready|memory/);
    expect(tidy).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  // 评审 (Codex P1): 分片已删、之后重建派生索引才失败时, 删除已经提交, 必须记进整理记录并可撤销。
  describe.each([
    ['合并的来源', JSON.stringify({
      merges: [{ sources: ['feedback_zh.md', 'feedback_zh2.md'], title: 'z', description: 'z', body: 'z', reason: '同一件事' }],
      deletes: [],
    })],
    ['已被覆盖而删除的条目', JSON.stringify({
      merges: [],
      deletes: [{ filename: 'feedback_zh.md', supersededBy: 'feedback_zh2.md', reason: '被覆盖' }],
    })],
  ])('删除成功但索引重建失败: %s', (_label, plan) => {
    it('删掉的分片仍在整理记录里, 撤销能完整恢复', async () => {
      const { manager } = managerWith(() => plan);
      await write(manager, 'zh', '只存在于这一条里的内容');
      await write(manager, 'zh2', '始终用中文回复');
      await write(manager, 'other', '称用户不称主人');

      // 第一次重建属于保留条目的改写 (合并) 或不存在 (覆盖删除); 之后第一次删除触发的重建失败。
      const real = (MemoryStorage.prototype as unknown as { rebuildIndex: () => Promise<void> }).rebuildIndex;
      let afterFirstUnlink = false;
      const spy = vi
        .spyOn(MemoryStorage.prototype as unknown as { rebuildIndex: () => Promise<void> }, 'rebuildIndex')
        .mockImplementation(async function (this: unknown) {
          const dir = path.join(root, 'maker-memory', memoryScopeDirName(WORKDIR));
          const gone = !(await import('node:fs')).existsSync(path.join(dir, 'feedback_zh.md'));
          if (gone && !afterFirstUnlink) {
            afterFirstUnlink = true;
            throw new Error('simulated rebuildIndex io failure');
          }
          return real.call(this);
        });

      await expect(manager.tidy(WORKDIR, 'manual')).rejects.toThrow(/simulated rebuildIndex/);
      spy.mockRestore();

      const [run] = await manager.listTidyRuns(WORKDIR);
      expect(run?.changes.map((c) => `${c.kind}:${c.filename}`)).toContain('deleted:feedback_zh.md');
      expect(await manager.undoTidy(WORKDIR, run!.id)).toMatchObject({ skipped: 0 });
      const store = await manager.getStore(WORKDIR);
      expect((await store.list()).find((r) => r.filename === 'feedback_zh.md')?.body).toBe('只存在于这一条里的内容');
      manager.dispose();
    });
  });

  it('伙伴的记忆不参与整理', async () => {
    const { manager, reviewOneShot } = managerWith(() => mergePlan);
    expect(await manager.tidy(buildBotMemoryScopeKey('bot-1'), 'manual')).toEqual({ status: 'unavailable' });
    expect(await manager.tidyIfDue(buildBotMemoryScopeKey('bot-1'))).toEqual([]);
    expect(reviewOneShot).not.toHaveBeenCalled();
    manager.dispose();
  });
});
