/**
 * cleanup.test.ts — P0.5 分片内清理 (cleanup.ts) 单测。
 *
 * 覆盖: 完全重复去重、近似重复仅报告、过期信号词归档、仅时间过期仅报告、
 * digest 保留最新 N、user/feedback 不判定终态、归档幂等、归档同名加后缀。
 */

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_DIR_NAME,
  planMemoryCleanup,
  runMemoryCleanup,
} from './cleanup.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-cleanup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 直接写一个合法分片文件 (绕过 MemoryStorage, 精确控制 updatedAt)。 */
async function shard(
  filename: string,
  type: string,
  title: string,
  description: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  const raw = [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    `type: ${type}`,
    // 引号保证 YAML 不把 ISO 时间戳解析成 Date (与 storage 真实写入
    // matter.stringify 的行为一致 — 时间戳字符串会被加引号)。
    `updatedAt: '${updatedAt}'`,
    '---',
    body,
    '',
  ].join('\n');
  await writeFile(path.join(dir, filename), raw, 'utf8');
}

async function archiveContents(): Promise<string[]> {
  try {
    return await readdir(path.join(dir, ARCHIVE_DIR_NAME));
  } catch {
    return [];
  }
}

describe('planMemoryCleanup', () => {
  it('groups exact duplicates by content hash and keeps the newest', async () => {
    await shard('feedback_rule_a.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-01-01T00:00:00.000Z');
    await shard('feedback_rule_b.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].keep).toBe('feedback_rule_b.md'); // 更新的保留
    expect(plan.duplicates[0].archive).toEqual(['feedback_rule_a.md']);
    expect(plan.archiveItems.map((i) => i.filename)).toEqual(['feedback_rule_a.md']);
  });

  it('reports near-duplicates (same title, different body) without auto-archiving', async () => {
    await shard('project_x_1.md', 'project', 'Same title', 'hook', 'body one',
      '2026-01-01T00:00:00.000Z');
    await shard('project_x_2.md', 'project', 'Same title', 'hook', 'body two',
      '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(0);
    expect(plan.nearDuplicates).toHaveLength(1);
    expect(plan.nearDuplicates[0].filenames.sort()).toEqual(['project_x_1.md', 'project_x_2.md']);
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('flags strong stale signals and archives only those', async () => {
    await shard('project_done.md', 'project', 'Done project', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');
    // 弱信号 (英文 broad 词) 只报告不归档。
    await shard('reference_stale.md', 'reference', 'Stale ref', 'hook', 'deprecated 接口',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.stale.map((s) => s.filename)).toEqual(['project_done.md']);
    expect(plan.staleByWeakSignal.map((s) => s.filename)).toEqual(['reference_stale.md']);
    // 只有强信号进归档集合。
    expect(plan.archiveItems.map((i) => i.filename)).toEqual(['project_done.md']);
  });

  it('does not treat negated/questioned/reference context as terminal', async () => {
    // 否定/疑问/引用前缀 → 都不是本条目自身的终态声明。
    await shard('project_q.md', 'project', 'Q', 'hook', '是否已关闭需要再确认',
      '2026-01-01T00:00:00.000Z');
    await shard('project_r.md', 'project', 'R', 'hook', '替换 deprecated 接口',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 「是否已关闭」被前缀排除; 「替换 deprecated」里 deprecated 是弱信号。
    expect(plan.stale).toHaveLength(0);
    expect(plan.archiveItems).toHaveLength(0);
    expect(plan.staleByWeakSignal.map((s) => s.filename)).toEqual(['project_r.md']);
  });

  it('reports age-only stale as low-confidence and does not archive', async () => {
    await shard('project_old.md', 'project', 'Old project', 'hook', 'no signal here',
      '2020-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.stale).toHaveLength(0);
    expect(plan.staleByAge.map((s) => s.filename)).toEqual(['project_old.md']);
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('never flags user/feedback entries as stale even with signal words', async () => {
    await shard('feedback_rule.md', 'feedback', 'Rule', 'hook', '不再维护这个习惯',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.stale).toHaveLength(0);
    expect(plan.staleByAge).toHaveLength(0);
  });

  it('retains the newest N digests and archives the rest', async () => {
    await shard('digest_old.md', 'digest', 'Digest 1', 'hook', 'old', '2026-01-01T00:00:00.000Z');
    await shard('digest_mid.md', 'digest', 'Digest 2', 'hook', 'mid', '2026-02-01T00:00:00.000Z');
    await shard('digest_new.md', 'digest', 'Digest 3', 'hook', 'new', '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.digests.keep).toEqual(['digest_new.md', 'digest_mid.md']); // 默认保留 2
    expect(plan.digests.archive).toEqual(['digest_old.md']);
  });
});

describe('runMemoryCleanup', () => {
  it('archives duplicates into .archive and rebuilds MEMORY.md', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const result = await runMemoryCleanup(plan);

    expect(result.archived.map((a) => a.filename)).toEqual(['feedback_a.md']);
    expect(result.failed).toHaveLength(0);
    // 归档文件在 .archive/, 源文件已移除。
    expect(await archiveContents()).toContain('feedback_a.md');
    await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'feedback_b.md'), 'utf8')).resolves.toContain('same');
    // MEMORY.md 重建: 不再含已归档条目。
    const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('feedback_a.md');
    expect(index).toContain('feedback_b.md');
  });

  it('is idempotent — re-running yields an empty plan archive set', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    await runMemoryCleanup(await planMemoryCleanup(dir));
    const second = await planMemoryCleanup(dir);
    expect(second.archiveItems).toHaveLength(0);
    expect(second.duplicates).toHaveLength(0);
  });

  it('suffixes archive filename on collision instead of overwriting', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    // 预置一个同名旧归档, 制造碰撞。
    await mkdir(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    await writeFile(path.join(dir, ARCHIVE_DIR_NAME, 'feedback_a.md'), 'stale archive', 'utf8');

    await runMemoryCleanup(await planMemoryCleanup(dir));

    const archived = await archiveContents();
    expect(archived).toContain('feedback_a.md'); // 旧归档保留
    expect(archived.some((f) => f.startsWith('feedback_a.md.'))).toBe(true); // 新归档加后缀
  });

  it('suffixes backup filename on collision instead of overwriting', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    const backupRoot = path.join(dir, 'backup');
    // 预置一个同名旧备份, 制造碰撞。
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(backupRoot, 'feedback_a.md'), 'previous backup', 'utf8');

    await runMemoryCleanup(await planMemoryCleanup(dir), { backupRoot });

    const backup = await readdir(backupRoot);
    // 旧备份保留, 新备份加时间戳后缀。
    expect(await readFile(path.join(backupRoot, 'feedback_a.md'), 'utf8')).toBe('previous backup');
    expect(backup.some((f) => f.startsWith('feedback_a.md.'))).toBe(true);
  });
});
