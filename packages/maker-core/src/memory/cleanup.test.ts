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
    // 归档 = 排他写快照 (base 名, 冲突时递增后缀)。
    expect((await archiveContents()).some((f) => f.startsWith('feedback_a.md'))).toBe(true);
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
    expect((await archiveContents()).some((f) => f.startsWith('project_done.md'))).toBe(true);
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
    // 两个预置旧归档都保留; 新归档快照 A (递增后缀) + trash 保留副本
    // (随机后缀, open-fd 写入不丢 — Codex P1 on #2561 第十三轮)。
    expect(archived).toContain('feedback_a.md');
    expect(archived).toContain(`feedback_a.md.${stamp}.deadbeef`);
    expect(archived).toHaveLength(4);
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

  it('rebuilds MEMORY.md on repair rerun even when nothing new is archived', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 第一次 apply: 归档成功但索引重建失败 (exit 4 场景)。
    const spy = vi
      .spyOn(MemoryStorage.prototype, 'rebuildIndex')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      const first = await runMemoryCleanup(plan);
      expect(first.archived).toHaveLength(1);
      expect(first.indexRebuildError).toContain('disk full');
    } finally {
      spy.mockRestore();
    }

    // 修复后重跑: plan 已无 archiveItems (feedback_a 已在 .archive), 但索引
    // 重建必须仍执行 — 否则旧 MEMORY.md 继续引用已归档文件且 CLI 误报成功
    // (Codex P2 on #2561: rebuild MEMORY.md on repair reruns)。
    const rerunPlan = await planMemoryCleanup(dir);
    expect(rerunPlan.archiveItems).toHaveLength(0);
    const second = await runMemoryCleanup(rerunPlan);
    expect(second.archived).toHaveLength(0);
    expect(second.indexRebuildError).toBeUndefined();
    const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('feedback_a.md');
    expect(index).toContain('feedback_b.md');
  });

  it('surfaces EPERM lock errors instead of retrying forever', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 Windows --force 下宿主锁定源文件: link (排他预留 src → trash) 与
    // fallback rename 都持续 EPERM → 必须暴露为 failed, 而非把 EPERM 当目标
    // 冲突无限重试 (Greptile P1 / Codex P2 on #2561)。
    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('source locked'), { code: 'EPERM' }));
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValue(Object.assign(new Error('source locked'), { code: 'EPERM' }));

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      // 源保留 (未被删)。
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
    } finally {
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('restores source when it changed during archive (rename captured new content)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟宿主在 hash 校验后、trash 排他预留前写 src (新内容 B): reserveTrashTarget
    // 的 link 执行前先写新内容再 link → trash 内容 ≠ 快照 → 应恢复 src,
    // 归档保留审阅快照。
    const realLink = fs.link.bind(fs);
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        await writeFile(String(src), "---\ntitle: NEW\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nUPDATED\n", 'utf8');
      }
      return realLink(src as string, dst as string);
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 源被恢复 (新内容保留在 src), 归档保留审阅快照, 记录 failed。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('UPDATED');
      expect((await archiveContents()).some((f) => f.startsWith('feedback_a.md'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not overwrite a recreated source during restore', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟宿主并发写: trash 排他预留 (link) 前写新内容 B (trash 将持有
    // B ≠ 快照 A), 并在 src 被 unlink (移入 trash) 后重建 src (新写入) —
    // restoreTrash 的 link 排他恢复会 EEXIST, 不覆盖新写入 (Greptile P1 /
    // Codex P1 on #2561 第十一轮)。
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        await writeFile(
          String(src),
          "---\ntitle: B\ndescription: b\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nUPDATED\n",
          'utf8',
        );
      }
      return realLink(src as string, dst as string);
    });
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (p) => {
      const r = await realUnlink(p as string);
      if (String(p).endsWith('feedback_a.md')) {
        // 宿主在 src 被 unlink (移入 trash) 后立即重建 src (新写入)。
        await writeFile(
          String(p),
          "---\ntitle: RECREATED\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-02T00:00:00.000Z'\n---\nrecreated by host\n",
          'utf8',
        );
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 宿主重建的 src 不被覆盖, 报 failed, trash 保留供人工找回。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('recreated');
      const files = await readdir(dir);
      expect(files.some((f) => f.includes('cleanup-trash'))).toBe(true);
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('fails items whose source changed after plan (recheck before move)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // plan 后、run 前, 源被并发更新 (--force 场景) — 内容已非计划批准的重复项。
    await writeFile(
      path.join(dir, 'feedback_a.md'),
      "---\ntitle: NEW\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\ncompletely different\n",
      'utf8',
    );

    const result = await runMemoryCleanup(plan);
    // 源变更 → failed + 保留, 不归档非预期内容 (Codex P1 on #2561)。
    expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
    expect(result.archived).toHaveLength(0);
    await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('different');
  });

  it('fails stale archives whose source changed after review', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 用户审阅终态候选后、执行 --archive-stale 前文件被更新 — plan 已绑定
    // 审阅时点的 expectedHash, 新版本不应被归档 (Greptile P1 / Codex P1 on
    // #2561: 终态计划未绑定文件版本)。
    await writeFile(
      path.join(dir, 'project_done.md'),
      "---\ntitle: NEW\ndescription: new\ntype: project\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nactive now\n",
      'utf8',
    );

    const result = await runMemoryCleanup(plan, { archiveStale: true });
    expect(result.failed.some((f) => f.filename === 'project_done.md')).toBe(true);
    expect(result.archived).toHaveLength(0);
    await expect(readFile(path.join(dir, 'project_done.md'), 'utf8')).resolves.toContain('active');
  });

  it('surfaces non-ENOENT read errors as failed (not idempotent skip)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // readFile 抛 EACCES (真实 IO 错误) — 必须暴露为 failed, 不能伪装成
    // ENOENT 幂等跳过 (Codex P2 on #2561)。
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('restores source via copy fallback when hard links are unsupported', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟宿主在 rename 前写新内容 (trash ≠ 快照), 且文件系统不支持硬链接
    // (fs.link 抛 ENOTSUP) — restoreTrash 必须 fallback 到 copyFile 排他恢复,
    // 否则 src 保持缺失、记忆从 list()/MEMORY.md 消失 (Greptile P1 on #2561
    // 第十三轮: 硬链接失败后源文件缺失)。
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        await writeFile(
          String(src),
          "---\ntitle: NEW\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nUPDATED\n",
          'utf8',
        );
      }
      return realRename(src as string, dst as string);
    });
    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('link not supported'), { code: 'ENOTSUP' }));

    try {
      const result = await runMemoryCleanup(plan);
      // copyFile fallback 恢复: src 重新出现且持有新内容, 报 failed 不丢数据。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('UPDATED');
      expect((await archiveContents()).some((f) => f.startsWith('feedback_a.md'))).toBe(true);
      // copy fallback 恢复成功后 trash 也保留 (writer open fd 后续写入可达,
      // 不 unlink — Codex P1 on #2561 第十八轮: keep copied trash reachable)。
      const shardFiles = await readdir(dir);
      expect(shardFiles.some((f) => f.includes('cleanup-trash'))).toBe(true);
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it('keeps trash reachable in .archive after comparison passes (no unlink)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    await runMemoryCleanup(plan);

    // 对比通过后不 unlink 删除最后路径名 (open fd 可能随后写入 renamed inode)
    // — trash 被移入 .archive, 内容始终可达 (Codex P1 on #2561 第十三轮:
    // preserve trash until open-fd writers are impossible)。
    const shardFiles = await readdir(dir);
    expect(shardFiles.some((f) => f.includes('cleanup-trash'))).toBe(false);
    const archived = await archiveContents();
    // 快照 A (base 名) + trash 保留副本 (时间戳+随机后缀) 并存。
    const snapshots = archived.filter((f) => f.startsWith('feedback_a.md'));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.some((f) => f === 'feedback_a.md')).toBe(true);
    // trash 副本内容与快照 A 一致 (对比通过的同一份内容)。
    const snapshotContent = await readFile(path.join(dir, ARCHIVE_DIR_NAME, 'feedback_a.md'), 'utf8');
    for (const f of snapshots.filter((n) => n !== 'feedback_a.md')) {
      await expect(readFile(path.join(dir, ARCHIVE_DIR_NAME, f), 'utf8')).resolves.toBe(
        snapshotContent,
      );
    }
  });

  it('restores to active src when open-fd write lands after move (second check)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 open fd (storage.ts:294 writeFile) 在 trash 移入 .archive 后写入
    // retained inode: 第一次对比通过, 二次校验发现内容 ≠ 快照 → 新内容必须
    // 复制回活动 src 并 failed, 不能只落在 .archive 随机副本退出正常路径
    // (Codex P1 on #2561 第十四轮)。trash → retained 移动走 fs.link 排他预留。
    const realLink = fs.link.bind(fs);
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (
        String(dst).includes(ARCHIVE_DIR_NAME) &&
        String(src).includes('cleanup-trash') &&
        !String(dst).endsWith('.archive')
      ) {
        await writeFile(String(dst), 'WRITTEN AFTER MOVE BY OPEN FD', 'utf8');
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 新内容回活动 src (产品内可见), 报 failed, 归档保留审阅快照。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'WRITTEN AFTER MOVE',
      );
      const archived = await archiveContents();
      expect(archived.some((f) => f.startsWith('feedback_a.md'))).toBe(true);
      // 恢复成功后 retained 仍保留 (writer open fd 后续写入可达, 不 unlink —
      // Codex P1 on #2561 第十七轮: keep retained files until writers close)。
      expect(archived.some((f) => f.startsWith('feedback_a.md.'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps retained reachable when restore collides with a recreated src', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: open fd 在 move 后写 retained (二次校验不一致), 且宿主同时重建了
    // src — copyFile EXCL 恢复会 EEXIST, retained 必须保留 (open-fd 新内容
    // 不可因恢复失败被 unlink 删除, Greptile P1 / Codex P1 on #2561 第十五轮)。
    // link 路径: trash→retained (dst 含 .archive) 后写 retained; unlink 路径:
    // src→trash 的 unlink 后宿主重建 src。
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (
        String(dst).includes(ARCHIVE_DIR_NAME) &&
        String(src).includes('cleanup-trash') &&
        !String(dst).endsWith('.archive')
      ) {
        await writeFile(String(dst), 'WRITTEN AFTER MOVE BY OPEN FD', 'utf8');
      }
      return r;
    });
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (p) => {
      const r = await realUnlink(p as string);
      if (String(p).endsWith('feedback_a.md')) {
        // 宿主在 src 被 unlink (移入 trash) 后立即重建 src (新写入)。
        await writeFile(
          String(p),
          "---\ntitle: RECREATED\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-02T00:00:00.000Z'\n---\nrecreated by host\n",
          'utf8',
        );
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 恢复 EEXIST 失败 → retained 保留可达 (在 .archive), failed 记录。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'recreated',
      );
      const archived = await archiveContents();
      const retained = archived.find((f) => f.startsWith('feedback_a.md.'));
      expect(retained).toBeDefined();
      await expect(
        readFile(path.join(dir, ARCHIVE_DIR_NAME, retained as string), 'utf8'),
      ).resolves.toContain('WRITTEN AFTER MOVE');
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('surfaces unreadable retained as failed instead of reporting archived', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 Windows 锁: 二次校验 readFile(retained) 抛 EACCES — 不能当 null
    // 走成功分支 (src 已 rename 走、MEMORY.md 重建, writer 分片退出正常路径
    // 却报成功), 必须 failed + 保留 retained (Codex P1 on #2561 第十五轮)。
    // 只拦 .archive 下的 retained 读; trash 第一次对比读 (分片根目录) 保持正常,
    // 否则流程会走 restoreTrash 而非二次校验分支。
    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, ...rest) => {
      const str = String(p);
      if (str.includes(ARCHIVE_DIR_NAME)) {
        throw Object.assign(new Error('locked by writer'), { code: 'EACCES' });
      }
      return realReadFile(p as string, ...rest);
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 不标成功: archived 为空, 报 failed; retained 内容经 copyFile 恢复回
      // src (数据不丢, 活动分片可见)。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps retained reachable when restore fails with non-EEXIST error', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: open fd 在 move 后写 retained (二次校验不一致), 且 copyFile 恢复
    // 抛 EACCES (非 EEXIST) — 不能抛错 (外层 catch 只记 failed 会让活动分片
    // 缺失), retained 必须保留 .archive 可达 (Greptile P1 on #2561 第十六轮:
    // 恢复失败后活动分片缺失)。trash → retained 移动走 fs.link 排他预留。
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (
        String(dst).includes(ARCHIVE_DIR_NAME) &&
        String(src).includes('cleanup-trash') &&
        !String(dst).endsWith('.archive')
      ) {
        await writeFile(String(dst), 'WRITTEN AFTER MOVE BY OPEN FD', 'utf8');
      }
      return r;
    });
    const copySpy = vi
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    try {
      const result = await runMemoryCleanup(plan);
      // 不抛错: failed + retained 保留在 .archive (新内容可达), 数据不丢。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      const archived = await archiveContents();
      const retained = archived.find((f) => f.startsWith('feedback_a.md.'));
      expect(retained).toBeDefined();
      await expect(
        readFile(path.join(dir, ARCHIVE_DIR_NAME, retained as string), 'utf8'),
      ).resolves.toContain('WRITTEN AFTER MOVE');
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it('runs a third check before marking archived (reread catches late write)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: 二次校验读 retained 时内容仍 = 快照 (通过), 但三次确认 (标
    // archived 前的最终读) 发现 open fd 已写入新内容 — 必须恢复 src + failed,
    // 不能标 archived (Codex P1 on #2561 第十六轮: keep active shards until
    // live writers are ruled out)。
    const realReadFile = fs.readFile.bind(fs);
    let retainedReads = 0;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, ...rest) => {
      const str = String(p);
      if (str.includes(ARCHIVE_DIR_NAME) && !str.endsWith('.archive')) {
        retainedReads += 1;
        if (retainedReads === 2) {
          // 三次确认 (标 archived 前的最终读) 之前, writer 真实写入 retained —
          // copyFile 恢复读到的是磁盘真实内容。
          await writeFile(String(p), 'WRITTEN AFTER REREAD BY OPEN FD', 'utf8');
        }
      }
      return realReadFile(p as string, ...rest);
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 三次确认发现写入 → 恢复 src + failed, 不标成功。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'WRITTEN AFTER REREAD',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
