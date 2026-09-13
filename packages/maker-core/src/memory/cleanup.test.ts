/**
 * cleanup.test.ts — P0.5 分片内清理 (cleanup.ts) 单测。
 *
 * 覆盖: 完全重复自动去重、近似重复仅报告、终态候选(信号/弱信号/时间)仅报告、
 * archiveStale 显式归档、user/feedback 不判定终态、digest 保留最新 N、归档幂等、
 * 归档/备份同名冲突循环后缀 (含同 clock rerun)。
 */

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_DIR_NAME,
  acquireCleanupExclusiveLock,
  bindReviewedStaleCandidates,
  CleanupLockError,
  parseReviewedStalePlan,
  planMemoryCleanup,
  releaseCleanupExclusiveLock,
  runMemoryCleanup,
  staleSetFingerprint,
} from './cleanup.js';
import { CLEANUP_EXCLUSIVE_LOCK_DIR, MemoryStorage } from './storage.js';
import { MemoryError } from './types.js';

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

  it('ranks duplicate keep by chronological updatedAt not lexicographic ISO', async () => {
    // `...T12:00:00Z` 字典序晚于 `...T09:00:00-08:00`, 但后者实际更新 (17:00Z)。
    await shard(
      'feedback_lex.md',
      'feedback',
      'Same',
      'same hook',
      'same body',
      '2026-01-01T12:00:00Z',
    );
    await shard(
      'feedback_tz.md',
      'feedback',
      'Same',
      'same hook',
      'same body',
      '2026-01-01T09:00:00-08:00',
    );

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].keep).toBe('feedback_tz.md');
    expect(plan.duplicates[0].archive).toEqual(['feedback_lex.md']);
  });

  it('ranks unquoted YAML Date updatedAt from raw frontmatter not scan-time now', async () => {
    // gray-matter 把未加引号的 ISO 解析成 Date; parseRawShard 会写成 now。
    // 排名必须读 raw frontmatter, 否则后扫描的旧分片会被当成更新。
    await writeFile(
      path.join(dir, 'feedback_newer.md'),
      [
        '---',
        'title: Same',
        'description: same hook',
        'type: feedback',
        'updatedAt: 2026-03-01T00:00:00.000Z',
        '---',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'feedback_older.md'),
      [
        '---',
        'title: Same',
        'description: same hook',
        'type: feedback',
        'updatedAt: 2026-01-01T00:00:00.000Z',
        '---',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].keep).toBe('feedback_newer.md');
    expect(plan.duplicates[0].archive).toEqual(['feedback_older.md']);
  });

  it('ranks YAML Date updatedAt with an inline comment via the YAML parser', async () => {
    // `updatedAt: 2026-01-01T00:00:00Z # verified` 合法 YAML, gray-matter
    // 解成 Date; raw-line regex 因注释失败后会回落到 scan-time now,
    // 后扫描的旧分片会被当成更新 (Codex P1 on #2561: Parse commented
    // timestamps with the YAML parser)。
    await writeFile(
      path.join(dir, 'feedback_newer.md'),
      [
        '---',
        'title: Same',
        'description: same hook',
        'type: feedback',
        'updatedAt: 2026-03-01T00:00:00Z',
        '---',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'feedback_older.md'),
      [
        '---',
        'title: Same',
        'description: same hook',
        'type: feedback',
        'updatedAt: 2026-01-01T00:00:00Z # verified',
        '---',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].keep).toBe('feedback_newer.md');
    expect(plan.duplicates[0].archive).toEqual(['feedback_older.md']);
  });

  it('binds expectedHash to the same classified bytes including updatedAt', async () => {
    await shard('feedback_rule_a.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-01-01T00:00:00.000Z');
    await shard('feedback_rule_b.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.archiveItems).toHaveLength(1);
    const raw = await readFile(path.join(dir, 'feedback_rule_a.md'));
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(plan.archiveItems[0].expectedHash).toBe(expected);
  });

  it('fails apply when only updatedAt was refreshed after plan', async () => {
    await shard('feedback_rule_a.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-01-01T00:00:00.000Z');
    await shard('feedback_rule_b.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    await shard('feedback_rule_a.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-04-01T00:00:00.000Z');
    const result = await runMemoryCleanup(plan);
    expect(result.archived).toHaveLength(0);
    expect(result.failed.some((f) => f.filename === 'feedback_rule_a.md')).toBe(true);
    await expect(readFile(path.join(dir, 'feedback_rule_a.md'), 'utf8')).resolves.toContain(
      '2026-04-01T00:00:00.000Z',
    );
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

  it('does not report exact duplicates as near-duplicates', async () => {
    await shard('feedback_rule_a.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-01-01T00:00:00.000Z');
    await shard('feedback_rule_b.md', 'feedback', 'PR polling rule', 'same hook', 'same body',
      '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.nearDuplicates).toHaveLength(0);
  });

  it('reports near-duplicates when same title has at least two content hashes', async () => {
    await shard('project_a.md', 'project', 'Same title', 'hook', 'same body',
      '2026-01-01T00:00:00.000Z');
    await shard('project_b.md', 'project', 'Same title', 'hook', 'same body',
      '2026-02-01T00:00:00.000Z');
    await shard('project_c.md', 'project', 'Same title', 'hook', 'different body',
      '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.nearDuplicates).toHaveLength(1);
    expect(plan.nearDuplicates[0].filenames.sort()).toEqual([
      'project_a.md',
      'project_b.md',
      'project_c.md',
    ]);
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

  it('classifies unquoted YAML Date updatedAt as age-stale from raw frontmatter', async () => {
    // gray-matter 把未加引号 ISO 解成 Date; parseRawShard 会写成 now。
    // stale-age 必须读 raw, 否则真正旧分片永远报不成 age。
    await writeFile(
      path.join(dir, 'project_oldunquoted.md'),
      [
        '---',
        'title: Old',
        'description: hook',
        'type: project',
        'updatedAt: 2020-01-01T00:00:00.000Z',
        '---',
        'no signal',
        '',
      ].join('\n'),
      'utf8',
    );
    const plan = await planMemoryCleanup(dir, {
      deps: { now: () => '2026-06-01T00:00:00.000Z' },
    });
    const hit = plan.staleCandidates.find((c) => c.filename === 'project_oldunquoted.md');
    expect(hit?.reason).toBe('age');
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('classifies YAML Date updatedAt with an inline comment as age-stale', async () => {
    await writeFile(
      path.join(dir, 'project_oldcomment.md'),
      [
        '---',
        'title: Old',
        'description: hook',
        'type: project',
        'updatedAt: 2020-01-01T00:00:00Z # verified',
        '---',
        'no signal',
        '',
      ].join('\n'),
      'utf8',
    );
    const plan = await planMemoryCleanup(dir, {
      deps: { now: () => '2026-06-01T00:00:00.000Z' },
    });
    const hit = plan.staleCandidates.find((c) => c.filename === 'project_oldcomment.md');
    expect(hit?.reason).toBe('age');
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
    expect(plan.archiveItems[0].digestKeep?.map((k) => k.filename).sort()).toEqual(
      ['digest_mid.md', 'digest_new.md'].sort(),
    );
  });

  it('reconciles duplicate digests before binding retention keepers', async () => {
    // keep=2: 最新两条语义相同 (dup_new/dup_old) + 两条更旧 unique。
    // 未对账时 digestKeep 含 dup_old, run 先 duplicate 归档它, 后续
    // retention 会 keeper 失败、更旧 digest 留在活动分片
    // (Codex P1 on #2561: Reconcile duplicate digests before binding
    // retention keepers)。
    await shard('digest_a.md', 'digest', 'A', 'hook', 'a', '2026-01-01T00:00:00.000Z');
    await shard('digest_b.md', 'digest', 'B', 'hook', 'b', '2026-02-01T00:00:00.000Z');
    await shard('digest_dup_old.md', 'digest', 'Dup', 'hook', 'same', '2026-03-01T00:00:00.000Z');
    await shard('digest_dup_new.md', 'digest', 'Dup', 'hook', 'same', '2026-04-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].keep).toBe('digest_dup_new.md');
    expect(plan.duplicates[0].archive).toEqual(['digest_dup_old.md']);
    expect(plan.digests.keep).toEqual(['digest_dup_new.md', 'digest_b.md']);
    expect(plan.digests.archive).toEqual(['digest_a.md']);
    expect(
      plan.archiveItems.find((i) => i.reason === 'digest-retention')?.digestKeep?.map((k) => k.filename),
    ).toEqual(['digest_dup_new.md', 'digest_b.md']);

    const result = await runMemoryCleanup(plan);
    expect(result.failed).toHaveLength(0);
    expect(result.archived.map((a) => a.filename).sort()).toEqual(
      ['digest_a.md', 'digest_dup_old.md'].sort(),
    );
    await expect(readFile(path.join(dir, 'digest_dup_new.md'), 'utf8')).resolves.toContain('same');
    await expect(readFile(path.join(dir, 'digest_b.md'), 'utf8')).resolves.toContain('b');
  });

  it('ranks digest keep by chronological updatedAt not lexicographic ISO', async () => {
    // `...T12:00:00Z` 字典序晚于 `...T09:00:00-08:00`, 但后者实际更新 (17:00Z)。
    await shard('digest_lex.md', 'digest', 'Lex', 'hook', 'lex', '2026-01-01T12:00:00Z');
    await shard('digest_tz.md', 'digest', 'Tz', 'hook', 'tz', '2026-01-01T09:00:00-08:00');

    const plan = await planMemoryCleanup(dir, { keepDigests: 1 });
    expect(plan.digests.keep).toEqual(['digest_tz.md']);
    expect(plan.digests.archive).toEqual(['digest_lex.md']);
  });

  it('does not prune a non-digest filename whose frontmatter type is digest', async () => {
    await shard('digest_a.md', 'digest', 'A', 'hook', 'a', '2026-01-01T00:00:00.000Z');
    await shard('digest_b.md', 'digest', 'B', 'hook', 'b', '2026-02-01T00:00:00.000Z');
    await shard('digest_c.md', 'digest', 'C', 'hook', 'c', '2026-03-01T00:00:00.000Z');
    await writeFile(
      path.join(dir, 'project_notes.md'),
      [
        '---',
        'title: Notes',
        'description: hook',
        'type: digest',
        "updatedAt: '2026-04-01T00:00:00.000Z'",
        '---',
        'mismatched type',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planMemoryCleanup(dir, { keepDigests: 2 });
    expect(plan.digests.keep).toEqual(['digest_c.md', 'digest_b.md']);
    expect(plan.digests.archive).toEqual(['digest_a.md']);
    expect(plan.digests.keep).not.toContain('project_notes.md');
    expect(plan.digests.archive).not.toContain('project_notes.md');
    expect(plan.archiveItems.some((i) => i.filename === 'project_notes.md')).toBe(false);
  });

  it('excludes digests whose updatedAt is only in the body or invalid', async () => {
    await shard('digest_old.md', 'digest', 'Digest 1', 'hook', 'old', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(dir, 'digest_body_ts.md'),
      '---\ntitle: Body TS\ndescription: hook\ntype: digest\n---\nupdatedAt: 2026-09-01T00:00:00.000Z\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'digest_bad_ts.md'),
      "---\ntitle: Bad TS\ndescription: hook\ntype: digest\nupdatedAt: not-a-date\n---\nbody\n",
      'utf8',
    );

    const plan = await planMemoryCleanup(dir);
    expect(plan.digests.keep).toEqual(['digest_old.md']);
    expect(plan.digests.archive).toEqual([]);
    expect(plan.archiveItems).toHaveLength(0);
  });

  it('excludes digests without updatedAt from retention pruning', async () => {
    // 缺 updatedAt 的 digest 会被 parseRawShard 每次读填当前时间 — 按解析时刻
    // 排序会误归档实际最新的 digest (Codex P1 on #2561 第二十九轮)。
    await shard('digest_old.md', 'digest', 'Digest 1', 'hook', 'old', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(dir, 'digest_nots.md'),
      '---\ntitle: No TS\ndescription: hook\ntype: digest\n---\nbody\n',
      'utf8',
    );

    const plan = await planMemoryCleanup(dir);
    // 无时间戳 digest 不参与精简: 不进 keep 也不进 archive (仅报告)。
    expect(plan.digests.keep).toEqual(['digest_old.md']);
    expect(plan.digests.archive).toEqual([]);
    expect(plan.archiveItems).toHaveLength(0);
  });
});

describe('runMemoryCleanup', () => {
  it('fails duplicate archive when keeper changed since plan', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 plan 后宿主更新保留副本 (keep) — 重复组不再成立, 归档待删副本会
    // 让最后一份已审阅内容退出正常路径, 必须 failed 要求重新规划
    // (Codex P1 on #2561 第二十九轮: 同时校验重复组的保留副本)。
    await writeFile(
      path.join(dir, 'feedback_b.md'),
      "---\ntitle: CHANGED\ndescription: new\ntype: feedback\nupdatedAt: '2026-04-01T00:00:00.000Z'\n---\nchanged by host\n",
      'utf8',
    );

    const result = await runMemoryCleanup(plan);
    expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
    expect(result.archived).toHaveLength(0);
    // 待删副本仍留在活动分片 (未归档)。
    await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
  });

  it('fails duplicate archive when keeper was deleted since plan', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    await unlink(path.join(dir, 'feedback_b.md')); // plan 后宿主删除 keep

    const result = await runMemoryCleanup(plan);
    expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
    expect(result.archived).toHaveLength(0);
  });

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
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      const r = await realRename(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-parked')) {
        // 宿主在 src 被 park 走后立即重建 src (新写入)。
        await writeFile(
          String(src),
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
      renameSpy.mockRestore();
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
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      const r = await realRename(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-parked')) {
        // 宿主在 src 被 park 走后立即重建 src (新写入)。
        await writeFile(
          String(src),
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
      renameSpy.mockRestore();
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
    // rename 兜底也失败 (真锁) → retained 保留 .archive 可达。
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (String(dst).includes('cleanup-parked') || String(src).includes('cleanup-parked')) {
        return realRename(src as string, dst as string);
      }
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });

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
      renameSpy.mockRestore();
    }
  });

  it('does not rename retained over src recreated by the host', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (
        String(dst).includes(ARCHIVE_DIR_NAME) &&
        String(src).includes('cleanup-trash') &&
        !String(dst).endsWith('.archive')
      ) {
        await writeFile(String(dst), 'WRITTEN AFTER MOVE BY OPEN FD', 'utf8');
        await writeFile(
          path.join(dir, 'feedback_a.md'),
          "---\ntitle: HOST\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nHOST RECREATED\n",
          'utf8',
        );
      }
      return r;
    });
    const copySpy = vi
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const renameSpy = vi.spyOn(fs, 'rename');

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'HOST RECREATED',
      );
      expect(
        renameSpy.mock.calls.some(
          (call) => String(call[1]).endsWith('feedback_a.md') && String(call[0]).includes('.archive'),
        ),
      ).toBe(false);
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('restores retained to src via exclusive link when copy restore fails', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
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
      .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'WRITTEN AFTER MOVE',
      );
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

  it('fails cleanup when unlink leaves the source active', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟 Windows 文件锁: reserveTrashTarget 的 link (src → trash) 成功,
    // 但 park/rename(src) 抛 EPERM — src 仍在活动分片, 必须 failed 而非吞错标
    // archived (否则 rebuildIndex 仍把 src 写回 MEMORY.md, CLI 误报成功;
    // Greptile P1 / Codex P1 on #2561 第二十三轮)。
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-parked')) {
        throw Object.assign(new Error('source locked'), { code: 'EPERM' });
      }
      return realRename(src as string, dst as string);
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 不标成功: failed + src 保留在活动分片。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('does not unlink a replacement inode reserved after trash link', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟编辑器原子保存: link(src → trash) 成功后、park/rename 前用 rename
    // 把新 inode 换到 src。pathname unlink(src) 会删掉新 inode; park 后按
    // inode/内容核对, 只丢掉预留 trash inode, 新写入必须回到 src。
    const realLink = fs.link.bind(fs);
    const realRename = fs.rename.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink');
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        const tmp = `${String(src)}.editor-tmp`;
        await writeFile(
          tmp,
          "---\ntitle: REPLACEMENT\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nREPLACEMENT INODE\n",
          'utf8',
        );
        await realRename(tmp, String(src));
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'REPLACEMENT INODE',
      );
      expect(
        unlinkSpy.mock.calls.every((call) => !String(call[0]).endsWith('feedback_a.md')),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('does not treat leftover nlink as proof parked is the reserved inode', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 上次 restoreRetained 留下的硬链接: reserved nlink>=2, 但 parked 是编辑器
    // 原子替换后的新 inode。不得因 nlink 把 parked 当成 reserved 并 unlink。
    const leftover = path.join(dir, 'feedback_a.md.retained-leftover');
    await fs.link(path.join(dir, 'feedback_a.md'), leftover);
    const realLink = fs.link.bind(fs);
    const realRename = fs.rename.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink');
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        const tmp = `${String(src)}.editor-tmp`;
        await writeFile(
          tmp,
          "---\ntitle: REPLACEMENT\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nREPLACEMENT DESPITE NLINK\n",
          'utf8',
        );
        await realRename(tmp, String(src));
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'REPLACEMENT DESPITE NLINK',
      );
      expect(
        unlinkSpy.mock.calls.every((call) => !String(call[0]).endsWith('feedback_a.md')),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
      await unlink(leftover).catch(() => {});
    }
  });

  it('does not treat equal bytes as reserved when POSIX inodes differ', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const original = await readFile(path.join(dir, 'feedback_a.md'));
    const realLink = fs.link.bind(fs);
    const realRename = fs.rename.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink');
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      const r = await realLink(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        const tmp = `${String(src)}.editor-tmp`;
        await writeFile(tmp, original);
        await realRename(tmp, String(src));
      }
      return r;
    });
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      const st = await realLstat(p as string);
      const pathStr = String(p);
      if (pathStr.includes('cleanup-parked')) {
        return Object.assign(st, { ino: 111, dev: 1 });
      }
      if (pathStr.includes('cleanup-trash')) {
        return Object.assign(st, { ino: 222, dev: 1 });
      }
      return st;
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
      expect(
        unlinkSpy.mock.calls.every((call) => !String(call[0]).endsWith('feedback_a.md')),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      lstatSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('restores replacement parked to src via exclusive copy when hard links fail', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const realLink = fs.link.bind(fs);
    const realRename = fs.rename.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlink');
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
      }
      const r = await realLink(src as string, dst as string);
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        const tmp = `${String(src)}.editor-tmp`;
        await writeFile(
          tmp,
          "---\ntitle: REPLACEMENT\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nREPLACEMENT INODE\n",
          'utf8',
        );
        await realRename(tmp, String(src));
      }
      return r;
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'REPLACEMENT INODE',
      );
      const names = await readdir(dir);
      const parked = names.filter((n) => n.includes('cleanup-parked'));
      expect(parked.length).toBeGreaterThan(0);
      const parkedRaws = await Promise.all(
        parked.map((n) => readFile(path.join(dir, n), 'utf8')),
      );
      expect(parkedRaws.some((raw) => raw.includes('REPLACEMENT INODE'))).toBe(true);
      expect(
        unlinkSpy.mock.calls.every((call) => !String(call[0]).endsWith('feedback_a.md')),
      ).toBe(true);
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('restores parked src before retrying after a transient lstat failure', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // park 成功后第一次 lstat(parked) 抛 EACCES, 必须把 parked 移回 src 再重试,
    // 不能留下 src 空 + .cleanup-parked-* 被 rebuildIndex 忽略。
    const realLstat = fs.lstat.bind(fs);
    let failedOnce = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      if (!failedOnce && String(p).includes('cleanup-parked')) {
        failedOnce = true;
        throw Object.assign(new Error('transient lock'), { code: 'EACCES' });
      }
      return realLstat(p as string);
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(failedOnce).toBe(true);
      const names = await readdir(dir);
      expect(names.some((n) => n.includes('cleanup-parked'))).toBe(false);
      expect(result.failed).toHaveLength(0);
      expect(result.archived.map((a) => a.filename)).toContain('feedback_a.md');
      const archived = await readdir(path.join(dir, ARCHIVE_DIR_NAME));
      expect(archived.some((n) => n.startsWith('feedback_a.md'))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('does not retry cleanup after restoring parked by exclusive copy', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const realLstat = fs.lstat.bind(fs);
    const realLink = fs.link.bind(fs);
    let failedOnce = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      if (!failedOnce && String(p).includes('cleanup-parked')) {
        failedOnce = true;
        throw Object.assign(new Error('transient lock'), { code: 'EACCES' });
      }
      return realLstat(p as string);
    });
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
      }
      return realLink(src as string, dst as string);
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(failedOnce).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain('same');
      const names = await readdir(dir);
      const parked = names.filter((n) => n.includes('cleanup-parked'));
      expect(parked.length).toBeGreaterThan(0);
      const parkedRaws = await Promise.all(
        parked.map((n) => readFile(path.join(dir, n), 'utf8')),
      );
      expect(parkedRaws.some((raw) => raw.includes('same'))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it('skips MEMORY.md rebuild when parked restore cannot recreate src', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    const storage = new MemoryStorage(dir);
    await storage.rebuildIndex();
    const before = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(before).toContain('feedback_a.md');

    const plan = await planMemoryCleanup(dir);
    const realLstat = fs.lstat.bind(fs);
    const realLink = fs.link.bind(fs);
    const realCopy = fs.copyFile.bind(fs);
    let failedOnce = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      if (!failedOnce && String(p).includes('cleanup-parked')) {
        failedOnce = true;
        throw Object.assign(new Error('transient lock'), { code: 'EACCES' });
      }
      return realLstat(p as string);
    });
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
      }
      return realLink(src as string, dst as string);
    });
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realCopy(src as string, dst as string, mode as number);
    });
    const rebuildSpy = vi.spyOn(MemoryStorage.prototype, 'rebuildIndex');

    try {
      const result = await runMemoryCleanup(plan);
      expect(failedOnce).toBe(true);
      expect(result.skipIndexRebuild).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const names = await readdir(dir);
      const parked = names.filter((n) => n.includes('cleanup-parked'));
      expect(parked.length).toBeGreaterThan(0);
      expect(rebuildSpy).not.toHaveBeenCalled();
      await expect(readFile(path.join(dir, 'MEMORY.md'), 'utf8')).resolves.toBe(before);
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
      copySpy.mockRestore();
      rebuildSpy.mockRestore();
    }
  });

  it('skips MEMORY.md rebuild when retained restore cannot recreate src', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');
    const storage = new MemoryStorage(dir);
    await storage.rebuildIndex();
    const before = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(before).toContain('feedback_a.md');

    const plan = await planMemoryCleanup(dir);
    const realReadFile = fs.readFile.bind(fs);
    const realCopy = fs.copyFile.bind(fs);
    const realLink = fs.link.bind(fs);
    let retainedReads = 0;
    const isRetainedRestore = (src: unknown, dst: unknown): boolean =>
      String(src).includes(ARCHIVE_DIR_NAME) && String(dst).endsWith('feedback_a.md');
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, ...rest) => {
      const str = String(p);
      if (str.includes(ARCHIVE_DIR_NAME) && !str.endsWith('.archive')) {
        retainedReads += 1;
        if (retainedReads === 1) {
          await writeFile(String(p), 'WRITTEN DURING RETAINED CHECK', 'utf8');
        }
      }
      return realReadFile(p as string, ...rest);
    });
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (isRetainedRestore(src, dst)) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realCopy(src as string, dst as string, mode as number);
    });
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (isRetainedRestore(src, dst)) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
      }
      return realLink(src as string, dst as string);
    });
    const rebuildSpy = vi.spyOn(MemoryStorage.prototype, 'rebuildIndex');

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.skipIndexRebuild).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(rebuildSpy).not.toHaveBeenCalled();
      await expect(readFile(path.join(dir, 'MEMORY.md'), 'utf8')).resolves.toBe(before);
    } finally {
      readSpy.mockRestore();
      copySpy.mockRestore();
      linkSpy.mockRestore();
      rebuildSpy.mockRestore();
    }
  });

  it('does not unlink parked when src already exists after a transient identity failure', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // park 后身份检查瞬态失败; 此时编辑器已重建 src。restoreParkedSource 不得
    // 仅凭 src 存在就 unlink parked (parked 可能是未审阅替换的唯一 inode)。
    const realLstat = fs.lstat.bind(fs);
    let failedOnce = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      if (!failedOnce && String(p).includes('cleanup-parked')) {
        failedOnce = true;
        await writeFile(
          path.join(dir, 'feedback_a.md'),
          "---\ntitle: Recreated\ndescription: host\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nHOST RECREATED SRC\n",
          'utf8',
        );
        throw Object.assign(new Error('transient lock'), { code: 'EACCES' });
      }
      return realLstat(p as string);
    });
    try {
      const result = await runMemoryCleanup(plan);
      expect(failedOnce).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'HOST RECREATED SRC',
      );
      const names = await readdir(dir);
      const parked = names.filter((n) => n.includes('cleanup-parked'));
      expect(parked.length).toBeGreaterThan(0);
      const parkedRaws = await Promise.all(
        parked.map((n) => readFile(path.join(dir, n), 'utf8')),
      );
      expect(parkedRaws.some((raw) => raw.includes('same'))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('does not rename-clobber src recreated during parked restore', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    const realLstat = fs.lstat.bind(fs);
    const realLink = fs.link.bind(fs);
    const realCopy = fs.copyFile.bind(fs);
    const realRename = fs.rename.bind(fs);
    let failedOnce = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
      if (!failedOnce && String(p).includes('cleanup-parked')) {
        failedOnce = true;
        throw Object.assign(new Error('transient lock'), { code: 'EACCES' });
      }
      return realLstat(p as string);
    });
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw new Error('parked restore must not POSIX-rename over src');
      }
      return realRename(src as string, dst as string);
    });
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        await writeFile(
          dst as string,
          "---\ntitle: Recreated\ndescription: host\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nTOCTOU SRC\n",
          'utf8',
        );
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      return realLink(src as string, dst as string);
    });
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (String(src).includes('cleanup-parked') && String(dst).endsWith('feedback_a.md')) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      return realCopy(src as string, dst as string, mode as number);
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(failedOnce).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'TOCTOU SRC',
      );
      const names = await readdir(dir);
      const parked = names.filter((n) => n.includes('cleanup-parked'));
      expect(parked.length).toBeGreaterThan(0);
      const parkedRaws = await Promise.all(
        parked.map((n) => readFile(path.join(dir, n), 'utf8')),
      );
      expect(parkedRaws.some((raw) => raw.includes('same'))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it('restores src when a write lands during the quiesce window', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: 二次校验 (第 1 次读) 与三次确认 (第 2 次读) 都通过, 但 quiesce
    // 重试确认窗口 (第 3 次读) 中 open fd 写入 retained — 必须恢复 src + failed,
    // 不标成功 (Codex P1 on #2561 第二十四轮: keep live-writer shards active
    // until quiesced)。
    const realReadFile = fs.readFile.bind(fs);
    let retainedReads = 0;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, ...rest) => {
      const str = String(p);
      if (str.includes(ARCHIVE_DIR_NAME) && !str.endsWith('.archive')) {
        retainedReads += 1;
        if (retainedReads === 3) {
          await writeFile(String(p), 'WRITTEN DURING QUIESCE BY OPEN FD', 'utf8');
        }
      }
      return realReadFile(p as string, ...rest);
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived).toHaveLength(0);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'WRITTEN DURING QUIESCE',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('re-reads after the final quiescence delay before marking archived', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 二次校验 + 三次确认 + quiesce 三轮读都通过; 最后一次 10ms sleep
    // 期间写入。必须再读一次, 否则会标 archived, 新内容只留在 archive 名下
    // (Codex P1 on #2561: Re-read after the final quiescence delay)。
    const realReadFile = fs.readFile.bind(fs);
    let retainedReads = 0;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, ...rest) => {
      const str = String(p);
      if (str.includes(ARCHIVE_DIR_NAME) && !str.endsWith('.archive')) {
        retainedReads += 1;
        if (retainedReads === 6) {
          await writeFile(String(p), 'WRITTEN AFTER FINAL QUIESCE DELAY', 'utf8');
        }
      }
      return realReadFile(p as string, ...rest);
    });

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(false);
      await expect(readFile(path.join(dir, 'feedback_a.md'), 'utf8')).resolves.toContain(
        'WRITTEN AFTER FINAL QUIESCE DELAY',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('fails when duplicate keeper ranking timestamp changes after plan', async () => {
    await shard('feedback_old.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_keep.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    expect(plan.duplicates[0].keep).toBe('feedback_keep.md');
    expect(plan.archiveItems[0].keep?.expectedHash).toMatch(/^[0-9a-f]{64}$/);

    await shard('feedback_keep.md', 'feedback', 'Same', 'hook', 'same', '2026-04-01T00:00:00.000Z');
    const result = await runMemoryCleanup(plan);
    expect(result.failed.some((f) => f.filename === 'feedback_old.md')).toBe(true);
    expect(result.archived).toHaveLength(0);
    await expect(readFile(path.join(dir, 'feedback_old.md'), 'utf8')).resolves.toContain('same');
  });

  it('keeps trash reachable when link and copy restore both fail (no rename clobber)', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: 源在归档期间变化 (trash ≠ 快照), 且硬链接恢复 (link ENOTSUP) 与
    // 排他复制恢复 (copyFile ENOSPC) 都失败 — 不再 rename 兜底, 以免覆盖
    // 窗口内重建的 src (Codex P1 on #2561: atomic protect live shard)。
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        await writeFile(
          String(src),
          "---\ntitle: NEW\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nUPDATED\n",
          'utf8',
        );
        return realLink(src as string, dst as string);
      }
      throw Object.assign(new Error('link not supported'), { code: 'ENOTSUP' });
    });
    const copySpy = vi
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

    try {
      const result = await runMemoryCleanup(plan);
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      const files = await readdir(dir);
      expect(files.some((f) => f.includes('cleanup-trash'))).toBe(true);
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it('fails digest archive when a keep digest changed since plan', async () => {
    await shard('digest_old.md', 'digest', 'Digest 1', 'hook', 'old', '2026-01-01T00:00:00.000Z');
    await shard('digest_mid.md', 'digest', 'Digest 2', 'hook', 'mid', '2026-02-01T00:00:00.000Z');
    await shard('digest_new.md', 'digest', 'Digest 3', 'hook', 'new', '2026-03-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    await writeFile(
      path.join(dir, 'digest_new.md'),
      "---\ntitle: Digest 3\ndescription: hook\ntype: digest\nupdatedAt: '2026-04-01T00:00:00.000Z'\n---\nchanged keep\n",
      'utf8',
    );

    const result = await runMemoryCleanup(plan);
    expect(result.archived).toHaveLength(0);
    expect(result.failed.some((f) => f.filename === 'digest_old.md')).toBe(true);
    await expect(readFile(path.join(dir, 'digest_old.md'), 'utf8')).resolves.toContain('old');
  });

  it('keeps trash reachable when link, copy, and rename restore all fail', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟: link ENOTSUP + copyFile ENOSPC + rename EPERM (真锁) 全部失败 —
    // trash 保留原位 (磁盘可达、供人工找回), failed 如实报告, 不抛错。
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      if (String(src).endsWith('feedback_a.md') && String(dst).includes('cleanup-trash')) {
        await writeFile(
          String(src),
          "---\ntitle: NEW\ndescription: new\ntype: feedback\nupdatedAt: '2026-03-01T00:00:00.000Z'\n---\nUPDATED\n",
          'utf8',
        );
        return realLink(src as string, dst as string);
      }
      throw Object.assign(new Error('link not supported'), { code: 'ENOTSUP' });
    });
    const copySpy = vi
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (String(dst).includes('cleanup-parked') || String(src).includes('cleanup-parked')) {
        return realRename(src as string, dst as string);
      }
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 全路径失败: 不抛错, failed + trash 保留可达。
      expect(result.failed.some((f) => f.filename === 'feedback_a.md')).toBe(true);
      const files = await readdir(dir);
      expect(files.some((f) => f.includes('cleanup-trash'))).toBe(true);
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('retries fallback rename when the trash target already exists', async () => {
    await shard('feedback_a.md', 'feedback', 'Same', 'hook', 'same', '2026-01-01T00:00:00.000Z');
    await shard('feedback_b.md', 'feedback', 'Same', 'hook', 'same', '2026-02-01T00:00:00.000Z');

    const plan = await planMemoryCleanup(dir);
    // 模拟硬链接不可用 (link ENOTSUP → fallback rename), 且 fallback 探测时
    // 第一个候选路径「已存在」(失败清理遗留) — 必须换后缀重试而非覆盖遗留
    // 恢复文件 (Codex P2 on #2561 第二十五轮: reserve fallback trash moves
    // exclusively)。
    const linkSpy = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('link not supported'), { code: 'ENOTSUP' }));
    const realStat = fs.stat.bind(fs);
    let trashProbes = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
      const str = String(p);
      if (str.includes('cleanup-trash')) {
        trashProbes += 1;
        if (trashProbes === 1) {
          // 第一个候选「已存在」(失败清理遗留的恢复文件) → pathExists true
          // → reserveTrashTarget 换后缀重试, 不覆盖。
          return { isFile: () => true, isDirectory: () => false } as never;
        }
        if (trashProbes === 2) {
          // 第二个候选不存在 → pathExists false → 允许 rename。
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        }
      }
      return realStat(p as string);
    });

    try {
      const result = await runMemoryCleanup(plan);
      // 换后缀重试后归档成功 (不覆盖遗留, 不抛错)。
      expect(result.failed).toHaveLength(0);
      expect(result.archived.some((a) => a.filename === 'feedback_a.md')).toBe(true);
    } finally {
      linkSpy.mockRestore();
      statSpy.mockRestore();
    }
  });
});

