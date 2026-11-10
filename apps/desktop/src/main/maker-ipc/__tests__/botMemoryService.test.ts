/**
 * 伙伴记忆页服务:列表只含四类正式记忆、搜索走 store 检索、保存 / 删除前做并发比对,
 * 改正文时摘要按首句刷新,连续改动只合并请求一次运行时刷新。
 *
 * 读写落在真实的 MemoryStorage(文件 + MEMORY.md 索引),只有 FTS 检索用替身。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MEMORY_CONFIG,
  MemoryError,
  MemoryStorage,
  type MakerMemoryManager,
  type MakerMemoryStore,
  type SearchHit,
  type TidyRun,
} from '@cindy/maker-core';

import { BOT_MEMORY_CHANGED } from '../../../shared/botMemory';
import { importFailureCode } from '../../bot-import/types.js';
import { botMemoryDescriptionFromBody, createBotMemoryService } from '../botMemoryService';
import { createMakerMemoryEntriesService } from '../makerMemoryEntriesService';

let dir = '';
let storage: MemoryStorage;
let hits: SearchHit[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-memory-svc-'));
  storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
  hits = [];
  await storage.write({
    type: 'feedback',
    name: 'verify-before-claiming',
    title: '说结论前核实',
    description: '先核实再陈述事实',
    body: '回复前主动核实事实。\n\n- 没有核实的内容标注待验证；\n- 已有证据可以复用。',
  });
  await storage.write({
    type: 'digest',
    name: 'pi-compaction-1',
    title: 'internal digest',
    description: 'dropped context',
    body: 'summary',
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(options: { bot?: { canonicalSessionId: string | null } | null } = {}) {
  const store = {
    list: () => storage.list(),
    read: (filename: string) => storage.read(filename),
    write: (opts: Parameters<MemoryStorage['write']>[0]) => storage.write(opts),
    update: (...args: Parameters<MemoryStorage['update']>) => storage.update(...args),
    delete: (...args: Parameters<MemoryStorage['delete']>) => storage.delete(...args),
    search: vi.fn(async () => hits),
  } as unknown as MakerMemoryStore;
  const timers: Array<() => void> = [];
  const requestRefresh = vi.fn(async () => true);
  const service = createBotMemoryService({
    getStore: async () => store,
    readBot: async () => (options.bot === undefined ? { canonicalSessionId: 'session-1' } : options.bot),
    requestRefresh,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: (handle) => {
      timers[(handle as number) - 1] = () => {};
    },
  });
  const flushTimers = () => timers.splice(0).forEach((run) => run());
  return { service, store, requestRefresh, flushTimers };
}

describe('bot memory service', () => {
  it('lists curated memories only, with a plain-text preview', async () => {
    const { service } = setup();
    const entries = await service.list('bot-1');
    expect(entries).toEqual([
      expect.objectContaining({
        filename: 'feedback_verify-before-claiming.md',
        type: 'feedback',
        title: '说结论前核实',
        preview: '回复前主动核实事实。 没有核实的内容标注待验证； 已有证据可以复用。',
      }),
    ]);
  });

  it('searches through the store and skips internal or vanished hits', async () => {
    const { service, store } = setup();
    hits = [
      { filename: 'digest_pi-compaction-1.md', type: 'digest', title: '', snippet: '', score: 0 },
      { filename: 'user_missing.md', type: 'user', title: '', snippet: '', score: 0 },
      { filename: 'feedback_verify-before-claiming.md', type: 'feedback', title: '', snippet: '', score: 0 },
    ];
    const entries = await service.list('bot-1', ' 核实 ');
    expect(store.search).toHaveBeenCalledWith('核实', { limit: 50 });
    expect(entries.map((entry) => entry.filename)).toEqual(['feedback_verify-before-claiming.md']);
  });

  it('rejects unknown teammates and internal memories', async () => {
    await expect(setup({ bot: null }).service.list('bot-x')).rejects.toThrow('[NOT_FOUND]');
    await expect(setup().service.read('bot-1', 'digest_pi-compaction-1.md')).rejects.toThrow('[INVALID_PARAMS]');
    await expect(setup().service.read('bot-1', '../MEMORY.md')).rejects.toThrow('[INVALID_PARAMS]');
  });

  it('updates title and body, refreshing the summary from the new first sentence', async () => {
    const { service, requestRefresh, flushTimers } = setup();
    const current = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    const saved = await service.update({
      botId: 'bot-1',
      filename: current.filename,
      title: '  先核实再说  ',
      body: '区分已实现、已验证与已合并。其余照旧。',
      expectedUpdatedAt: current.updatedAt,
    });
    expect(saved).toMatchObject({ title: '先核实再说', body: '区分已实现、已验证与已合并。其余照旧。' });
    const record = await storage.read(current.filename);
    expect(record.frontmatter.description).toBe('区分已实现、已验证与已合并。');
    expect(await storage.getIndex()).toContain('先核实再说');
    expect(requestRefresh).not.toHaveBeenCalled();
    flushTimers();
    expect(requestRefresh).toHaveBeenCalledWith('session-1');
  });

  it('keeps the existing summary when only the title changes', async () => {
    const { service } = setup();
    const current = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    await service.update({ ...current, botId: 'bot-1', title: '新标题', expectedUpdatedAt: current.updatedAt });
    expect((await storage.read(current.filename)).frontmatter.description).toBe('先核实再陈述事实');
  });

  it('refuses to overwrite or delete a memory the teammate changed meanwhile', async () => {
    const { service, requestRefresh, flushTimers } = setup();
    const opened = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.write({
      type: 'feedback',
      name: 'verify-before-claiming',
      title: '伙伴改过',
      description: '伙伴改过',
      body: '伙伴改过的正文',
      mode: 'update',
    });
    const conflict = `[PRECONDITION_FAILED] ${BOT_MEMORY_CHANGED}`;
    await expect(
      service.update({ botId: 'bot-1', filename: opened.filename, title: 'mine', body: 'mine', expectedUpdatedAt: opened.updatedAt }),
    ).rejects.toThrow(conflict);
    await expect(
      service.delete({ botId: 'bot-1', filename: opened.filename, expectedUpdatedAt: opened.updatedAt }),
    ).rejects.toThrow(conflict);
    expect((await storage.read(opened.filename)).body).toBe('伙伴改过的正文');
    flushTimers();
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it('edits legacy double-prefix memories without renaming or changing another shard', async () => {
    const original = 'feedback_verify-before-claiming.md';
    const legacy = 'feedback_feedback_verify-before-claiming.md';
    await fs.copyFile(path.join(dir, original), path.join(dir, legacy));
    const { service } = setup();
    const current = await service.read('bot-1', legacy);
    await service.update({ ...current, botId: 'bot-1', title: 'Legacy edit', expectedUpdatedAt: current.updatedAt });
    expect((await storage.read(legacy)).frontmatter.title).toBe('Legacy edit');
    expect((await storage.read(original)).frontmatter.title).toBe('说结论前核实');
    expect(await storage.getIndex()).toContain(`[${legacy}] Legacy edit`);
  });

  it('does not open a store after the initiating account changes during the profile read', async () => {
    const getStore = vi.fn();
    const service = createBotMemoryService({
      getStore,
      readBot: async () => ({ canonicalSessionId: 'old', assertCurrent: () => { throw new Error('account changed'); } }),
      requestRefresh: vi.fn(),
    });
    await expect(service.list('bot-1')).rejects.toThrow('account changed');
    expect(getStore).not.toHaveBeenCalled();
  });

  it('validates title and body limits before writing', async () => {
    const { service } = setup();
    const current = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    const base = { botId: 'bot-1', filename: current.filename, expectedUpdatedAt: current.updatedAt };
    await expect(service.update({ ...base, title: ' ', body: 'x' })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(service.update({ ...base, title: 'x'.repeat(101), body: 'x' })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(service.update({ ...base, title: 'x', body: '字'.repeat(3000) })).rejects.toThrow('[INVALID_PARAMS]');
    expect((await storage.read(current.filename)).body).toBe(current.body);
  });

  it('deletes after the version check and coalesces the runtime refresh', async () => {
    const { service, requestRefresh, flushTimers } = setup();
    const current = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    await service.update({ ...current, botId: 'bot-1', title: '改一次', expectedUpdatedAt: current.updatedAt });
    const updated = await service.read('bot-1', current.filename);
    await service.delete({ botId: 'bot-1', filename: current.filename, expectedUpdatedAt: updated.updatedAt });
    await expect(storage.read(current.filename)).rejects.toThrow();
    expect(await service.list('bot-1')).toEqual([]);
    flushTimers();
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it('skips the runtime refresh for teammates without a main task', async () => {
    const { service, requestRefresh, flushTimers } = setup({ bot: { canonicalSessionId: null } });
    const current = await service.read('bot-1', 'feedback_verify-before-claiming.md');
    await service.delete({ botId: 'bot-1', filename: current.filename, expectedUpdatedAt: current.updatedAt });
    flushTimers();
    expect(requestRefresh).not.toHaveBeenCalled();
  });
});

/**
 * 测试价值(Cindy 记忆「查看记忆」页, docs/product-rules/cindy-memory.md §4)
 * - 生产入口与可观察结果: `maker:memory-entries:*` 的 handler 业务体
 *   (createMakerMemoryEntriesService): 范围列表的显示字段、读改删落盘、错误码。
 * - 规则依据: renderer 带回的 scopeKey 必须在 listScopes() 里, 否则不打开存储; 总开关关闭时
 *   已存的记忆仍可看和删(skipDisabledCheck); 保存 / 删除前比对 updatedAt。
 * - 现有覆盖缺口: 上面的用例只经伙伴入口(botId), 不经范围校验与 Cindy 记忆的开关豁免。
 * - 最小失败输入: 不在列表里的路径; 打开之后被任务改过的那条记忆。
 * - tier: unit(真实 MemoryStorage 落在 mkdtemp 目录, 与本文件其余用例同一 fixture)。
 */
