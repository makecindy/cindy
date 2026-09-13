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
  deriveCanonicalFromCindyWorktreePath,
  managedWorktreeRoot,
  planLegacyShardMigration,
  runLegacyShardMigration,
  summarizeApplyMigration,
  type LegacyShardMigrationDeps,
} from './migrate.js';
import { normalizeWindowsLocalScopeKey } from './scope-resolver.js';
import { memoryScopeDirName, sanitizeWorkdir } from './storage.js';

/** Windows 本地 key 一律正斜杠; POSIX 恒等。 */
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

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
      if (fwd(wd) === fwd(worktree)) return fwd(mainRepo);
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

/** 在主仓登记 Cindy 托管 worktree 元数据 (模拟 `.git/worktrees/<name>`)。 */
async function registerManagedWorktree(mainRepo: string, worktreeName: string): Promise<void> {
  await fs.mkdir(path.join(mainRepo, '.git', 'worktrees', worktreeName), { recursive: true });
}

describe('planLegacyShardMigration — 计划生成', () => {
  it('memoryRoot ENOENT → 空计划 (尚无数据); 其它读取失败 → plan.failed (Codex 3972389951 / Us6gzzAz)', async () => {
    const missing = path.join(tmpRoot, 'no-such-memory-root');
    const empty = await planLegacyShardMigration(missing);
    expect(empty.all).toHaveLength(0);
    expect(empty.failed).toHaveLength(0);
    expect(empty.skipped).toHaveLength(0);
    expect(empty.mergeCandidates).toHaveLength(0);
    expect(empty.emptyToDelete).toHaveLength(0);
    expect(summarizeApplyMigration(empty, { results: [], conflicts: [] }).ok).toBe(true);

    const origReaddir = fs.readdir.bind(fs);
    // @ts-expect-error 测试注入
    fs.readdir = async (p) => {
      if (typeof p === 'string' && p === memoryRoot) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origReaddir(p);
    };
    try {
      const blocked = await planLegacyShardMigration(memoryRoot);
      expect(blocked.all).toHaveLength(0);
      expect(blocked.mergeCandidates).toHaveLength(0);
      expect(blocked.emptyToDelete).toHaveLength(0);
      expect(blocked.failed).toHaveLength(1);
      expect(blocked.failed[0].dir).toBe(memoryRoot);
      expect(blocked.failed[0].skipReason).toBe('memory-root-unreadable:EACCES');
      const apply = summarizeApplyMigration(blocked, { results: [], conflicts: [] });
      expect(apply.ok).toBe(false);
      expect(apply.failed).toEqual([
        { dir: memoryRoot, reason: 'memory-root-unreadable:EACCES' },
      ]);
    } finally {
      fs.readdir = origReaddir;
    }
  });

  it('分片 lstat EIO → plan.failed stat-failure, 不静默丢弃 (Codex 3974018433)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const origLstat = fs.lstat.bind(fs);
    // @ts-expect-error 测试注入
    fs.lstat = async (p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === dir) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return origLstat(p, ...rest);
    };
    try {
      const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
      expect(plan.all).toHaveLength(0);
      expect(plan.mergeCandidates).toHaveLength(0);
      expect(plan.emptyToDelete).toHaveLength(0);
      expect(plan.failed).toHaveLength(1);
      expect(plan.failed[0].dir).toBe(dir);
      expect(plan.failed[0].skipReason).toBe('stat-failure:EIO');
      expect(summarizeApplyMigration(plan, { results: [], conflicts: [] }).ok).toBe(false);
      expect(await fs.readFile(path.join(dir, 'feedback_a.md'), 'utf8')).toContain('keep');
    } finally {
      fs.lstat = origLstat;
    }
  });

  it('分片目录 readdir EACCES → plan.failed dir-read-failure, 不进 emptyToDelete (Codex 3975030334)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const origReaddir = fs.readdir.bind(fs);
    // @ts-expect-error 测试注入
    fs.readdir = async (p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === dir) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origReaddir(p, ...rest);
    };
    try {
      const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
      expect(plan.emptyToDelete).toHaveLength(0);
      expect(plan.mergeCandidates).toHaveLength(0);
      expect(plan.all).toHaveLength(0);
      expect(plan.failed).toHaveLength(1);
      expect(plan.failed[0].dir).toBe(dir);
      expect(plan.failed[0].skipReason).toBe('dir-read-failure:EACCES');
      const apply = summarizeApplyMigration(plan, { results: [], conflicts: [] });
      expect(apply.ok).toBe(false);
      expect(await fs.readFile(path.join(dir, 'feedback_a.md'), 'utf8')).toContain('keep');
    } finally {
      fs.readdir = origReaddir;
    }
  });

  it('过期 emptyToDelete 在 apply 时 readdir 失败 → 不 trash 分片 (Codex 3975030334)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.emptyToDelete).toHaveLength(1);
    const origReaddir = fs.readdir.bind(fs);
    // @ts-expect-error 测试注入
    fs.readdir = async (p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === dir) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origReaddir(p, ...rest);
    };
    try {
      const result = await runLegacyShardMigration(plan);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].action).toBe('skipped');
      expect(result.results[0].error).toMatch(/EACCES/);
      await expect(fs.stat(path.join(dir, 'meta.json'))).resolves.toBeTruthy();
      expect(summarizeApplyMigration(plan, result).ok).toBe(false);
    } finally {
      fs.readdir = origReaddir;
    }
  });

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
    // skipped 不进 plan.all; CLI totalShards 必须把 skipped 算进去
    expect(plan.all.length + plan.skipped.length).toBe(1);
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

  it('symlink 分片目录 → skipped, 不跟随目标 (Codex 3974113763)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const realDir = await makeShard('real-outside', {
      absPath: worktree,
      files: { 'feedback_a.md': 'secret' },
    });
    // 把真实分片移出 memoryRoot, 在根内放同名 symlink — 跟随则会当 legacy 迁走。
    const outside = path.join(tmpRoot, 'outside-real');
    await fs.rename(realDir, outside);
    const linkName = sanitizeWorkdir(worktree);
    const linkDir = path.join(memoryRoot, linkName);
    try {
      await fs.symlink(outside, linkDir, 'dir');
    } catch {
      // Windows 无 privilege / 不支持目录 symlink 时本用例无法构造, 直接返回。
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir === linkDir)?.skipReason).toBe('symlink-shard');
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.all).toHaveLength(0);
    const apply = await runLegacyShardMigration(plan);
    expect(apply.results).toHaveLength(0);
    expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, 'feedback_a.md'), 'utf8')).toContain('secret');
  });

  it('分片文件是 symlink → skipped, 不跟随读入 canonical (Codex 3974674258)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree });
    const outside = path.join(tmpRoot, 'outside-secret.md');
    await fs.writeFile(outside, 'secret-outside', 'utf8');
    try {
      await fs.symlink(outside, path.join(dir, 'project_secret.md'));
    } catch {
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir === dir)?.skipReason).toBe('symlink-shard-file');
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.all).toHaveLength(0);
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(0);
    expect((await fs.lstat(path.join(dir, 'project_secret.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, 'utf8')).toBe('secret-outside');
  });

  it('过期 plan 含 symlink 分片文件 → apply 拒绝 (Codex 3974674258)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const outside = path.join(tmpRoot, 'outside-stale-file.md');
    await fs.writeFile(outside, 'secret-outside', 'utf8');
    await fs.rm(path.join(dir, 'feedback_a.md'));
    try {
      await fs.symlink(outside, path.join(dir, 'feedback_a.md'));
    } catch {
      return;
    }
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('symlink-shard-file');
    expect((await fs.lstat(path.join(dir, 'feedback_a.md'))).isSymbolicLink()).toBe(true);
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('meta.json 是 symlink → skipped, 规划不跟随、apply 不改根外 (Codex 3975030337)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const outside = path.join(tmpRoot, 'outside-meta.json');
    const original = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    await fs.writeFile(outside, original, 'utf8');
    await fs.rm(path.join(dir, 'meta.json'));
    try {
      await fs.symlink(outside, path.join(dir, 'meta.json'));
    } catch {
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir === dir)?.skipReason).toBe('symlink-system-file');
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.all).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe(original);
    expect((await fs.lstat(path.join(dir, 'meta.json'))).isSymbolicLink()).toBe(true);
  });

  it('过期 plan 的 meta.json 换成 symlink → apply 拒绝 updateMeta (Codex 3975030337)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const outside = path.join(tmpRoot, 'outside-stale-meta.json');
    const original = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    await fs.writeFile(outside, original, 'utf8');
    await fs.rm(path.join(dir, 'meta.json'));
    try {
      await fs.symlink(outside, path.join(dir, 'meta.json'));
    } catch {
      return;
    }
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('symlink-system-file');
    expect(JSON.parse(await fs.readFile(outside, 'utf8')).absPath).toBe(worktree);
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('canonical MEMORY.md 是 symlink → skipped, rebuildIndex 不跟随 (Codex 3975030337)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_keep.md': 'keep' } });
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const outside = path.join(tmpRoot, 'outside-MEMORY.md');
    await fs.writeFile(outside, 'index-outside', 'utf8');
    const memPath = path.join(memoryRoot, mainDir, 'MEMORY.md');
    try {
      await fs.rm(memPath, { force: true });
      await fs.symlink(outside, memPath);
    } catch {
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir.endsWith(wtDir))?.skipReason).toBe('symlink-system-file');
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('index-outside');
  });

  it('过期 plan 把 symlink 当分片 → apply 仍拒绝 rename (Codex 3974113763)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const realDir = await makeShard(sanitizeWorkdir(worktree), {
      absPath: worktree,
      files: { 'feedback_a.md': 'secret' },
    });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const outside = path.join(tmpRoot, 'outside-stale');
    await fs.rename(realDir, outside);
    try {
      await fs.symlink(outside, realDir, 'dir');
    } catch {
      return;
    }
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('symlink-shard');
    expect((await fs.lstat(realDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, 'feedback_a.md'), 'utf8')).toContain('secret');
    const summary = summarizeApplyMigration(plan, result);
    expect(summary.ok).toBe(false);
  });

  it('无 meta.json 的目录 → skipped (不猜不删)', async () => {
    const orphan = path.join(memoryRoot, 'orphan-dir');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'feedback_a.md'), 'x', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].dir).toBe(orphan);
    expect(plan.skipped[0].skipReason).toBe('no-meta');
    expect(plan.failed).toHaveLength(0);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.all.length + plan.skipped.length).toBe(1);
  });

  it('meta.json 读 EACCES → plan.failed meta-read-failure, --apply 不得 ok (Codex 3976576804)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const metaPath = path.join(dir, 'meta.json');
    const origRead = fs.readFile.bind(fs);
    // @ts-expect-error 测试注入
    fs.readFile = async (p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === metaPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origRead(p, ...rest);
    };
    try {
      const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
      expect(plan.skipped.find((s) => s.dir === dir)).toBeUndefined();
      expect(plan.mergeCandidates).toHaveLength(0);
      expect(plan.emptyToDelete).toHaveLength(0);
      expect(plan.failed).toHaveLength(1);
      expect(plan.failed[0].dir).toBe(dir);
      expect(plan.failed[0].skipReason).toBe('meta-read-failure:EACCES');
      const apply = summarizeApplyMigration(plan, { results: [], conflicts: [] });
      expect(apply.ok).toBe(false);
      expect(apply.failed).toEqual([{ dir, reason: 'meta-read-failure:EACCES' }]);
      expect(await fs.readFile(path.join(dir, 'feedback_a.md'), 'utf8')).toContain('keep');
    } finally {
      fs.readFile = origRead;
    }
  });

  it('meta.json 非 JSON → skipped invalid-meta, 不当 I/O failed (Codex 3976576804)', async () => {
    const bad = path.join(memoryRoot, 'bad-json-meta');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'meta.json'), '{not-json', 'utf8');
    await fs.writeFile(path.join(bad, 'feedback_a.md'), 'x', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.failed).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].dir).toBe(bad);
    expect(plan.skipped[0].skipReason).toBe('invalid-meta');
  });

  it('SSH + 无 meta 同时存在时, 扫描总数 = all + skipped (Codex 第十六轮: totalShards)', async () => {
    const sshDir = `ssh-host-${'b'.repeat(16)}`;
    await makeShard(sshDir, {
      absPath: 'ssh:other-host:/remote/repo',
      files: { 'feedback_a.md': 'x' },
    });
    const orphan = path.join(memoryRoot, 'orphan-dir');
    await fs.mkdir(orphan, { recursive: true });
    const mainRepo = path.join(tmpRoot, 'repo');
    await makeShard(sanitizeWorkdir(mainRepo), {
      absPath: mainRepo,
      files: { 'feedback_a.md': 'x' },
    });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.all).toHaveLength(1);
    expect(plan.all.length + plan.skipped.length).toBe(3);
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

  it('计划后并发创建 canonical 目录 → skipped concurrent-create, 不覆盖 (Codex 3974808630)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtPath = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalExistedAtPlan).toBe(false);
    const target = path.join(memoryRoot, mainDir);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'feedback_new.md'), 'concurrent', 'utf8');
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('concurrent-create');
    await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    expect(await fs.readFile(path.join(target, 'feedback_new.md'), 'utf8')).toBe('concurrent');
    await expect(fs.stat(path.join(target, 'feedback_a.md'))).rejects.toThrow();
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('多个 legacy 同 canonical 且计划时目标不存在 → 本轮依次合并 (Codex 3975187667)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const wt1 = path.join(tmpRoot, 'repo-wt-1');
    const wt2 = path.join(tmpRoot, 'repo-wt-2');
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(sanitizeWorkdir(wt1), { absPath: wt1, files: { 'feedback_a.md': 'from-1' } });
    await makeShard(sanitizeWorkdir(wt2), { absPath: wt2, files: { 'project_b.md': 'from-2' } });
    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => {
        if (fwd(wd) === fwd(wt1) || fwd(wd) === fwd(wt2)) return fwd(mainRepo);
        return wd;
      },
    });
    expect(plan.mergeCandidates).toHaveLength(2);
    expect(plan.mergeCandidates.every((c) => c.canonicalExistedAtPlan === false)).toBe(true);
    const result = await runLegacyShardMigration(plan);
    expect(result.results.map((r) => r.action).sort()).toEqual(['merged', 'renamed']);
    expect(result.results.every((r) => r.error == null)).toBe(true);
    expect(await fs.readFile(path.join(memoryRoot, mainDir, 'feedback_a.md'), 'utf8')).toContain(
      'from-1',
    );
    expect(await fs.readFile(path.join(memoryRoot, mainDir, 'project_b.md'), 'utf8')).toContain(
      'from-2',
    );
    expect(summarizeApplyMigration(plan, result).ok).toBe(true);
  });

  it('merge COPYFILE_EXCL 撞上并发创建的目标文件 → 不同内容 conflict-skipped 不覆盖 (Codex 3974808630)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_keep.md': 'keep' } });
    const wtPath = await makeShard(wtDir, {
      absPath: worktree,
      files: { 'feedback_a.md': 'from-legacy' },
    });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates[0].canonicalExistedAtPlan).toBe(true);
    const origCopy = fs.copyFile.bind(fs);
    // @ts-expect-error 测试注入
    fs.copyFile = async (_src: string, dst: string, _mode?: number) => {
      await fs.writeFile(dst, 'raced', 'utf8');
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    };
    try {
      const result = await runLegacyShardMigration(plan);
      expect(result.results[0].action).toBe('merged');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].filename).toBe('feedback_a.md');
      expect(await fs.readFile(path.join(memoryRoot, mainDir, 'feedback_a.md'), 'utf8')).toBe(
        'raced',
      );
      await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    } finally {
      fs.copyFile = origCopy;
    }
  });

  it('canonical 分片不存在 → rename 整个目录 + meta.absPath 更新 + MEMORY.md 重建 (Codex 第十一轮)', async () => {
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
    expect(meta.absPath).toBe(fwd(mainRepo));
    // 分片文件原样保留
    const rec = await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8');
    expect(rec).toContain('body-a');
    // MEMORY.md 已重建 (索引缺失/过期时 canonical 会话读到 stale 索引,
    // 记忆进不了 prompt — 快路径与合并路径一致, Codex review on #2519)
    const index = await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8');
    expect(index).toContain('feedback_a.md');
  });

  it('rename 快路径丢弃 legacy fts.db (Codex 第十六轮: stale FTS 不带入 canonical)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtPath = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    // legacy 分片带 stale fts.db (模拟 FTS 更新失败残留)
    await fs.writeFile(path.join(wtPath, 'fts.db'), Buffer.from('stale-fts'));
    await fs.writeFile(path.join(wtPath, 'fts.db-wal'), Buffer.from('wal'));

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].action).toBe('renamed');

    const target = path.join(memoryRoot, mainDir);
    // fts.db 与 sidecar 被丢弃 (下次打开由 sanity check 重建)
    await expect(fs.stat(path.join(target, 'fts.db'))).rejects.toThrow();
    await expect(fs.stat(path.join(target, 'fts.db-wal'))).rejects.toThrow();
    // 分片文件仍在
    expect(await fs.readFile(path.join(target, 'feedback_a.md'), 'utf8')).toContain('X');
  });

  it('慢路径合并后丢弃 canonical stale fts.db (Codex 3975030344)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const mainPath = await makeShard(mainDir, {
      absPath: mainRepo,
      files: { 'feedback_a.md': 'keep' },
    });
    await makeShard(wtDir, { absPath: worktree, files: { 'project_b.md': 'new' } });
    await fs.writeFile(path.join(mainPath, 'fts.db'), Buffer.from('stale-fts'));
    await fs.writeFile(path.join(mainPath, 'fts.db-wal'), Buffer.from('wal'));
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan);
    expect(result.results[0].action).toBe('merged');
    expect(result.results[0].error).toBeUndefined();
    const target = path.join(memoryRoot, mainDir);
    await expect(fs.stat(path.join(target, 'fts.db'))).rejects.toThrow();
    await expect(fs.stat(path.join(target, 'fts.db-wal'))).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'project_b.md'), 'utf8')).toContain('new');
    await expect(fs.stat(path.join(memoryRoot, wtDir))).rejects.toThrow();
    expect(summarizeApplyMigration(plan, result).ok).toBe(true);
  });

  it('慢路径 stale fts.db rm 失败 → merged 带 error, 不删源 (Codex 3975030344)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const mainPath = await makeShard(mainDir, {
      absPath: mainRepo,
      files: { 'feedback_a.md': 'keep' },
    });
    const wtPath = await makeShard(wtDir, { absPath: worktree, files: { 'project_b.md': 'new' } });
    await fs.writeFile(path.join(mainPath, 'fts.db'), Buffer.from('stale-fts'));
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan, {
      rmFile: async (filePath) => {
        if (String(filePath).includes('fts.db')) throw new Error('EBUSY fts.db');
      },
    });
    expect(result.results[0].action).toBe('merged');
    expect(result.results[0].error).toMatch(/stale fts.db remove failed/);
    await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    expect(await fs.readFile(path.join(memoryRoot, mainDir, 'project_b.md'), 'utf8')).toContain(
      'new',
    );
    const apply = summarizeApplyMigration(plan, result);
    expect(apply.ok).toBe(false);
    expect(apply.executionErrors).toHaveLength(1);
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
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
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

  it('慢路径合并前同时备份 canonical 目标 (Codex 3968440926)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(mainDir, { absPath: mainRepo, files: { 'feedback_keep.md': 'keep' } });
    await makeShard(wtDir, { absPath: worktree, files: { 'project_new.md': 'new' } });
    const backupRoot = path.join(tmpRoot, 'backup');
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    await runLegacyShardMigration(plan, { backupRoot });
    const entries = await fs.readdir(backupRoot);
    expect(entries.some((e) => e.startsWith(`${mainDir}-`))).toBe(true);
    expect(entries.some((e) => e.startsWith(`${wtDir}-`))).toBe(true);
    const canonicalBackup = entries.find((e) => e.startsWith(`${mainDir}-`))!;
    expect(
      await fs.readFile(path.join(backupRoot, canonicalBackup, 'feedback_keep.md'), 'utf8'),
    ).toContain('keep');
    await expect(fs.stat(path.join(backupRoot, canonicalBackup, 'project_new.md'))).rejects.toThrow();
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
    await registerManagedWorktree(mainRepo, 'feat-x');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    // resolver 回落原样 (模拟 live 探测失败) — 静态推导接管
    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalDirName).toBe(sanitizeWorkdir(mainRepo));
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(fwd(mainRepo));
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

  it('只有非 Markdown 遗留文件 (notes.txt) 的分片不按空删 (Codex 第十轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const wtPath = await makeShard(wtDir, { absPath: worktree });
    // 只有非 Markdown 遗留内容, 无合法分片
    await fs.writeFile(path.join(wtPath, 'notes.txt'), '手写笔记 txt', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    // 不进 emptyToDelete (会递归删掉 notes.txt), 归入 mergeCandidates
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.mergeCandidates).toHaveLength(1);
    const result = await runLegacyShardMigration(plan);
    // canonical 不存在 → rename 快路径: 整个目录 (含 notes.txt) 搬进 canonical
    expect(result.results[0].action).toBe('renamed');
    const target = path.join(memoryRoot, mainDir);
    expect(await fs.readFile(path.join(target, 'notes.txt'), 'utf8')).toContain('txt');
  });

  it('.xdt-worktrees 旧形态同样静态推导 (Codex 第二轮: 品牌迁移前布局)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const archivedWt = path.join(mainRepo, '.xdt-worktrees', 'feat-x', 'apps', 'a');
    await registerManagedWorktree(mainRepo, 'feat-x');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalDirName).toBe(
      sanitizeWorkdir(path.join(mainRepo, 'apps', 'a')),
    );
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(fwd(path.join(mainRepo, 'apps', 'a')));
  });

  it('Windows 正斜杠路径的托管 worktree 静态推导 (Codex 第四轮: Desktop 归一化路径)', async () => {
    // Desktop 存储把 Windows workingDir 归一化为正斜杠 — 静态推导必须能认。
    // 证据校验走真实 fs, 所以主仓/.git/worktrees/<name> 建在 tmp 里, meta.absPath
    // 仍写正斜杠形态 (与 Desktop 落盘一致)。
    const mainRepo = path.join(tmpRoot, 'repo');
    await registerManagedWorktree(mainRepo, 'wt');
    const archivedWtFs = path.join(mainRepo, '.cindy-worktrees', 'wt', 'apps', 'a');
    const archivedWtMeta = archivedWtFs.split(path.sep).join('/');
    const wtDir = sanitizeWorkdir(archivedWtMeta);
    await makeShard(wtDir, { absPath: archivedWtMeta, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(
      fwd(path.join(mainRepo, 'apps', 'a')),
    );
    expect(plan.mergeCandidates[0].isLegacy).toBe(true);
  });

  it('活 git 仓库位于 .cindy-worktrees 目录下 → 不静态推导 (Codex 第十二轮: 误判护栏)', async () => {
    // 普通本地 checkout 恰好位于 /home/me/.cindy-worktrees/proj
    const liveRepo = path.join(tmpRoot, '.cindy-worktrees', 'proj');
    await fs.mkdir(liveRepo, { recursive: true });
    await fs.mkdir(path.join(liveRepo, '.git'), { recursive: true }); // 活仓库标记
    const wtDir = sanitizeWorkdir(liveRepo);
    await makeShard(wtDir, { absPath: liveRepo, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    // 是活仓库 → 不推导 → canonicalScopeKey = absPath 原样 → 非 legacy
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    const shard = plan.all.find((s) => s.dir.endsWith(wtDir));
    expect(shard?.isLegacy).toBe(false);
    expect(shard?.canonicalScopeKey).toBe(fwd(liveRepo));
  });

  it('活仓库子目录 (absPath 为 .cindy-worktrees 下子路径) → 祖先 .git 标记命中, 不推导 (Codex 第十四轮)', async () => {
    // 会话 workdir = /.../.cindy-worktrees/proj/apps/a, 仓库根 proj/ 下有 .git
    const projRoot = path.join(tmpRoot, '.cindy-worktrees', 'proj');
    const workdir = path.join(projRoot, 'apps', 'a');
    await fs.mkdir(path.join(projRoot, '.git'), { recursive: true }); // 祖先标记
    const wtDir = sanitizeWorkdir(workdir);
    await makeShard(wtDir, { absPath: workdir, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    // 向上遍历发现祖先 .git → 活仓库 → 不推导 → 非 legacy, key 原样
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    const shard = plan.all.find((s) => s.dir.endsWith(wtDir));
    expect(shard?.isLegacy).toBe(false);
    expect(shard?.canonicalScopeKey).toBe(fwd(workdir));
  });

  it('已归档托管 worktree (worktree 无 .git 但主仓有) → 仍静态推导 (Codex 第十五轮)', async () => {
    // /repo/.cindy-worktrees/feat-x/apps/a: worktree 根 feat-x 已删除 (无 .git),
    // 但主仓 /repo/.git 存在 — 祖先遍历不能命中主仓标记而误判活仓库
    const mainRepo = path.join(tmpRoot, 'repo');
    await fs.mkdir(path.join(mainRepo, '.git'), { recursive: true }); // 主仓标记
    const archivedWt = path.join(mainRepo, '.cindy-worktrees', 'feat-x', 'apps', 'a');
    await registerManagedWorktree(mainRepo, 'feat-x');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    // worktree 根及以下无 .git → 判非活仓库 → 静态推导映射到主仓
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].canonicalScopeKey).toBe(fwd(path.join(mainRepo, 'apps', 'a')));
    expect(plan.mergeCandidates[0].isLegacy).toBe(true);
  });

  it('普通仓内同名 .cindy-worktrees/<name> 目录 → 不静态推导 (Codex 第十六轮)', async () => {
    // 普通 checkout 根下碰巧有 .cindy-worktrees/feat-x, 任务 cwd 在其中;
    // 没有 worktree `.git`、也没有主仓 `.git/worktrees/feat-x` 登记。
    const mainRepo = path.join(tmpRoot, 'repo');
    await fs.mkdir(path.join(mainRepo, '.git'), { recursive: true });
    const coincidental = path.join(mainRepo, '.cindy-worktrees', 'feat-x');
    await fs.mkdir(coincidental, { recursive: true }); // 同名目录真实存在, 区别于 worktree remove
    const wtDir = sanitizeWorkdir(coincidental);
    await makeShard(wtDir, { absPath: coincidental, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    const shard = plan.all.find((s) => s.dir.endsWith(wtDir));
    expect(shard?.isLegacy).toBe(false);
    expect(shard?.canonicalScopeKey).toBe(fwd(coincidental));
  });

  it('无托管证据且目录已删 → failed 歧义, 不自动推导 (Codex 3972854282)', async () => {
    // 普通 checkout 曾位于 `.cindy-worktrees/<name>` 下后被卸载: 无 .git、
    // 无 `.git/worktrees/<name>` 登记、磁盘目录也不在。路径形态不够当托管证据,
    // 不得把记忆并入祖先 scope。
    const mainRepo = path.join(tmpRoot, 'repo');
    await fs.mkdir(path.join(mainRepo, '.git'), { recursive: true });
    const archivedWt = path.join(mainRepo, '.cindy-worktrees', 'feat-x');
    const wtDir = sanitizeWorkdir(archivedWt);
    await makeShard(wtDir, { absPath: archivedWt, files: { 'feedback_a.md': 'X' } });
    // 不创建 worktree 目录、不登记

    const plan = await planLegacyShardMigration(memoryRoot);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0].dir.endsWith(wtDir)).toBe(true);
    expect(plan.failed[0].skipReason).toBe('ambiguous-managed-worktree');
    const apply = summarizeApplyMigration(plan, { results: [], conflicts: [] });
    expect(apply.ok).toBe(false);
  });

  it('根盘托管路径推导保留 C:/ 而不是 C: (Codex 第十七轮)', () => {
    const derived = deriveCanonicalFromCindyWorktreePath('C:/.cindy-worktrees/name');
    expect(derived).toBe('C:/');
    expect(memoryScopeDirName(derived!)).toBe('C--');
    expect(deriveCanonicalFromCindyWorktreePath('C:/.cindy-worktrees/name/apps/a')).toBe('C:/apps/a');
    expect(deriveCanonicalFromCindyWorktreePath('/.cindy-worktrees/name')).toBe('/');
  });

  it('managedWorktreeRoot 保留 POSIX 前导斜杠 (Codex 3971230671)', () => {
    expect(managedWorktreeRoot('/repo/.cindy-worktrees/wt')).toBe('/repo/.cindy-worktrees/wt');
    expect(managedWorktreeRoot('/repo/.cindy-worktrees/wt/apps/a')).toBe('/repo/.cindy-worktrees/wt');
    expect(managedWorktreeRoot('/.cindy-worktrees/name')).toBe('/.cindy-worktrees/name');
    expect(managedWorktreeRoot('C:/repo/.cindy-worktrees/wt')).toBe('C:/repo/.cindy-worktrees/wt');
    expect(managedWorktreeRoot('C:/.cindy-worktrees/name')).toBe('C:/.cindy-worktrees/name');
    expect(managedWorktreeRoot('C:\\repo\\.cindy-worktrees\\wt')).toBe('C:/repo/.cindy-worktrees/wt');
    expect(managedWorktreeRoot('//server/share/repo/.cindy-worktrees/feat-x')).toBe(
      '//server/share/repo/.cindy-worktrees/feat-x',
    );
  });

  it('meta.json 为 JSON null → 该分片 skipped, 其余继续 (Codex 第十七轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    const bad = path.join(memoryRoot, 'bad-null-meta');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'meta.json'), 'null', 'utf8');
    await fs.writeFile(path.join(bad, 'feedback_a.md'), 'x', 'utf8');

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.some((s) => s.dir === bad)).toBe(true);
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(wtDir)).toBe(true);
  });

  it('UNC 托管路径静态推导保留 //server/share 前缀 (Codex 第十九轮)', () => {
    expect(
      deriveCanonicalFromCindyWorktreePath('//server/share/repo/.cindy-worktrees/feat-x'),
    ).toBe('//server/share/repo');
    expect(
      deriveCanonicalFromCindyWorktreePath('\\\\server\\share\\repo\\.cindy-worktrees\\feat-x\\apps\\a'),
    ).toBe('//server/share/repo/apps/a');
    expect(normalizeWindowsLocalScopeKey('C:foo')).toBe('C:foo');
    expect(normalizeWindowsLocalScopeKey('C:')).toBe('C:');
  });

  it('absPath 含父目录段 /.. → skipped, 不迁出 memoryRoot (Codex 3974301309)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    await makeShard('dotdot-root', { absPath: '/..', files: { 'feedback_a.md': 'pwn' } });
    await makeShard('dotdot-mid', { absPath: '/tmp/../etc', files: { 'feedback_a.md': 'pwn' } });
    await makeShard('dotdot-win', { absPath: 'C:/repo/../Windows', files: { 'feedback_a.md': 'pwn' } });
    await makeShard('dotdot-enc', {
      absPath: '/%2e%2e/etc',
      files: { 'feedback_a.md': 'pwn' },
    });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir.endsWith('dotdot-root'))?.skipReason).toBe(
      'parent-dir-traversal',
    );
    expect(plan.skipped.find((s) => s.dir.endsWith('dotdot-mid'))?.skipReason).toBe(
      'parent-dir-traversal',
    );
    expect(plan.skipped.find((s) => s.dir.endsWith('dotdot-win'))?.skipReason).toBe(
      'parent-dir-traversal',
    );
    expect(plan.skipped.find((s) => s.dir.endsWith('dotdot-enc'))?.skipReason).toBe(
      'parent-dir-traversal',
    );
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(wtDir)).toBe(true);
    expect(plan.emptyToDelete).toHaveLength(0);
    const result = await runLegacyShardMigration(plan);
    expect(result.results.every((r) => r.shard.dir.endsWith(wtDir) || r.action === 'skipped')).toBe(
      true,
    );
    expect(await fs.readFile(path.join(memoryRoot, 'dotdot-root', 'feedback_a.md'), 'utf8')).toContain(
      'pwn',
    );
  });

  it('过期 plan 的 canonicalDirName=.. → apply 拒绝 (Codex 3974301309)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const dir = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    plan.mergeCandidates[0].canonicalDirName = '..';
    plan.mergeCandidates[0].canonicalScopeKey = '/..';
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('parent-dir-traversal');
    expect(await fs.readFile(path.join(dir, 'feedback_a.md'), 'utf8')).toContain('X');
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('Windows 仅大小写不同的 shard 名视为同一 scope (Codex 3974544919)', async () => {
    const stored = 'C:/Repo';
    const resolved = 'C:/repo';
    const storedDir = sanitizeWorkdir(stored);
    const resolvedDir = sanitizeWorkdir(resolved);
    expect(storedDir).toBe('C--Repo');
    expect(resolvedDir).toBe('C--repo');
    expect(storedDir.toLowerCase()).toBe(resolvedDir.toLowerCase());
    await makeShard(storedDir, { absPath: stored, files: { 'feedback_a.md': 'keep' } });
    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => (fwd(wd) === fwd(stored) ? resolved : wd),
    });
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.all).toHaveLength(1);
    expect(plan.all[0].isLegacy).toBe(false);
    expect(plan.all[0].canonicalDirName).toBe(resolvedDir);
    expect(plan.all[0].canonicalScopeKey).toBe(resolved);
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(0);
    expect(await fs.readFile(path.join(memoryRoot, storedDir, 'feedback_a.md'), 'utf8')).toContain(
      'keep',
    );
  });

  it('过期 plan 仅大小写不同 → apply 拒绝 rename (Codex 3974544919)', async () => {
    const stored = 'C:/Repo';
    const dir = await makeShard(sanitizeWorkdir(stored), {
      absPath: stored,
      files: { 'feedback_a.md': 'keep' },
    });
    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => wd,
    });
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.all[0].isLegacy).toBe(false);
    plan.all[0].isLegacy = true;
    plan.all[0].canonicalScopeKey = 'C:/repo';
    plan.all[0].canonicalDirName = sanitizeWorkdir('C:/repo');
    plan.mergeCandidates.push(plan.all[0]);
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('case-only-alias');
    expect(await fs.readFile(path.join(dir, 'feedback_a.md'), 'utf8')).toContain('keep');
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('目录名与 meta.absPath 派生名不一致 → failed dir-name-mismatch (Codex 3974018438)', async () => {
    const realRepo = path.join(tmpRoot, 'real-repo');
    const otherRepo = path.join(tmpRoot, 'other-repo');
    const mismatched = 'copied-from-elsewhere';
    await makeShard(mismatched, { absPath: otherRepo, files: { 'feedback_a.md': 'keep' } });
    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => (fwd(wd) === fwd(otherRepo) ? fwd(realRepo) : wd),
    });
    expect(plan.failed.find((s) => s.dir.endsWith(mismatched))?.skipReason).toBe(
      'dir-name-mismatch',
    );
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.all).toHaveLength(0);
    expect(await fs.readFile(path.join(memoryRoot, mismatched, 'feedback_a.md'), 'utf8')).toContain(
      'keep',
    );
    expect(summarizeApplyMigration(plan, { results: [], conflicts: [] }).ok).toBe(false);
  });

  it('canonical 目标是 symlink → skipped, 不跟随写入 (Codex 3974544925)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const outside = path.join(tmpRoot, 'outside-canonical');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const linkDir = path.join(memoryRoot, mainDir);
    try {
      await fs.symlink(outside, linkDir, 'dir');
    } catch {
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir.endsWith(wtDir))?.skipReason).toBe('symlink-canonical');
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(0);
    expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(await fs.readFile(path.join(memoryRoot, wtDir, 'feedback_a.md'), 'utf8')).toContain(
      'legacy',
    );
  });

  it('过期 plan 的 canonical 目标 symlink → apply 拒绝 (Codex 3974544925)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const outside = path.join(tmpRoot, 'outside-stale-canonical');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const linkDir = path.join(memoryRoot, mainDir);
    try {
      await fs.symlink(outside, linkDir, 'dir');
    } catch {
      return;
    }
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('symlink-canonical');
    expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(await fs.readFile(path.join(memoryRoot, wtDir, 'feedback_a.md'), 'utf8')).toContain(
      'legacy',
    );
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('canonical 合法记录是 symlink → skipped, rebuildIndex 不跟随 (Codex 3975187669)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const mainPath = await makeShard(mainDir, { absPath: mainRepo });
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const outside = path.join(tmpRoot, 'outside-secret.md');
    await fs.writeFile(outside, 'secret-outside', 'utf8');
    try {
      await fs.symlink(outside, path.join(mainPath, 'project_secret.md'));
    } catch {
      return;
    }
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir.endsWith(wtDir))?.skipReason).toBe(
      'symlink-canonical-record',
    );
    expect(plan.mergeCandidates).toHaveLength(0);
    expect((await fs.lstat(path.join(mainPath, 'project_secret.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, 'utf8')).toBe('secret-outside');
  });

  it('过期 plan 的 canonical 记录 symlink → apply 拒绝 (Codex 3975187669)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtDir = sanitizeWorkdir(worktree);
    const mainPath = await makeShard(mainDir, {
      absPath: mainRepo,
      files: { 'feedback_keep.md': 'keep' },
    });
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'legacy' } });
    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.mergeCandidates).toHaveLength(1);
    const outside = path.join(tmpRoot, 'outside-stale-record.md');
    await fs.writeFile(outside, 'secret-outside', 'utf8');
    try {
      await fs.symlink(outside, path.join(mainPath, 'project_secret.md'));
    } catch {
      return;
    }
    const result = await runLegacyShardMigration(plan);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toBe('symlink-canonical-record');
    expect((await fs.lstat(path.join(mainPath, 'project_secret.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, 'utf8')).toBe('secret-outside');
    expect(await fs.readFile(path.join(memoryRoot, wtDir, 'feedback_a.md'), 'utf8')).toContain(
      'legacy',
    );
    expect(summarizeApplyMigration(plan, result).ok).toBe(false);
  });

  it('相对盘符 C:foo / 裸 C: 规划阶段 skipped (Codex 第十九轮 / 3972854297)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    await makeShard('rel-drive', { absPath: 'C:foo', files: { 'feedback_a.md': 'x' } });
    await makeShard('bare-drive', { absPath: 'C:', files: { 'feedback_a.md': 'y' } });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(plan.skipped.find((s) => s.dir.endsWith('rel-drive'))?.skipReason).toBe('relative-absPath');
    expect(plan.skipped.find((s) => s.dir.endsWith('bare-drive'))?.skipReason).toBe('relative-absPath');
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(wtDir)).toBe(true);
  });

  it('absPath 尾空格不 trim, 不误判 legacy (Codex 3972854308)', async () => {
    // 用 POSIX 形态, 避免 Windows 创建尾空格目录名失败; 身份仍是尾空格路径。
    const repo = '/home/project ';
    const dirName = sanitizeWorkdir(repo);
    await makeShard(dirName, { absPath: repo, files: { 'feedback_a.md': 'x' } });

    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => wd,
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.failed).toHaveLength(0);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.emptyToDelete).toHaveLength(0);
    expect(plan.all).toHaveLength(1);
    expect(plan.all[0].isLegacy).toBe(false);
    expect(plan.all[0].canonicalScopeKey).toBe(fwd(repo));
    expect(plan.all[0].canonicalDirName).toBe(dirName);
  });

  it('相对路径 absPath 规划阶段 skipped, 其余分片继续 (Codex 第十八轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    const relDir = 'relative-meta';
    await makeShard(relDir, { absPath: '..', files: { 'feedback_a.md': 'x' } });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const skipped = plan.skipped.find((s) => s.dir.endsWith(relDir));
    expect(skipped?.skipReason).toBe('relative-absPath');
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(wtDir)).toBe(true);
    expect(plan.failed).toHaveLength(0);
  });

  it('普通 linked worktree 文件形态 .git 解析回落 → failed (Codex 3974674280)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const liveWt = path.join(tmpRoot, 'plain-linked-wt');
    await fs.mkdir(liveWt, { recursive: true });
    await fs.writeFile(path.join(liveWt, '.git'), 'gitdir: ../repo/.git/worktrees/feat-x\n', 'utf8');
    const liveDir = sanitizeWorkdir(liveWt);
    await makeShard(liveDir, { absPath: liveWt, files: { 'feedback_a.md': 'X' } });
    const otherWt = path.join(tmpRoot, 'other-wt');
    const otherDir = sanitizeWorkdir(otherWt);
    await makeShard(otherDir, { absPath: otherWt, files: { 'feedback_b.md': 'Y' } });

    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd: string) => {
        if (fwd(wd) === fwd(liveWt)) return wd;
        if (fwd(wd) === fwd(otherWt)) return fwd(mainRepo);
        return wd;
      },
    });
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0].dir.endsWith(liveDir)).toBe(true);
    expect(plan.failed[0].skipReason).toBe('worktree-resolve-failure');
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(otherDir)).toBe(true);
    expect(plan.all.some((s) => s.dir.endsWith(liveDir))).toBe(false);
  });

  it('主仓 submodule 文件形态 .git (modules/) 解析回落 → 非 failed (Codex 3974808633)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const sub = path.join(mainRepo, 'mod');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, '.git'), 'gitdir: ../.git/modules/mod\n', 'utf8');
    const subDir = sanitizeWorkdir(sub);
    await makeShard(subDir, { absPath: sub, files: { 'feedback_a.md': 'X' } });
    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd: string) => wd,
    });
    expect(plan.failed).toHaveLength(0);
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.all.some((s) => s.dir.endsWith(subDir))).toBe(true);
    expect(plan.all.find((s) => s.dir.endsWith(subDir))?.isLegacy).toBe(false);
  });

  it('活托管 worktree 解析回落原路径 → failed, 计划不 abort (Codex 第十八轮)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const liveWt = path.join(mainRepo, '.cindy-worktrees', 'feat-x');
    await fs.mkdir(path.join(liveWt, '.git'), { recursive: true });
    await registerManagedWorktree(mainRepo, 'feat-x');
    const liveDir = sanitizeWorkdir(liveWt);
    await makeShard(liveDir, { absPath: liveWt, files: { 'feedback_a.md': 'X' } });

    const otherWt = path.join(tmpRoot, 'other-wt');
    const otherDir = sanitizeWorkdir(otherWt);
    await makeShard(otherDir, { absPath: otherWt, files: { 'feedback_b.md': 'Y' } });

    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd: string) => {
        if (fwd(wd) === fwd(liveWt)) return wd; // 模拟 git 超时/失败回落原路径
        if (fwd(wd) === fwd(otherWt)) return fwd(mainRepo);
        return wd;
      },
    });
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0].dir.endsWith(liveDir)).toBe(true);
    expect(plan.failed[0].skipReason).toBe('worktree-resolve-failure');
    expect(plan.mergeCandidates).toHaveLength(1);
    expect(plan.mergeCandidates[0].dir.endsWith(otherDir)).toBe(true);
  });

  it('POSIX 绝对路径已删 worktree → 判死并静态推导 (Codex 3971230671)', async () => {
    // 故意用 POSIX 前导 / 形态 (即使跑在 Windows CI): join(path.sep) 会丢掉
    // 前导斜杠, stop 对不上, 若本机碰巧有 /repo/.git 会把已删 worktree 判活。
    const posixMain = '/cindy-migrate-posix-dead-wt/repo';
    const posixWt = `${posixMain}/.cindy-worktrees/feat-x`;
    expect(managedWorktreeRoot(posixWt)).toBe(posixWt);
    expect(managedWorktreeRoot(`${posixWt}/apps/a`)).toBe(posixWt);
    const wtDir = sanitizeWorkdir(posixWt);
    await makeShard(wtDir, { absPath: posixWt, files: { 'feedback_a.md': 'X' } });
    // 不创建 worktree 目录、不登记 — 模拟 git worktree remove 之后
    // identity resolver: live 探测失败回落原路径, 走 isLiveGitRepo + 静态推导

    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd) => wd,
    });
    // 无登记、目录不存在 → 歧义, 不从路径形态并入 posixMain (Codex 3972854282)
    expect(plan.mergeCandidates).toHaveLength(0);
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0].skipReason).toBe('ambiguous-managed-worktree');
    expect(plan.failed[0].dir.endsWith(wtDir)).toBe(true);
  });

  it('--apply 汇总含 plan.failed 且 ok=false (Codex 3971230679)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const liveWt = path.join(mainRepo, '.cindy-worktrees', 'feat-x');
    await fs.mkdir(path.join(liveWt, '.git'), { recursive: true });
    await registerManagedWorktree(mainRepo, 'feat-x');
    const liveDir = sanitizeWorkdir(liveWt);
    await makeShard(liveDir, { absPath: liveWt, files: { 'feedback_a.md': 'X' } });

    const otherWt = path.join(tmpRoot, 'other-wt');
    const otherDir = sanitizeWorkdir(otherWt);
    await makeShard(otherDir, { absPath: otherWt, files: { 'feedback_b.md': 'Y' } });

    const plan = await planLegacyShardMigration(memoryRoot, {
      resolveScopeKey: async (wd: string) => {
        if (fwd(wd) === fwd(liveWt)) return wd;
        if (fwd(wd) === fwd(otherWt)) return fwd(mainRepo);
        return wd;
      },
    });
    const result = await runLegacyShardMigration(plan);
    const apply = summarizeApplyMigration(plan, result);
    expect(apply.failed).toHaveLength(1);
    expect(apply.failed[0].reason).toBe('worktree-resolve-failure');
    expect(apply.ok).toBe(false);
    expect(apply.shards.some((s) => s.dir.endsWith(otherDir))).toBe(true);
    expect(apply.shards.some((s) => s.dir.endsWith(liveDir))).toBe(false);
  });

  it('执行期 rename 失败 → ok=false 且错误列出 (Codex 3971991063)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan, {
      rename: async () => {
        throw new Error('EACCES rename');
      },
    });
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].error).toMatch(/EACCES rename/);
    const apply = summarizeApplyMigration(plan, result);
    expect(apply.ok).toBe(false);
    expect(apply.executionErrors).toHaveLength(1);
    expect(apply.executionErrors[0].error).toMatch(/EACCES rename/);
    expect(apply.failed).toHaveLength(0);
  });

  it('stale fts.db rm 失败 → 滚回 legacy 路径, 不报 renamed (Codex 3971991067 / 3975785141)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtPath = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'X' } });
    await fs.writeFile(path.join(wtPath, 'fts.db'), Buffer.from('stale-fts'));

    const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    const result = await runLegacyShardMigration(plan, {
      rmFile: async (filePath) => {
        if (String(filePath).includes('fts.db')) throw new Error('EBUSY fts.db');
      },
    });
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].action).not.toBe('renamed');
    expect(result.results[0].error).toMatch(/post-rename failed, rolled back/);
    expect(result.results[0].error).toMatch(/EBUSY fts.db/);
    const apply = summarizeApplyMigration(plan, result);
    expect(apply.ok).toBe(false);
    expect(apply.executionErrors).toHaveLength(1);
    // 滚回后 planner 仍能把该分片当 legacy 重跑
    await expect(fs.stat(path.join(memoryRoot, mainDir))).rejects.toThrow();
    expect(await fs.readFile(path.join(wtPath, 'feedback_a.md'), 'utf8')).toContain('X');
    const meta = JSON.parse(await fs.readFile(path.join(wtPath, 'meta.json'), 'utf8')) as {
      absPath: string;
    };
    expect(meta.absPath).toBe(worktree);
    const retry = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
    expect(retry.mergeCandidates).toHaveLength(1);
    expect(retry.mergeCandidates[0].dir).toBe(wtPath);
    expect(retry.failed).toHaveLength(0);
  });

  it('快路径 updateMetaAbsPath 失败 → 滚回 shard.dir, 可重跑 (Codex 3975785141)', async () => {
    const mainRepo = path.join(tmpRoot, 'repo');
    const worktree = path.join(tmpRoot, 'repo-wt');
    const wtDir = sanitizeWorkdir(worktree);
    const mainDir = sanitizeWorkdir(mainRepo);
    const wtPath = await makeShard(wtDir, { absPath: worktree, files: { 'feedback_a.md': 'keep' } });
    const origWrite = fs.writeFile.bind(fs);
    let blockedCanonicalMeta = false;
    // @ts-expect-error 测试注入: 第一次写 canonical meta.json 失败, 回滚写出放行
    fs.writeFile = async (p: string, data: string | Buffer, encoding?: BufferEncoding) => {
      if (
        !blockedCanonicalMeta &&
        typeof p === 'string' &&
        p.endsWith(`${path.sep}meta.json`) &&
        p.includes(mainDir)
      ) {
        blockedCanonicalMeta = true;
        throw Object.assign(new Error('EROFS meta.json'), { code: 'EROFS' });
      }
      return origWrite(p, data, encoding);
    };
    try {
      const plan = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
      const result = await runLegacyShardMigration(plan);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].action).toBe('skipped');
      expect(result.results[0].error).toMatch(/post-rename failed, rolled back/);
      expect(result.results[0].error).toMatch(/EROFS meta.json/);
      expect(summarizeApplyMigration(plan, result).ok).toBe(false);
      await expect(fs.stat(path.join(memoryRoot, mainDir))).rejects.toThrow();
      expect(await fs.readFile(path.join(wtPath, 'feedback_a.md'), 'utf8')).toContain('keep');
      const meta = JSON.parse(await fs.readFile(path.join(wtPath, 'meta.json'), 'utf8')) as {
        absPath: string;
      };
      expect(meta.absPath).toBe(worktree);
      const retry = await planLegacyShardMigration(memoryRoot, fakeResolver(mainRepo, worktree));
      expect(retry.mergeCandidates).toHaveLength(1);
      expect(retry.mergeCandidates[0].dir).toBe(wtPath);
      expect(retry.failed.find((s) => s.skipReason === 'dir-name-mismatch')).toBeUndefined();
    } finally {
      fs.writeFile = origWrite;
    }
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

  it('findChangedAfterMerge 读取失败 → 视为 changed, 保留源目录 (Greptile 第十三轮)', async () => {
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
    // 模拟内容复查读目标失败 (源被并发删/目标异常) — 无法证明一致时必须
    // 保留源目录, 而不是跳过校验删掉未验证的最新记忆
    const origReadFile = fs.readFile.bind(fs);
    let reads = 0;
    // @ts-expect-error 测试注入
    fs.readFile = async (...args) => {
      const [p] = args;
      if (typeof p === 'string' && p.endsWith('feedback_a.md')) {
        reads += 1;
        // mergeFilesInto 内比较读源+目标 (前 2 次) 正常; findChangedAfterMerge
        // 内容复查 (第 3 次起) 抛错 → 触发 catch → changed
        if (reads >= 3) throw new Error('ENOENT: simulated read failure');
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

  it('rename 后最终复查检测内容更新 → 恢复原目录 (Greptile/Codex 第七轮)', async () => {
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
    // 模拟存量会话在 rename 前、首次内容复查后改写同名记忆:
    // 第 1 次读源 (mergeFilesInto) → 真实 (same-skipped);
    // 第 2 次 (rename 前 findChangedAfterMerge) → 真实 (通过);
    // 第 3 次起 (rename 后最终复查) → X2 → trashChanged 命中 → 恢复源目录。
    const origReadFile = fs.readFile.bind(fs);
    let srcReads = 0;
    // @ts-expect-error 测试注入
    fs.readFile = async (...args) => {
      const [p] = args;
      if (
        typeof p === 'string' &&
        (p.startsWith(wtPath + path.sep) || p.includes('.trash-')) &&
        p.endsWith('feedback_a.md')
      ) {
        srcReads += 1;
        return srcReads >= 3 ? Buffer.from('X2') : origReadFile(...args);
      }
      return origReadFile(...args);
    };
    try {
      const result = await runLegacyShardMigration(plan);
      expect(result.results[0].error).toContain('content appeared or changed before remove');
      // 源目录保留 (trash 被恢复回原名)
      await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    } finally {
      fs.readFile = origReadFile;
    }
  });

  it('同数替换 (删 A 建 B) → 文件名集合对比兜底, 源目录保留 (Codex 第六轮)', async () => {
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
    // 模拟 mergeFilesInto 快照后存量会话同数替换: 删 feedback_a.md 建 project_b.md。
    // patch fs.readdir: 第 1 次 (mergeFilesInto 快照) 返回真实 [feedback_a.md];
    // 之后 (diffShardFilenames 复查) 返回 [project_b.md] — 数量不变 (1→1)。
    const origReaddir = fs.readdir.bind(fs);
    let dirReads = 0;
    // @ts-expect-error 测试注入
    fs.readdir = async (p) => {
      if (typeof p === 'string' && p === wtPath) {
        dirReads += 1;
        // apply 先 lstat 扫描 symlink 分片文件 (readdir #1), mergeFilesInto
        // 快照是 #2; 之后的复查才模拟同数替换, 否则 dest 读 ENOENT。
        return dirReads <= 2 ? ['feedback_a.md', 'meta.json'] : ['project_b.md', 'meta.json'];
      }
      return origReaddir(p);
    };
    try {
      const result = await runLegacyShardMigration(plan);
      // added=1 (project_b.md) + missing=1 (feedback_a.md) → 保留源目录
      expect(result.results[0].error).toContain('filename set changed');
      await expect(fs.stat(wtPath)).resolves.toBeTruthy();
    } finally {
      fs.readdir = origReaddir;
    }
  });
});
