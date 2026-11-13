/**
 * MemoryStorage 分片地址解析 (memory_write 的 name):
 * MEMORY.md 索引里的文件名 / 带 type 前缀的 slug / 纯 slug 必须命中同一个分片。
 * 回归场景: `project_project-x.md` 这种存量双前缀分片, 只传 `project_x` 会被
 * 前缀校验拒绝, 只传 `x` 又 not-found — 模型只能在三种写法里盲试。
 */

import { copyFile, mkdtemp, readFile, rename, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorage } from './storage.js';
import { DEFAULT_MEMORY_CONFIG, type WriteOptions } from './types.js';

let dir: string;
let storage: MemoryStorage;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-address-'));
  storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
  await storage.init(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function opts(name: string, body = 'v1', mode?: WriteOptions['mode']): WriteOptions {
  return { type: 'project', name, title: '测试分片', description: '地址解析测试用', body, mode };
}

const legacy = 'project_project-widget-cache.md';

/** 存量双前缀分片: 先把正常文件写出来, 再改成历史上写坏的名字 */
async function seedLegacyShard(): Promise<void> {
  await storage.write(opts('widget-cache'));
  await rename(path.join(dir, 'project_widget-cache.md'), path.join(dir, legacy));
}

const missing = (filename: string) =>
  access(path.join(dir, filename)).then(
    () => false,
    () => true,
  );

describe('MemoryStorage · 分片地址解析', () => {
  it('带前缀 slug / 索引文件名都命中存量双前缀分片, 不新建', async () => {
    await seedLegacyShard();

    const updated = await storage.write(opts('project_widget-cache', 'v2', 'update'));
    expect(updated.filename).toBe(legacy);

    const appended = await storage.write(opts(legacy, 'v3', 'append'));
    expect(appended.filename).toBe(legacy);

    expect((await storage.read(legacy)).body).toContain('v2');
    expect((await storage.read(legacy)).body).toContain('v3');
    // 没有顺手造出第二个分片
    expect(await missing('project_widget-cache.md')).toBe(true);
  });

  it('索引里的普通文件名可原样用于写入 (不产生 project_project-*)', async () => {
    await storage.write(opts('pricing'));

    const result = await storage.write(opts('project_pricing.md', 'v2', 'update'));
    expect(result.filename).toBe('project_pricing.md');
    expect(await missing('project_project_pricing.md')).toBe(true);
  });

  it('新建时 name 可带 .md, 落盘用规范文件名', async () => {
    const result = await storage.write(opts('fresh-note.md'));
    expect(result.filename).toBe('project_fresh-note.md');
    expect(await readFile(path.join(dir, 'project_fresh-note.md'), 'utf8')).toContain('v1');
  });

  it('新建时拒绝 <type>- 前缀, 并给出可用的纯 slug', async () => {
    await expect(storage.write(opts('project-fresh'))).rejects.toThrow(/invalid-slug.*fresh/);
    expect(await missing('project_project-fresh.md')).toBe(true);
  });

  it('同 key 命中多个分片时报 ambiguous-address; 传完整文件名仍可消歧', async () => {
    await storage.write(opts('dup'));
    await copyFile(path.join(dir, 'project_dup.md'), path.join(dir, 'project_project-dup.md'));

    await expect(storage.write(opts('dup', 'v2', 'update'))).rejects.toThrow(/ambiguous-address/);

    const exact = await storage.write(opts('project_project-dup.md', 'v3', 'update'));
    expect(exact.filename).toBe('project_project-dup.md');
    expect((await storage.read('project_dup.md')).body).toBe('v1');
  });

  it('索引文件名内嵌的 type 与传入 type 不符时拒绝, 不新建', async () => {
    await expect(storage.write(opts('feedback_foo.md'))).rejects.toThrow(/invalid-type/);
    expect(await missing('project_feedback_foo.md')).toBe(true);
  });
});