describe('storage list I/O vs corrupt shards (Codex P1 on #2561)', () => {
  it('throws io-error from list/listWithRaw when a shard is unreadable', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    const storage = new MemoryStorage(dir);
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    try {
      await expect(storage.list()).rejects.toMatchObject({ code: 'io-error' });
      await expect(storage.listWithRaw()).rejects.toMatchObject({ code: 'io-error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('still skips determined frontmatter parse errors', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    await writeFile(path.join(dir, 'project_bad.md'), 'not a shard\n', 'utf8');
    const storage = new MemoryStorage(dir);
    const recs = await storage.list();
    expect(recs.map((r) => r.filename)).toEqual(['project_ok.md']);
    const withRaw = await storage.listWithRaw();
    expect(withRaw.map((x) => x.rec.filename)).toEqual(['project_ok.md']);
  });

  it('skips non-string YAML title/description as corrupt instead of TypeError', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(dir, 'project_numtitle.md'),
      [
        '---',
        'title: 123',
        'description: hook',
        'type: project',
        "updatedAt: '2026-01-01T00:00:00.000Z'",
        '---',
        'body',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'project_booltitle.md'),
      [
        '---',
        'title: true',
        'description: hook',
        'type: project',
        "updatedAt: '2026-01-01T00:00:00.000Z'",
        '---',
        'body',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'project_numdesc.md'),
      [
        '---',
        'title: Ok',
        'description: 456',
        'type: project',
        "updatedAt: '2026-01-01T00:00:00.000Z'",
        '---',
        'body',
        '',
      ].join('\n'),
      'utf8',
    );
    const storage = new MemoryStorage(dir);
    const recs = await storage.list();
    expect(recs.map((r) => r.filename)).toEqual(['project_ok.md']);
    const withRaw = await storage.listWithRaw();
    expect(withRaw.map((x) => x.rec.filename)).toEqual(['project_ok.md']);
    await expect(planMemoryCleanup(dir)).resolves.toMatchObject({
      records: [{ filename: 'project_ok.md' }],
    });
  });

  it('skips null YAML frontmatter roots as corrupt instead of TypeError', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(dir, 'project_nullroot.md'),
      ['---', 'null', '---', 'body', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'project_tilderoot.md'),
      ['---', '~', '---', 'body', ''].join('\n'),
      'utf8',
    );
    const storage = new MemoryStorage(dir);
    const recs = await storage.list();
    expect(recs.map((r) => r.filename)).toEqual(['project_ok.md']);
    const withRaw = await storage.listWithRaw();
    expect(withRaw.map((x) => x.rec.filename)).toEqual(['project_ok.md']);
    await expect(planMemoryCleanup(dir)).resolves.toMatchObject({
      records: [{ filename: 'project_ok.md' }],
    });
  });

  it('does not swallow shard I/O errors in planMemoryCleanup', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }));
    try {
      await expect(planMemoryCleanup(dir)).rejects.toMatchObject({ code: 'io-error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the original MEMORY.md when rebuildIndex hits a shard I/O error', async () => {
    await shard('project_ok.md', 'project', 'Ok', 'hook', 'body', '2026-01-01T00:00:00.000Z');
    const storage = new MemoryStorage(dir);
    await storage.rebuildIndex();
    const before = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(before).toContain('project_ok.md');

    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    try {
      await expect(storage.rebuildIndex()).rejects.toBeInstanceOf(MemoryError);
    } finally {
      spy.mockRestore();
    }
    await expect(readFile(path.join(dir, 'MEMORY.md'), 'utf8')).resolves.toBe(before);
  });
});