describe('Cindy memory entries service', () => {
  const PROJECT = path.join(os.tmpdir(), 'cindy-memory-project');
  const FILE = 'feedback_verify-before-claiming.md';

  function setupEntries(options: { owner?: () => void; taskScopeKey?: string | null } = {}) {
    const store = {
      list: () => storage.list(),
      read: (filename: string) => storage.read(filename),
      update: (...args: Parameters<MemoryStorage['update']>) => storage.update(...args),
      delete: (...args: Parameters<MemoryStorage['delete']>) => storage.delete(...args),
      search: vi.fn(async () => hits),
    } as unknown as MakerMemoryStore;
    const getStore = vi.fn<(scopeKey: string, opts?: { skipDisabledCheck?: boolean }) => Promise<MakerMemoryStore>>(
      async () => store,
    );
    const listScopes = vi.fn(async () => [
      { scopeKey: 'user:account', kind: 'user' as const, count: 0 },
      { scopeKey: PROJECT, kind: 'project' as const, count: 1 },
      { scopeKey: 'ssh:build%20box:/srv/app', kind: 'project' as const, count: 2 },
    ]);
    // 整理由 MakerMemoryManager 完成(调用辅助模型), 这里用替身: 只看服务层的校验与摘要。
    const tidy = vi.fn<MakerMemoryManager['tidy']>(async () => ({ status: 'done', run: null }));
    const listTidyRuns = vi.fn<MakerMemoryManager['listTidyRuns']>(async () => []);
    const undoTidy = vi.fn<MakerMemoryManager['undoTidy']>(async () => ({ restored: 0, skipped: 0 }));
    const service = createMakerMemoryEntriesService({
      getManager: () => ({ listScopes, getStore, tidy, listTidyRuns, undoTidy }),
      resolveTaskScopeKey: async () => options.taskScopeKey ?? null,
      captureOwner: () => ({ assertCurrent: options.owner ?? (() => {}) }),
    });
    return { service, getStore, tidy, listTidyRuns, undoTidy };
  }

  it('lists the account scope first, then projects with a folder name, path and SSH host', async () => {
    expect(await setupEntries().service.scopes()).toEqual({
      scopes: [
        { scopeKey: 'user:account', kind: 'user', count: 0 },
        { scopeKey: PROJECT, kind: 'project', count: 1, name: 'cindy-memory-project', path: PROJECT },
        // 远程路径是稳定的 POSIX 形态(SSH 范围键的一部分), 不跟随本机分隔符。
        { scopeKey: 'ssh:build%20box:/srv/app', kind: 'project', count: 2, name: 'app', path: '/srv/app', host: 'build box' },
      ],
      taskScopeKey: null,
    });
  });

  it('points a task at its project only when that project is one of the listed scopes', async () => {
    // 保存回执只带「写进了项目记忆」, 页面带回任务的工作目录; 解析结果只用来在列表里挑一项。
    const task = { workingDir: path.join(PROJECT, 'packages', 'app') };
    expect((await setupEntries({ taskScopeKey: PROJECT }).service.scopes(task)).taskScopeKey).toBe(PROJECT);
    const unlisted = path.join(os.tmpdir(), 'no-memories-yet');
    expect((await setupEntries({ taskScopeKey: unlisted }).service.scopes(task)).taskScopeKey).toBeNull();
    await expect(setupEntries().service.scopes({ workingDir: 'relative/dir' })).rejects.toThrow('[INVALID_PARAMS]');
  });

  it('reads, edits and deletes a memory of a listed scope even while memory is switched off', async () => {
    const { service, getStore } = setupEntries();
    expect((await service.list(PROJECT)).map((entry) => entry.filename)).toEqual([FILE]);
    const opened = await service.read(PROJECT, FILE);
    const saved = await service.update({
      scopeKey: PROJECT,
      filename: FILE,
      title: '先核实再说',
      body: '区分已实现与已验证。其余照旧。',
      expectedUpdatedAt: opened.updatedAt,
    });
    expect(saved).toMatchObject({ title: '先核实再说', body: '区分已实现与已验证。其余照旧。' });
    expect((await storage.read(FILE)).frontmatter.description).toBe('区分已实现与已验证。');
    await service.delete({ scopeKey: PROJECT, filename: FILE, expectedUpdatedAt: saved.updatedAt });
    await expect(storage.read(FILE)).rejects.toThrow();
    // 每次都按「清理路径」打开: 总开关关闭也不拒绝。
    expect(getStore.mock.calls.every(([key, opts]) => key === PROJECT && opts?.skipDisabledCheck === true)).toBe(true);
  });

  it('never opens a store for a scope key that is not listed', async () => {
    const { service, getStore } = setupEntries();
    const stray = path.join(os.tmpdir(), 'somewhere-else');
    const version = (await storage.read(FILE)).frontmatter.updatedAt;
    await expect(service.list(stray)).rejects.toThrow('[NOT_FOUND]');
    await expect(service.read(stray, FILE)).rejects.toThrow('[NOT_FOUND]');
    await expect(
      service.update({ scopeKey: stray, filename: FILE, title: 't', body: 'b', expectedUpdatedAt: version }),
    ).rejects.toThrow('[NOT_FOUND]');
    await expect(
      service.delete({ scopeKey: stray, filename: FILE, expectedUpdatedAt: version }),
    ).rejects.toThrow('[NOT_FOUND]');
    await expect(service.list(undefined)).rejects.toThrow('[INVALID_PARAMS]');
    expect(getStore).not.toHaveBeenCalled();
    expect((await storage.read(FILE)).frontmatter.title).toBe('说结论前核实');
  });

  it('refuses to overwrite or delete a memory a task changed after it was opened', async () => {
    const { service } = setupEntries();
    const opened = await service.read(PROJECT, FILE);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.write({
      type: 'feedback',
      name: 'verify-before-claiming',
      title: '任务改过',
      description: '任务改过',
      body: '任务改过的正文',
      mode: 'update',
    });
    const conflict = `[PRECONDITION_FAILED] ${BOT_MEMORY_CHANGED}`;
    await expect(
      service.update({ scopeKey: PROJECT, filename: FILE, title: 'mine', body: 'mine', expectedUpdatedAt: opened.updatedAt }),
    ).rejects.toThrow(conflict);
    await expect(
      service.delete({ scopeKey: PROJECT, filename: FILE, expectedUpdatedAt: opened.updatedAt }),
    ).rejects.toThrow(conflict);
    expect((await storage.read(FILE)).body).toBe('任务改过的正文');
  });

  it('does not open a store or hand back memories once the account has changed', async () => {
    let switched = false;
    const { service, getStore } = setupEntries({
      owner: () => {
        if (switched) throw new Error('account changed');
      },
    });
    switched = true;
    await expect(service.list(PROJECT)).rejects.toThrow('account changed');
    await expect(service.scopes()).rejects.toThrow('account changed');
    expect(getStore).not.toHaveBeenCalled();
  });

  /**
   * 测试价值(整理: 「现在整理」、整理记录、撤销; docs/product-rules/cindy-memory.md §3、§4)
   * - 生产入口与可观察结果: `maker:memory-entries:tidy / tidy-runs / tidy-undo` 的 handler 业务体;
   *   界面拿到的是摘要(哪几条合并成了哪一条、哪条被移除), 整理前后的正文不离开 main。
   * - 规则依据: 范围键不可信(§4), 不在 listScopes() 里就不整理、不读记录、不撤销; 撤销结果里的
   *   skipped 是整理之后又被改过、没有恢复的条数(§3)。
   * - 现有覆盖缺口: 整理本身由 maker-core 的 tidy.test.ts 覆盖; 服务层的范围校验、记录归组和
   *   入参校验没有用例。
   * - 最小失败输入: 不在列表里的路径; 一次合并(一条 updated 加同理由的 deleted)加一次移除;
   *   不是字符串的 runId 与已不在记录里的 runId。
   * - tier: unit(MakerMemoryManager 的整理用替身, 不调用模型)。
   */
  const snapshot = (title: string) => ({
    type: 'feedback' as const,
    title,
    description: title,
    body: `${title}(正文)`,
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const RUN: TidyRun = {
    id: 'run-1',
    at: '2026-11-09T21:40:00.000Z',
    trigger: 'manual',
    changes: [
      { kind: 'updated', filename: 'feedback_use-pnpm.md', before: snapshot('用 pnpm'), after: snapshot('统一用 pnpm'), reason: '说的是同一件事' },
      { kind: 'deleted', filename: 'feedback_no-npm.md', before: snapshot('不要用 npm'), reason: '说的是同一件事' },
      { kind: 'deleted', filename: 'project_release-day.md', before: snapshot('周三发版'), reason: '较新的「周二发版」已覆盖' },
    ],
  };

  it('never tidies, lists tidy runs or undoes one for a scope key that is not listed', async () => {
    const { service, tidy, listTidyRuns, undoTidy } = setupEntries();
    const stray = path.join(os.tmpdir(), 'somewhere-else');
    await expect(service.tidy(stray)).rejects.toThrow('[NOT_FOUND]');
    await expect(service.tidyRuns(stray)).rejects.toThrow('[NOT_FOUND]');
    await expect(service.tidyUndo({ scopeKey: stray, runId: RUN.id })).rejects.toThrow('[NOT_FOUND]');
    expect(tidy).not.toHaveBeenCalled();
    expect(listTidyRuns).not.toHaveBeenCalled();
    expect(undoTidy).not.toHaveBeenCalled();
  });

  it('returns a finished tidy as a summary of what was merged and removed, without memory bodies', async () => {
    const { service, tidy } = setupEntries();
    tidy.mockResolvedValueOnce({ status: 'done', run: RUN });
    const result = await service.tidy(PROJECT);
    expect(result).toEqual({
      status: 'done',
      run: {
        id: 'run-1',
        at: RUN.at,
        trigger: 'manual',
        undone: false,
        count: 3,
        changes: [
          { kind: 'merged', title: '统一用 pnpm', mergedTitles: ['用 pnpm', '不要用 npm'], reason: '说的是同一件事' },
          { kind: 'removed', title: '周三发版', mergedTitles: [], reason: '较新的「周二发版」已覆盖' },
        ],
      },
    });
    expect(tidy).toHaveBeenCalledWith(PROJECT, 'manual');
    expect(JSON.stringify(result)).not.toContain('(正文)');
    // 看过了、没有需要整理的: run 为 null 原样交给界面。
    expect(await service.tidy(PROJECT)).toEqual({ status: 'done', run: null });
  });

  it('passes the undo result through and rejects a malformed or unknown run id', async () => {
    const { service, undoTidy } = setupEntries();
    undoTidy.mockResolvedValueOnce({ restored: 2, skipped: 1 });
    expect(await service.tidyUndo({ scopeKey: PROJECT, runId: RUN.id })).toEqual({ restored: 2, skipped: 1 });
    expect(undoTidy).toHaveBeenCalledWith(PROJECT, RUN.id);
    // 不是字符串或为空: 不去动记忆。
    await expect(service.tidyUndo({ scopeKey: PROJECT, runId: 42 })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(service.tidyUndo({ scopeKey: PROJECT, runId: '' })).rejects.toThrow('[INVALID_PARAMS]');
    expect(undoTidy).toHaveBeenCalledTimes(1);
    // 记录里已经没有这次整理(只保留最近 20 次)。
    undoTidy.mockRejectedValueOnce(new MemoryError('not-found', 'tidy run not found'));
    await expect(service.tidyUndo({ scopeKey: PROJECT, runId: 'run-gone' })).rejects.toThrow('[NOT_FOUND]');
  });
});

describe('botMemoryDescriptionFromBody', () => {
  it('takes the first sentence as a single line', () => {
    expect(botMemoryDescriptionFromBody('- 第一条。\n- 第二条。')).toBe('第一条。');
    expect(botMemoryDescriptionFromBody('Verify first! Then answer.')).toBe('Verify first!');
    expect(botMemoryDescriptionFromBody('没有句号的一段\n换行')).toBe('没有句号的一段 换行');
    expect(Array.from(botMemoryDescriptionFromBody('长'.repeat(500)))).toHaveLength(200);
  });
});

it('imports long original memory into the real index without losing Unicode, and retries once', async () => {
  const { service } = setup();
  const original = '记得我的偏好🙂。'.repeat(900);
  await service.importDocument('bot-1', 'source-memory', '原有记忆', original);
  await service.importDocument('bot-1', 'source-memory', '原有记忆', original);
  const entries = (await service.list('bot-1')).filter(row => row.filename.startsWith('reference_import_source-memory_')).sort((a, b) => a.filename.localeCompare(b.filename));
  expect(entries.length).toBeGreaterThan(1);
  const restored = await Promise.all(entries.map(row => storage.read(row.filename)));
  expect(restored.map(row => row.body).join('')).toBe(original);
  expect(await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8')).toContain(entries[0]!.filename);
});

it('round-trips emoji summaries, source frontmatter, blank lines and all parts through real storage', async () => {
  const { service } = setup();
  const original = '---\ntitle: Source title\n---\n' + '🙂'.repeat(110) + '\n\n' + ('段落 abc 🙂 '.repeat(1500)) + '\n  ';
  await service.importDocument('bot-1', 'complete-source', '🙂'.repeat(90), original);
  await service.importDocument('bot-1', 'complete-source', '🙂'.repeat(90), original);
  const records = (await storage.list()).filter(record => record.filename.startsWith('reference_import_complete-source_'))
    .sort((a, b) => Number(a.filename.match(/_(\d+)\.md$/)![1]) - Number(b.filename.match(/_(\d+)\.md$/)![1]));
  expect(records.length).toBeGreaterThan(2);
  expect(records.map(record => record.body).join('')).toBe(original);
  for (const record of records) expect(record.frontmatter.description.length).toBeLessThanOrEqual(200);
});

it('reports a partial document write and retries missing chunks without duplicating or replacing saved content', async () => {
  const { service } = setup();
  const original = '  ' + 'x'.repeat(18000) + '\n\nlast paragraph 🙂';
  const write = storage.write.bind(storage);
  let fail = true;
  vi.spyOn(storage, 'write').mockImplementation(async opts => {
    if (fail && opts.name.endsWith('_1')) throw Object.assign(new Error('private filesystem detail'), { code: 'ENOSPC' });
    return write(opts);
  });
  await expect(service.importDocument('bot-1', 'retry-document', 'retry', original)).rejects.toMatchObject({ code: 'ENOSPC', importProgress: { saved: 1, total: 3 } });
  const first = await storage.read('reference_import_retry-document_0.md');
  fail = false;
  await service.importDocument('bot-1', 'retry-document', 'retry', original);
  const parts = await Promise.all([0, 1, 2].map(index => storage.read(`reference_import_retry-document_${index}.md`)));
  expect(parts.map(part => part.body).join('')).toBe(original);
  expect(parts[0].frontmatter.updatedAt).toBe(first.frontmatter.updatedAt);
  // A user edit through the filesystem must not be hidden by stale serialization metadata.
  await fs.appendFile(path.join(dir, first.filename), '\nUser added this later.');
  expect((await storage.read(first.filename)).body).toContain('User added this later.');
  await expect(service.importDocument('bot-1', 'retry-document', 'retry', original)).rejects.toThrow('PRECONDITION_FAILED');
});

it.each(['leading', 'trailing', 'same-length', 'blank-only', 'editor'] as const)('keeps a %s whitespace edit during partial-import retry', async edit => {
  const { service } = setup();
  const { BOT_MEMORY_BODY_MAX_BYTES } = await import('../../../shared/botMemory.js');
  const firstBody = edit === 'blank-only' ? ' '.repeat(BOT_MEMORY_BODY_MAX_BYTES) : '  ' + 'x'.repeat(BOT_MEMORY_BODY_MAX_BYTES - 2);
  const original = firstBody + '\nLast paragraph';
  const write = storage.write.bind(storage);
  const failure = vi.spyOn(storage, 'write').mockImplementation(async opts => {
    if (opts.name.endsWith('_1')) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return write(opts);
  });
  await expect(service.importDocument('bot-1', 'spaces', 'source', original)).rejects.toMatchObject({ code: 'ENOSPC', importProgress: { saved: 1, total: 2 } });
  failure.mockRestore();
  const filename = 'reference_import_spaces_0.md';
  const file = path.join(dir, filename);
  const first = await storage.read(filename);
  expect(first.body).toBe(firstBody);
  const edited = edit === 'trailing' ? firstBody + '\n\t' : edit === 'same-length' ? '\t ' + firstBody.slice(2) : firstBody.slice(1);
  if (edit === 'editor') await storage.update(filename, first.frontmatter.updatedAt, { title: 'source', description: 'source', body: edited });
  else await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(firstBody, edited));
  const changedFile = await fs.readFile(file, 'utf8');
  const error = await service.importDocument('bot-1', 'spaces', 'source', original).then(() => null, error => error);
  expect(error).toMatchObject({ code: 'version-conflict', importProgress: { saved: 0, total: 2 } });
  expect(importFailureCode(error)).toBe('MEMORY_CHANGED');
  expect(await fs.readFile(file, 'utf8')).toBe(changedFile);
  await expect(storage.read('reference_import_spaces_1.md')).rejects.toMatchObject({ code: 'not-found' });
});

it('retries legacy imported shards using their original trimmed-body semantics', async () => {
  const { service } = setup();
  await storage.write({ type: 'reference', name: 'import_legacy_0', title: 'legacy', description: 'legacy', body: 'original' });
  const file = path.join(dir, 'reference_import_legacy_0.md');
  const before = await fs.readFile(file, 'utf8');
  expect((await storage.read('reference_import_legacy_0.md')).frontmatter.bodyLength).toBeUndefined();
  await service.importDocument('bot-1', 'legacy', 'legacy', '  original\n\n');
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  await expect(service.importDocument('bot-1', 'legacy', 'legacy', 'different')).rejects.toMatchObject({ code: 'version-conflict' });
});

describe('cloud companion restore', () => {
  it('restores a raw memory file exactly through the store and removes tombstones', async () => {
    const { service, requestRefresh, flushTimers } = setup();
    const raw = await fs.readFile(path.join(dir, 'feedback_verify-before-claiming.md'), 'utf8');
    await service.restoreRaw('bot-1', 'user_tea.md', raw.replace('feedback', 'user'));
    const restored = await storage.read('user_tea.md');
    expect(restored.frontmatter).toMatchObject({ title: '说结论前核实', description: '先核实再陈述事实', type: 'user' });
    expect(restored.body).toBe((await storage.read('feedback_verify-before-claiming.md')).body);
    expect(await storage.getIndex()).toContain('user_tea.md');
    // Updating an existing file keeps going through the same path.
    await service.restoreRaw('bot-1', 'user_tea.md', '---\ntitle: Tea\n---\nlikes green tea');
    expect((await storage.read('user_tea.md')).body).toBe('likes green tea');
    await service.removeRaw('bot-1', 'user_tea.md');
    await service.removeRaw('bot-1', 'user_tea.md');
    await expect(storage.read('user_tea.md')).rejects.toMatchObject({ code: 'not-found' });
    flushTimers();
    expect(requestRefresh).toHaveBeenCalledWith('session-1');
  });

  it('rejects filenames outside the memory naming rule', async () => {
    const { service } = setup();
    await expect(service.restoreRaw('bot-1', '../evil.md', 'x')).rejects.toThrow();
  });
});
