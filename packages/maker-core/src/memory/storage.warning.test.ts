/**
 * MemoryStorage size 软警告的数值明细 (#891):
 * warning 枚举保持不变, warningDetail 附当前字节 / 软上限 / (分片) 硬上限,
 * 让调用方判断超了多少, 而不是盲目瘦身。
 */

import { mkdtemp, rm } from 'node:fs/promises';
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
