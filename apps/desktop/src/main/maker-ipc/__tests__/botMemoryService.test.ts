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
  MemoryStorage,
  type MakerMemoryStore,
  type SearchHit,
} from '@cindy/maker-core';

import { BOT_MEMORY_CHANGED } from '../../../shared/botMemory';
import { importFailureCode } from '../../bot-import/types.js';
import { botMemoryDescriptionFromBody, createBotMemoryService } from '../botMemoryService';

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