describe('bindReviewedStaleCandidates (Codex P1 on #2561 apply vs dry-run)', () => {
  it('archives only the reviewed stale set, not later live hits', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');

    const reviewed = await planMemoryCleanup(dir);
    expect(reviewed.staleCandidates.map((c) => c.filename)).toEqual(['project_done.md']);
    const fingerprint = staleSetFingerprint(reviewed.staleCandidates);

    await shard('project_later.md', 'project', 'Later', 'hook', '这个项目已结束',
      '2026-02-01T00:00:00.000Z');
    const live = await planMemoryCleanup(dir);
    expect(live.staleCandidates.map((c) => c.filename).sort()).toEqual([
      'project_done.md',
      'project_later.md',
    ]);
    expect(staleSetFingerprint(live.staleCandidates)).not.toBe(fingerprint);

    const { extraLive } = bindReviewedStaleCandidates(
      live,
      reviewed.staleCandidates.map((c) => ({
        filename: c.filename,
        expectedHash: c.expectedHash,
        reason: c.reason,
        matchedSignal: c.matchedSignal,
        updatedAt: c.updatedAt,
      })),
    );
    expect(extraLive.map((c) => c.filename)).toEqual(['project_later.md']);
    expect(live.staleCandidates.map((c) => c.filename)).toEqual(['project_done.md']);

    const result = await runMemoryCleanup(live, { archiveStale: true });
    expect(result.archived.map((a) => a.filename)).toEqual(['project_done.md']);
    await expect(readFile(path.join(dir, 'project_later.md'), 'utf8')).resolves.toContain('已结束');
  });

  it('rejects a reviewed plan whose fingerprint does not match candidates', () => {
    expect(() =>
      parseReviewedStalePlan({
        version: 1,
        staleFingerprint: 'deadbeef',
        staleCandidates: [{ filename: 'project_a.md', expectedHash: 'abc' }],
      }),
    ).toThrow(/staleFingerprint/);
  });

  it('round-trips fingerprint through parseReviewedStalePlan', () => {
    const staleCandidates = [
      { filename: 'project_b.md', expectedHash: 'bbb' },
      { filename: 'project_a.md', expectedHash: 'aaa' },
    ];
    const staleFingerprint = staleSetFingerprint(staleCandidates);
    const parsed = parseReviewedStalePlan({
      version: 1,
      shardDir: '/tmp/shard',
      archiveStale: true,
      staleFingerprint,
      staleCandidates,
    });
    expect(parsed.staleFingerprint).toBe(staleFingerprint);
    expect(parsed.staleCandidates.map((c) => c.filename)).toEqual([
      'project_b.md',
      'project_a.md',
    ]);
  });

  it('rejects traversal and non-canonical filenames in reviewed plans', () => {
    const bad = [
      '../other-shard/project_x.md',
      '..\\other-shard\\project_x.md',
      '/tmp/project_x.md',
      'C:\\tmp\\project_x.md',
      'subdir/project_x.md',
      'MEMORY.md',
      'a.md',
      'project_x.md.txt',
    ];
    for (const filename of bad) {
      expect(() =>
        parseReviewedStalePlan({
          version: 1,
          staleFingerprint: staleSetFingerprint([{ filename, expectedHash: 'abc' }]),
          staleCandidates: [{ filename, expectedHash: 'abc' }],
        }),
      ).toThrow(/basename|canonical/);
    }
  });

  it('rejects non-integer and negative keepDigests from a reviewed plan', () => {
    const staleCandidates = [{ filename: 'project_a.md', expectedHash: 'abc' }];
    const staleFingerprint = staleSetFingerprint(staleCandidates);
    for (const keepDigests of [-100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      expect(() =>
        parseReviewedStalePlan({
          version: 1,
          staleFingerprint,
          staleCandidates,
          keepDigests,
        }),
      ).toThrow(/keepDigests/);
    }
    expect(
      parseReviewedStalePlan({
        version: 1,
        staleFingerprint,
        staleCandidates,
        keepDigests: 0,
      }).keepDigests,
    ).toBe(0);
    expect(
      parseReviewedStalePlan({
        version: 1,
        staleFingerprint,
        staleCandidates,
        keepDigests: 5,
      }).keepDigests,
    ).toBe(5);
  });
});

