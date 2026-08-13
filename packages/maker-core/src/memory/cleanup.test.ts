/**
 * cleanup.test.ts — P0.5 分片内清理 (cleanup.ts) 单测。
 *
 * 覆盖: 完全重复自动去重、近似重复仅报告、终态候选(信号/弱信号/时间)仅报告、
 * archiveStale 显式归档、user/feedback 不判定终态、digest 保留最新 N、归档幂等、
 * 归档/备份同名冲突循环后缀 (含同 clock rerun)。
 */

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_DIR_NAME,
  planMemoryCleanup,
  runMemoryCleanup,
} from './cleanup.js';
import { MemoryStorage } from './storage.js';

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

  it('lists stale candidates (signal/weak-signal/age) but does NOT auto-archive them', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');
    await shard('reference_stale.md', 'reference', 'Ref', 'hook', 'deprecated 接口',
      '2026-01-01T00:00:00.000Z');
    await shard('project_old.md', 'project', 'Old', 'hook', 'no signal', '2020-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 终态候选全部进 staleCandidates, 但都不进 archiveItems (仅报告)。
    const reasons = new Map(plan.staleCandidates.map((c) => [c.filename, c.reason]));
    expect(reasons.get('project_done.md')).toBe('signal');
    expect(reasons.get('reference_stale.md')).toBe('weak-signal');
    expect(reasons.get('project_old.md')).toBe('age');
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('lists non-adjacent question/negation as report-only candidates too', async () => {
    // 非紧邻疑问/否定 (Greptile P1 on #2561): 不再靠前缀排除, 因为终态候选
    // 本来就是 report-only, 不会误归档; 它们进候选列表由用户判断。
    await shard('project_q.md', 'project', 'Q', 'hook', '是否确认当前项目已关闭',
      '2026-01-01T00:00:00.000Z');
    await shard('project_n.md', 'project', 'N', 'hook', '尚未确认该项目已结束',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.staleCandidates.map((c) => c.filename).sort()).toEqual([
      'project_n.md',
      'project_q.md',
    ]);
    // 关键: 仍不自动归档。
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('never flags user/feedback entries as stale even with signal words', async () => {
    await shard('feedback_rule.md', 'feedback', 'Rule', 'hook', '不再维护这个习惯',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.staleCandidates).toHaveLength(0);
  });

  it('retains the newest N digests and archives the rest', async () => {
    await shard('digest_old.md', 'digest', 'Digest 1', 'hook', 'old', '2026-01-01T00:00:00.000Z');
    await shard('digest_mid.md', 'digest', 'Digest 2', 'hook', 'mid', '2026-02-01T00:00:00.000Z');
    await shard('digest_new.md', 'digest', 'Digest 3', 'hook', 'new', '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.digests.keep).toEqual(['digest_new.md', 'digest_mid.md']); // 默认保留 2
    expect(plan.digests.archive).toEqual(['digest_old.md']);
    // digest 冗余是确定性动作 → 进 archiveItems。
    expect(plan.archiveItems.map((i) => i.filename)).toEqual(['digest_old.md']);
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
    // 归档文件名带时间戳+随机后缀 (rename 原子移动)。
    expect((await archiveContents()).some((f) => f.startsWith('feedback_a.md.'))).toBe(true);
    await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'feedback_b.md'), 'utf8')).resolves.toContain('same');
    const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('feedback_a.md');
    expect(index).toContain('feedback_b.md');
  });

  it('does not archive stale candidates by default (archiveStale=false)', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const result = await runMemoryCleanup(plan);

    expect(result.archived).toHaveLength(0);
    // 终态候选未归档, 仍留在分片目录。
    await expect(readFile(path.join(dir, 'project_done.md'), 'utf8')).resolves.toContain('已归档');
  });

  it('archives stale candidates only when archiveStale=true', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const result = await runMemoryCleanup(plan, { archiveStale: true });

    expect(result.archived.map((a) => a.filename)).toEqual(['project_done.md']);
    expect((await archiveContents()).some((f) => f.startsWith('project_done.md.'))).toBe(true);
  });

  it('is idempotent — re-running yields an empty plan archive set', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    await runMemoryCleanup(await planMemoryCleanup(dir));
    const second = await planMemoryCleanup(dir);
    expect(second.archiveItems).toHaveLength(0);
    expect(second.duplicates).toHaveLength(0);
  });

  it('does not overwrite existing archive on collision (random-suffix rename)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    await mkdir(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    await writeFile(path.join(dir, ARCHIVE_DIR_NAME, 'feedback_a.md'), 'stale archive', 'utf8');

    await runMemoryCleanup(await planMemoryCleanup(dir));

    const archived = await archiveContents();
    expect(archived).toContain('feedback_a.md'); // 旧归档保留
    // 新归档用时间戳+随机后缀, 不覆盖旧归档。
    expect(archived.some((f) => f.startsWith('feedback_a.md.'))).toBe(true);
  });

  it('suffixes backup filename on collision instead of overwriting', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    const backupRoot = path.join(dir, 'backup');
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(backupRoot, 'feedback_a.md'), 'previous backup', 'utf8');

    await runMemoryCleanup(await planMemoryCleanup(dir), { backupRoot });

    const backup = await readdir(backupRoot);
    expect(await readFile(path.join(backupRoot, 'feedback_a.md'), 'utf8')).toBe('previous backup');
    expect(backup.some((f) => f.startsWith('feedback_a.md.'))).toBe(true);
  });

  it('does not overwrite pre-existing archive on same-stamp rerun', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    // 固定时钟, 模拟同 clock rerun: 预置旧归档 (base + 随机后缀), 新归档
    // 用时间戳+随机后缀, 与预置名不同, 绝不覆盖。
    const fixedNow = () => '2026-08-13T00:00:00.000Z';
    const stamp = fixedNow().replace(/[:.]/g, '-');
    await mkdir(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    await writeFile(path.join(dir, ARCHIVE_DIR_NAME, 'feedback_a.md'), 'v0', 'utf8');
    await writeFile(path.join(dir, ARCHIVE_DIR_NAME, `feedback_a.md.${stamp}.deadbeef`), 'v1', 'utf8');

    const plan = await planMemoryCleanup(dir);
    await runMemoryCleanup(plan, { deps: { now: fixedNow } });

    const archived = await archiveContents();
    // 两个预置旧归档都保留, 新归档成功 (随机后缀, 与预置名不同)。
    expect(archived).toContain('feedback_a.md');
    expect(archived).toContain(`feedback_a.md.${stamp}.deadbeef`);
    expect(archived).toHaveLength(3);
  });

  it('exposes MEMORY.md rebuild failure instead of swallowing it', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const spy = vi
      .spyOn(MemoryStorage.prototype, 'rebuildIndex')
      .mockRejectedValue(new Error('disk full'));

    try {
      const result = await runMemoryCleanup(plan);
      // 归档本身成功, 但索引重建失败必须暴露 (Codex P2 on #2561)。
      expect(result.archived).toHaveLength(1);
      expect(result.indexRebuildError).toContain('disk full');
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces EPERM lock errors instead of retrying forever', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 Windows --force 下宿主锁定源文件: fs.link 持续 EPERM 且目标不存在
    // → 必须暴露为 failed, 而非把 EPERM 当目标冲突无限重试 (Greptile P1 /
    // Codex P2 on #2561)。
    const spy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('source locked'), { code: 'EPERM' }));

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      // 源保留 (未被删)。
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
    } finally {
      spy.mockRestore();
    }
  });
});
