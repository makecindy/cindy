/**
 * MemoryStorage size 软警告的数值明细 (#891):
 * warning 枚举保持不变, warningDetail 附当前字节 / 软上限 / (分片) 硬上限,
 * 让调用方判断超了多少, 而不是盲目瘦身。
 */

import { access, copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorage } from './storage.js';
import { DEFAULT_MEMORY_CONFIG, type WriteOptions } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-warning-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function writeOpts(body: string, name = 'warn-case'): WriteOptions {
  return {
    type: 'project',
    name,
    title: '测试分片',
    description: '软警告数值明细测试用',
    body,
  };
}

describe('MemoryStorage · size 软警告数值明细', () => {
  it('分片超软上限: warning 不变, warningDetail 带 sizeBytes/软上限/硬上限', async () => {
    const storage = new MemoryStorage(dir, {
      ...DEFAULT_MEMORY_CONFIG,
      maxShardBytes: 64,
    });
    await storage.init(dir);
    const body = 'x'.repeat(100);
    const result = await storage.write(writeOpts(body));
    expect(result.ok).toBe(true);
    expect(result.warning).toBe('shard-size-exceeded');
    expect(result.warningDetail).toEqual({
      kind: 'shard-size-exceeded',
      sizeBytes: 100,
      softLimitBytes: 64,
      hardLimitBytes: DEFAULT_MEMORY_CONFIG.hardShardBytes,
    });
  });

  it('索引超软上限: warningDetail 是索引字节数, 不带 hardLimitBytes', async () => {
    const storage = new MemoryStorage(dir, {
      ...DEFAULT_MEMORY_CONFIG,
      maxIndexBytes: 8,
    });
    await storage.init(dir);
    const result = await storage.write(writeOpts('短内容'));
    expect(result.warning).toBe('index-size-exceeded');
    expect(result.warningDetail).toBeDefined();
    expect(result.warningDetail?.kind).toBe('index-size-exceeded');
    expect(result.warningDetail?.softLimitBytes).toBe(8);
    expect(result.warningDetail?.sizeBytes).toBeGreaterThan(8);
    expect(result.warningDetail?.hardLimitBytes).toBeUndefined();
  });

  it('分片与索引同时超限: 分片警告优先(与既有优先级一致)', async () => {
    const storage = new MemoryStorage(dir, {
      ...DEFAULT_MEMORY_CONFIG,
      maxShardBytes: 64,
      maxIndexBytes: 8,
    });
    await storage.init(dir);
    const result = await storage.write(writeOpts('x'.repeat(100)));
    expect(result.warning).toBe('shard-size-exceeded');
    expect(result.warningDetail?.kind).toBe('shard-size-exceeded');
  });

  it('未超限: warning 与 warningDetail 均不出现', async () => {
    const storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
    await storage.init(dir);
    const result = await storage.write(writeOpts('小分片'));
    expect(result.warning).toBeUndefined();
    expect(result.warningDetail).toBeUndefined();
  });

  it('assessWarning: 删源后索引回落则不再报警(consolidate 删源前的写入警告失真场景)', async () => {
    // 探针: 默认配置下量出 1 条 / 2 条时的真实索引字节
    const probe = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
    await probe.init(dir);
    await probe.write(writeOpts('内容 a', 'src-a'));
    const size1 = await probe.getIndexSize();
    await probe.write(writeOpts('内容 b', 'src-b'));
    const size2 = await probe.getIndexSize();
    expect(size2).toBeGreaterThan(size1);

    // 正式: 索引软上限落在两者之间 → 第二条写入报索引警告, 删掉一条后回落
    const dir2 = await mkdtemp(path.join(tmpdir(), 'memory-warning-'));
    try {
      const storage = new MemoryStorage(dir2, {
        ...DEFAULT_MEMORY_CONFIG,
        maxIndexBytes: Math.floor((size1 + size2) / 2),
      });
      await storage.init(dir2);
      await storage.write(writeOpts('内容 a', 'src-a'));
      const over = await storage.write(writeOpts('内容 b', 'src-b'));
      expect(over.warning).toBe('index-size-exceeded');

      await storage.delete('project_src-b.md');
      expect(await storage.assessWarning('project_src-a.md')).toBeUndefined();
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('assessWarning: 分片本身仍超软上限时保持分片警告明细', async () => {
    const storage = new MemoryStorage(dir, {
      ...DEFAULT_MEMORY_CONFIG,
      maxShardBytes: 64,
    });
    await storage.init(dir);
    await storage.write(writeOpts('x'.repeat(100)));
    const detail = await storage.assessWarning('project_warn-case.md');
    expect(detail?.kind).toBe('shard-size-exceeded');
    expect(detail?.sizeBytes).toBe(100);
  });
});

/**
 * 分片地址解析 (memory_write 的 name):
 * MEMORY.md 索引里的文件名 / 带 type 前缀的 slug / 纯 slug 必须命中同一个分片。
 * 回归场景: `project_project-x.md` 这种存量双前缀分片, 只传 `project_x` 会被
 * 前缀校验拒绝, 只传 `x` 又 not-found — 模型只能在三种写法里盲试。
 */
describe('MemoryStorage · 分片地址解析', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
    await storage.init(dir);
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

  /** 建议值必须能直接重发, 否则提示是死链 (#10274 review P1) */
  async function suggestionOf(name: string): Promise<string> {
    const err = await storage.write(opts(name)).catch((e: unknown) => e);
    expect(String(err)).toMatch(/invalid-slug/);
    const suggestion = /如 "([^"]+)"/.exec(String(err))?.[1];
    expect(suggestion).toBeTruthy();
    return suggestion as string;
  }

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

  it('工具描述里给出的示例 project_foo.md 能直接写入', async () => {
    // 描述里的示例值就是模型照着发的值: 示例本身不可用等于又把调用方骗一次 (#10274 review)
    await expect(storage.write(opts('project_foo.md'))).resolves.toMatchObject({ filename: 'project_foo.md' });
  });

  it('新建时拒绝 <type>- 前缀, 建议的纯 slug 可直接重发', async () => {
    const suggestion = await suggestionOf('project-fresh');
    expect(await missing('project_project-fresh.md')).toBe(true);
    const result = await storage.write(opts(suggestion));
    expect(result.filename).toBe(`project_${suggestion}.md`);
  });

  it('name 等于 type 或去前缀后等于 type 时, 建议值同样可直接重发', async () => {
    for (const name of ['project', 'project_project']) {
      const suggestion = await suggestionOf(name);
      await expect(storage.write(opts(suggestion))).resolves.toMatchObject({
        filename: `project_${suggestion}.md`,
      });
      await rm(path.join(dir, `project_${suggestion}.md`));
    }
  });

  it('slug 长度以 storage 上限为准, 带 type 前缀与 .md 的索引写法不算超长', async () => {
    await storage.write(opts('a'.repeat(64)));
    await expect(storage.write(opts('b'.repeat(65)))).rejects.toThrow(/invalid-slug/);
    const viaIndex = await storage.write(opts(`project_${'a'.repeat(64)}.md`, 'v2', 'update'));
    expect(viaIndex.filename).toBe(`project_${'a'.repeat(64)}.md`);
  });

  it('同 key 命中多个分片时报 ambiguous-address; 传完整文件名仍可消歧', async () => {
    await storage.write(opts('dup'));
    await copyFile(path.join(dir, 'project_dup.md'), path.join(dir, 'project_project-dup.md'));

    await expect(storage.write(opts('dup', 'v2', 'update'))).rejects.toThrow(/ambiguous-address/);

    const exact = await storage.write(opts('project_project-dup.md', 'v3', 'update'));
    expect(exact.filename).toBe('project_project-dup.md');
    expect((await storage.read('project_dup.md')).body).toBe('v1');
  });

  it('显式文件名可在空目录重建存量双前缀分片 (云端恢复)', async () => {
    const restored = await storage.write(opts(legacy, 'restored'));
    expect(restored.filename).toBe(legacy);
    expect((await storage.read(legacy)).body).toBe('restored');
  });

  it('显式文件名不重定向到同 key 的别名, 云端恢复不会撞 already-exists', async () => {
    await storage.write(opts('note'));

    const restored = await storage.write(opts('project_project-note.md', 'restored'));
    expect(restored.filename).toBe('project_project-note.md');
    expect((await storage.read('project_project-note.md')).body).toBe('restored');
    expect((await storage.read('project_note.md')).body).toBe('v1');
    // 两份同 key 分片共存后, 裸 slug 不再自动选址
    await expect(storage.write(opts('note', 'v2', 'update'))).rejects.toThrow(/ambiguous-address/);
  });

  it('重复 .md 后缀会被拒绝, 不写出 parseFilename 认不出的分片', async () => {
    await expect(storage.write(opts('note.md.md'))).rejects.toThrow(/invalid-slug/);
    expect(await missing('project_note.md.md')).toBe(true);
  });

  it('重复 .md 后缀在命中存量分片时也被拒绝, 不静默改成 update', async () => {
    await storage.write(opts('note'));
    await expect(storage.write(opts('note.md.md', 'v2', 'update'))).rejects.toThrow(/invalid-slug/);
    expect((await storage.read('project_note.md')).body).toBe('v1');
  });

  it('大写 .MD 与 .md 走同一条内嵌 type 检查', async () => {
    await expect(storage.write(opts('feedback_foo.MD'))).rejects.toThrow(/invalid-type/);
    expect(await missing('project_feedback_foo.md')).toBe(true);
  });

  it('索引文件名内嵌的 type 与传入 type 不符时拒绝, 不新建', async () => {
    await expect(storage.write(opts('feedback_foo.md'))).rejects.toThrow(/invalid-type/);
    expect(await missing('project_feedback_foo.md')).toBe(true);
  });
});