describe('cleanup exclusive lock (Codex P1 hold after host check)', () => {
  it('blocks host write/delete while apply holds the exclusive lock',
    async () => {
      await shard(
        'feedback_a.md',
        'feedback',
        'A',
        'hook',
        'keep',
        '2026-01-01T00:00:00.000Z',
      );
      const lock = await acquireCleanupExclusiveLock(dir);
      try {
        const store = new MemoryStorage(dir);
        await expect(
          store.write({
            type: 'feedback',
            name: 'late',
            title: 'Late',
            description: 'hook',
            body: 'host started after detectHost',
          }),
        ).rejects.toMatchObject({
          code: 'io-error',
          message: /cleanup exclusive lock/,
        });
        await expect(store.delete('feedback_a.md')).rejects.toMatchObject({
          code: 'io-error',
          message: /cleanup exclusive lock/,
        });
        await expect(
          readFile(path.join(dir, 'feedback_a.md'), 'utf8'),
        ).resolves.toMatch(/keep/);
        await expect(
          readFile(path.join(dir, 'feedback_late.md'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          acquireCleanupExclusiveLock(dir),
        ).rejects.toBeInstanceOf(CleanupLockError);
      } finally {
        await releaseCleanupExclusiveLock(lock);
      }
      const store = new MemoryStorage(dir);
      await expect(
        store.write({
          type: 'feedback',
          name: 'after',
          title: 'After',
          description: 'hook',
          body: 'unlocked',
        }),
      ).resolves.toMatchObject({ ok: true, filename: 'feedback_after.md' });
    },
  );

  it('steals a stale lock whose owner pid is dead',
    async () => {
      const lockDir = path.join(dir, CLEANUP_EXCLUSIVE_LOCK_DIR);
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, 'owner.json'),
        `${JSON.stringify({ pid: 2_147_483_647, startedAt: '2020-01-01T00:00:00.000Z' })}\n`,
        'utf8',
      );
      const lock = await acquireCleanupExclusiveLock(dir);
      await releaseCleanupExclusiveLock(lock);
    },
  );
});
