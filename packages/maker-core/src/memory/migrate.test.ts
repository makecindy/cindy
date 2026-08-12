/**
 * migrate.ts — 存量 worktree 分片迁移 (P0 第二阶段, #2379) 的单元测试。
 *
 * 默认 unit tier: fake resolver (不 spawn git) + 临时目录构造分片布局,
 * 覆盖计划生成 / 空分片删除 / 合并语义 (同名同内容跳过、同名不同内容冲突) /
 * 冲突保留源目录 / SSH 跳过 / 无 meta 跳过 / 备份 / 幂等。
 *
 * 真实 git worktree 端到端 (resolver 真跑) 在
 * migrate.git-integration.test.ts, 由 `pnpm test:git-integration` 执行。
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planLegacyShardMigration,
  runLegacyShardMigration,
  type LegacyShardMigrationDeps,
} from './migrate.js';
import { sanitizeWorkdir } from './storage.js';

/** 临时 memory 根; 每个用例前重建。 */
let tmpRoot: string;
let memoryRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-unit-'));
  memoryRoot = path.join(tmpRoot, 'maker-memory');
  await fs.mkdir(memoryRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** 假 resolver: 把 worktree 路径映射到主仓对应子路径 (与 #2399 语义一致)。 */
function fakeResolver(mainRepo: string, worktree: string): LegacyShardMigrationDeps {
  return {
    resolveScopeKey: async (wd: string) => {
      if (wd === worktree) return mainRepo;
      return wd;
    },
  };
}

/** 在 memoryRoot 下建一个分片目录 + meta.json + 若干分片文件。 */
async function makeShard(
  dirName: string,
  opts: { absPath: string; files?: Record<string, string>; withMeta?: boolean },
): Promise<string> {
  const dir = path.join(memoryRoot, dirName);
  await fs.mkdir(dir, { recursive: true });
  if (opts.withMeta !== false) {
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ absPath: opts.absPath, createdAt: 't0', lastUsedAt: 't0' }),
      'utf8',
    );
  }
  for (const [name, body] of Object.entries(opts.files ?? {})) {
    await fs.writeFile(
      path.join(dir, name),
      `---\ntitle: T ${name}\ndescription: D ${name}\ntype: ${name.split('_')[0]}\nupdatedAt: 2026-08-12T00:00:00.000Z\n---\n\n${body}`,
      'utf8',
    );
  }
  return dir;
}

describe('planLegacyShardMigration — 计划生成', () => {
  it('worktree 分片 (目录名 ≠ canonical) 归入 merge/empty, 主仓分片跳过', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'body-a' } });
    // worktree 空分片 (只有 meta.json)
    await makeShard(wtDir, { absPath: worktree });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.all.length).toBe(2);
    const main = plan.all.find((s) => s.dir.endsWith(mainDir))!;
    const wt = plan.all.find((s) => s.dir.endsWith(wtDir))!;
    expect(main.isLegacy).toBe(false);
    expect(wt.isLegacy).toBe(true);
    expect(plan.emptyToDelete).toHaveLength(1);
    expect(plan.emptyToDelete[0].dir).toBe(wt.dir);
    expect(plan.mergeCandidates).toHaveLength(0);
  });

  it('有内容的 worktree 分片归入 mergeCandidates', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'body-a', 'project_b.md': 'body-b' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].recordCount).toBe(2);
    expect(plan.emptyToDelete).toHaveLength(0);
  });

  it('SSH 分片 (meta.absPath 为 ssh: 复合键) 一律跳过不迁移', async () => {
    const sshDir = `ssh-host-${'a'.repeat(16)}`;
    // 真实 SSH 分片: manager 存 absWorkdir = scopeKey = ssh:<host>:<path>
    await makeShard(sshDir, {
      absPath: 'ssh:my-host:/remote/repo',
      files: { 'feedback_a.md': 'x' },
    });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].dir.endsWith(sshDir)).toBe(true);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
  });

  it('本地路径 sanitize 后恰好以 ssh- 开头的目录 → 按 meta 判定为本地分片, 不误跳 (Codex 第五轮)', async () => {
    // /ssh/proj → sanitizeWorkdir = ssh-proj; meta.absPath 是本地路径非 ssh: 键
    const localDir = 'ssh-proj';
    const localPath = path.join('/', 'ssh', 'proj');
    await makeShard(localDir, { absPath: localPath, files: { 'feedback_a.md': 'x' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.all).toHaveLength(1);
    expect(plan.all[0].isLegacy).toBe(false); // 本地路径, resolver 回落自身 → 非 legacy
  });

  it('无 meta.json 的目录 → skipped (不猜不删)', async () => {
    const orphan = path.join(memoryRoot, 'orphan-dir');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'feedback_a.md'), 'x', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].dir).toBe(orphan);
    expect(plan.mergeCandidates).toHaveLength(0);
  });

  it('canonical 目录名 == 当前目录名 → 非 legacy (归一化幂等)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'x' } });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, ''));
    expect(plan.all).toHaveLength(1);
    expect(plan.all[0].isLegacy).toBe(false);
  });
});

describe('runLegacyShardMigration — 执行', () => {
  it('空分片直接删除 (含 meta.json)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const wtPath = await makeShard(wtDir, { absPath: worktree });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('removed-empty');
    await expect(fs.stat(wtPath)).rejects.toThrow();
  });

  it('canonical 分片不存在 → rename 整个目录 + meta.absPath 更新', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'body-a' } });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].action).toBe('renamed');

    // 源目录消失, canonical 目录存在
    await expect(fs.stat(path.join(memoryRoot, wtDir))).rejects.toThrow();
    const target = path.join(memoryRoot, mainDir);
    const meta = JSON.parse(await fs.readFile(path.join(target, 'meta.json'), 'utf8'));
    expect(meta.absPath).toBe(mainRepo);
    // 分片文件原样保留
    const rec = await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8');
    expect(rec).toContain('body-a');
  });

  it('canonical 已存在 → 同名同内容跳过, 新文件复制, MEMORY.md 重建', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    // 主仓分片已有 feedback_a.md (内容 X)
    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'X' } });
    // worktree 分片: feedback_a.md 内容 X (重复) + project_b.md (新)
    await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'X', 'project_b.md': 'Y' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].mergedFiles).toEqual(
      expect.arrayContaining([
        { filename: 'feedback_a.md', outcome: 'same-skipped' },
        { filename: 'project_b.md', outcome: 'copied' },
      ]),
    );

    const target = path.join(memoryRoot, mainDir);
    // 目标仍有 feedback_a.md 且内容未变 (不覆盖)
    expect(await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8')).toContain('X');
    // project_b.md 已复制
    expect(await fs.readFile(path.join(target, 'project_b.md'), 'utf8')).toContain('Y');
    // 源目录被删 (无冲突)
    await expect(fs.stat(path.join(memoryRoot, wtDir))).rejects.toThrow();
    // MEMORY.md 含两个条目 (feedback + project)
    const index = await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8');
    expect(index).toContain('feedback_a.md');
    expect(index).toContain('project_b.md');
  });

  it('同名不同内容 → 冲突跳过且源目录保留 (不静默覆盖)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'MAIN-VERSION' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'WORKTREE-VERSION' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].filename).toBe('feedback_a.md');
    expect(result.results[0].mergedFiles).toEqual([
      { filename: 'feedback_a.md', outcome: 'conflict-skipped' },
    ]);
    // 目标内容未被覆盖
    const target = path.join(memoryRoot, mainDir);
    expect(await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8')).toContain('MAIN-VERSION');
    // 源目录保留 (冲突待人工)
    expect(await fs.readFile(path.join(wtPath, 'feedback_a.md'), 'utf8')).toContain(
      'WORKTREE-VERSION',
    );
  });

  it('指定 backupRoot 时删除/rename 前先备份', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const backupRoot = path.join(tmpRoot, 'backup');
    await makeShard(wtDir, { absPath: worktree });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    await runLegacyShardMigration(plan, { backupRoot });
    const entries = await fs.readdir(backupRoot);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain(wtDir);
  });

  it('幂等: 已迁移的分片再次扫描不再归入计划', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });

    const plan1 = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    await runLegacyShardMigration(plan1);

    // 第二次扫描: canonical 目录 (mainDir) 存在且 isLegacy=false
    const plan2 = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan2.mergeCandidates).toHaveLength(0);
    expect(plan2.emptyToDelete).toHaveLength(0);
    const canonical = plan2.all.find((s) => s.dir.endsWith(mainDir));
    expect(canonical?.isLegacy).toBe(false);
  });

  it('未识别 .md 文件 (不符合 <type>_<slug> 规则) → 保留源目录不删', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'X' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'X' },
    });
    // 未识别文件: 不符合 <type>_<slug>.md 规则但仍含内容的 markdown
    await fs.writeFile(path.join(wtPath, 'notes.md'), '# 手写笔记\n\n重要内容', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const result = await runLegacyShardMigration(plan);
    // 合法文件照常合并, 但源目录因未识别文件保留
    expect(result.results[0].mergedFiles).toEqual([
      { filename: 'feedback_a.md', outcome: 'same-skipped' },
    ]);
    expect(result.results[0].error).toContain('unrecognized');
    // 源目录保留 (未识别文件仍在)
    expect(await fs.readFile(path.join(wtPath, 'notes.md'), 'utf8')).toContain('重要内容');
    // 目标目录不含未识别文件 (未参与合并)
    const target = path.join(memoryRoot, mainDir);
    await expect(fs.stat(path.join(target, 'notes.md'))).rejects.toThrow();
  });

  it('空分片删除前竞态校验: 扫描后新增分片文件 → 跳过删除并报告', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const wtPath = await makeShard(wtDir, { absPath: worktree });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.emptyToDelete).toHaveLength(1);
    // 模拟扫描后竞态: 在删除前写入一个分片文件
    await fs.writeFile(
      path.join(wtPath, 'feedback_race.md'),
      '---\ntitle: R\ndescription: DR\ntype: feedback\nupdatedAt: t\n---\n\nNEW',
      'utf8',
    );
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toContain('content since scan');
    // 目录保留
    expect(await fs.readFile(path.join(wtPath, 'feedback_race.md'), 'utf8')).toContain('NEW');
  });

  it('空分片删除前竞态校验: 扫描后新增未识别 .md → 跳过删除并报告 (Greptile 第三轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const wtPath = await makeShard(wtDir, { absPath: worktree });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.emptyToDelete).toHaveLength(1);
    // 模拟首查后、rename 前写入未识别文件 (notes.md) — 最终复查必须拦下
    await fs.writeFile(path.join(wtPath, 'notes.md'), '# 手写笔记\n\n重要内容', 'utf8');
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toContain('unrecognized');
    // 目录保留, notes.md 内容完好
    expect(await fs.readFile(path.join(wtPath, 'notes.md'), 'utf8')).toContain('重要内容');
  });

  it('Cindy 托管 worktree 路径静态推导: 已归档 worktree 仍可识别为 legacy', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    // 已归档/删除的 worktree: resolver live 探测会回落原样 (fake resolver 返回自身)
    const archivedWt = path.join(mainRepo, '.cindy-worktrees', 'feat-x');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    // resolver 回落原样 (模拟 live 探测失败) — 静态推导接管
    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalDirName).toBe(sanitizeWorkdir(mainRepo));
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(mainRepo);
  });

  it('只有未识别 .md 的 legacy 分片不按空删 (Greptile 第二轮: 空分片误删未识别内容)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const wtPath = await makeShard(wtDir, { absPath: worktree });
    // 只有未识别文件 (无合法 <type>_<slug>.md) — 内容在 notes.md 里
    await fs.writeFile(path.join(wtPath, 'notes.md'), '# 手写笔记\n\n重要内容', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    // 不进 emptyToDelete (会递归删掉 notes.md), 归入 mergeCandidates
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.mergeCandidates).toHaveLength(1);
    const result = await runLegacyShardMigration(plan);
    // canonical 不存在 → rename 快路径: 整个目录 (含 notes.md) 搬进 canonical, 数据安全
    expect(result.results[0].action).toBe('renamed');
    const target = path.join(memoryRoot, mainDir);
    expect(await fs.readFile(path.join(target, 'notes.md'), 'utf8')).toContain('重要内容');
  });

  it('.xdt-worktrees 旧形态同样静态推导 (Codex 第二轮: 品牌迁移前布局)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const archivedWt = path.join(mainRepo, '.xdt-worktrees', 'feat-x', 'apps', 'a');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalDirName).toBe(
      sanitizeWorkdir(path.join(mainRepo, 'apps', 'a')),
    );
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(path.join(mainRepo, 'apps', 'a'));
  });

  it('Windows 正斜杠路径的托管 worktree 静态推导 (Codex 第四轮: Desktop 归一化路径)', async () => {
    // Desktop 存储把 Windows workingDir 归一化为正斜杠 — 静态推导必须能认
    const archivedWt = 'C:/repo/.cindy-worktrees/wt/apps/a';
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(
      path.join('C:', 'repo', 'apps', 'a'),
    );
    expect(plan.mergeCandidates[0].isLegacy).toBe(true);
  });

  it('慢路径合并: plan 后写入的合法分片被一并合并, 数据不丢 (Codex 第四轮: 快照后写入)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'X' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'X' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    // plan 后、run 前写入合法分片 — mergeFilesInto 快照时它会被一并合并
    await fs.writeFile(
      path.join(wtPath, 'project_late.md'),
      '---\ntitle: L\ndescription: DL\ntype: project\nupdatedAt: t\n---\n\nLATE',
      'utf8',
    );
    const result = await runLegacyShardMigration(plan);
    // 无冲突 → 源目录删除; 新增文件已合并进目标
    expect(result.results[0].error).toBeUndefined();
    const target = path.join(memoryRoot, mainDir);
    expect(await fs.readFile(path.join(target, 'project_late.md'), 'utf8')).toContain('LATE');
    await expect(fs.stat(wtPath)).rejects.toThrow();
  });

  it('非 Markdown 遗留内容 (notes.txt/data.yaml) → 保留源目录不删 (Greptile 第五轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'X' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'X' },
    });
    // 非 Markdown 遗留内容
    await fs.writeFile(path.join(wtPath, 'notes.txt'), '手写笔记 txt', 'utf8');
    await fs.writeFile(path.join(wtPath, 'data.yaml'), 'key: value', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].error).toContain('unrecognized');
    // 源目录保留, 非 Markdown 内容完好
    expect(await fs.readFile(path.join(wtPath, 'notes.txt'), 'utf8')).toContain('txt');
    expect(await fs.readFile(path.join(wtPath, 'data.yaml'), 'utf8')).toContain('value');
    // 合法分片照常合并进目标
    const target = path.join(memoryRoot, mainDir);
    expect(await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8')).toContain('X');
  });

  it('复制后已有分片被更新 → 内容对比兜底, 源目录保留 (Greptile 第五轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);

    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_a.md': 'X' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'X' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    // 模拟存量会话更新已有记忆: 复制发生时源是 X (同目标, same-skipped),
    // 之后被改写成 X2 — 数量复查 (countShardFiles) 检测不到, 内容对比兜底。
    // patch 只对「源路径」的读生效: 第 1 次 (mergeFilesInto 比较) 返 X,
    // 之后 (findChangedAfterMerge 内容复查) 返 X2; 目标路径正常读。
    const origReadFile = fs.readFile.bind(fs);
    let srcReads = 0;
    // @ts-expect-error 测试注入
    fs.readFile = async (...args) => {
      const [p] = args;
      if (typeof p === 'string' && p.startsWith(wtPath + path.sep) && p.endsWith('feedback_a.md')) {
        srcReads += 1;
        // mergeFilesInto 读源 (第 1 次) → 真实内容 (与目标一致, same-skipped);
        // findChangedAfterMerge 内容复查 (第 2 次起) → 改写的 X2 → 源 ≠ 目标
        return srcReads === 1 ? origReadFile(...args) : Buffer.from('X2');
      }
      return origReadFile(...args);
    };
    try {
      const result = await runLegacyShardMigration(plan);
      expect(result.results[0].error).toContain('updated after copy');
      // 源目录保留
      await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    } finally {
      fs.readFile = origReadFile;
    }
  });
});
