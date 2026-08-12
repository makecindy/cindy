/**
 * migrate.ts — 存量 worktree 分片迁移 (P0 第二阶段, #2379) 的真实 Git 端到端。
 *
 * 属于 git-integration tier (`pnpm test:git-integration`), 不在默认 unit
 * tier 运行 (engineering-conventions §3.1): 每个用例建临时仓库 + linked
 * worktree + 真实分片目录, 用**真实** resolveMemoryScopeKey (spawn git)
 * 验证「worktree 分片 → 主仓 canonical 分片」的完整链路。
 *
 * 默认 unit 层 (fake resolver + 临时目录) 见 migrate.test.ts。
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  planLegacyShardMigration,
  runLegacyShardMigration,
} from './migrate.js';
import { sanitizeWorkdir } from './storage.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable())('存量 worktree 分片迁移 — 真实 git 端到端', () => {
  /** 建临时主仓 + linked worktree + 分片布局 (主仓有 canonical 分片, worktree 有 legacy 分片)。 */
  async function makeFixture() {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-git-')));
    const repoRoot = path.join(tmpRoot, 'repo');
    const wt = path.join(tmpRoot, 'wt');
    const memoryRoot = path.join(tmpRoot, 'maker-memory');
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });

    await fs.mkdir(repoRoot, { recursive: true });
    git(['init'], repoRoot);
    git(['config', 'user.email', 'test@example.com'], repoRoot);
    git(['config', 'user.name', 'migrate-git-test'], repoRoot);
    git(['commit', '--allow-empty', '-m', 'init'], repoRoot);
    git(['worktree', 'add', '-b', 'wt-branch', wt], repoRoot);

    await fs.mkdir(memoryRoot, { recursive: true });

    // 主仓 canonical 分片: 已有 feedback_a.md (内容 X)
    const mainDir = path.join(memoryRoot, sanitizeWorkdir(repoRoot));
    await fs.mkdir(mainDir, { recursive: true });
    await fs.writeFile(
      path.join(mainDir, 'meta.json'),
      JSON.stringify({ absPath: repoRoot, createdAt: 't0', lastUsedAt: 't0' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(mainDir, 'feedback_a.md'),
      '---\ntitle: A\ndescription: DA\ntype: feedback\nupdatedAt: 2026-08-12T00:00:00.000Z\n---\n\nX',
      'utf8',
    );

    // worktree legacy 分片: feedback_a.md 内容 X (重复) + project_b.md (新)
    const wtDir = path.join(memoryRoot, sanitizeWorkdir(wt));
    await fs.mkdir(wtDir, { recursive: true });
    await fs.writeFile(
      path.join(wtDir, 'meta.json'),
      JSON.stringify({ absPath: wt, createdAt: 't0', lastUsedAt: 't0' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(wtDir, 'feedback_a.md'),
      '---\ntitle: A\ndescription: DA\ntype: feedback\nupdatedAt: 2026-08-12T00:00:00.000Z\n---\n\nX',
      'utf8',
    );
    await fs.writeFile(
      path.join(wtDir, 'project_b.md'),
      '---\ntitle: B\ndescription: DB\ntype: project\nupdatedAt: 2026-08-12T00:00:00.000Z\n---\n\nY',
      'utf8',
    );

    const cleanup = async () => {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
    };
    return { tmpRoot, repoRoot, wt, memoryRoot, mainDir, wtDir, cleanup };
  }

  it('worktree legacy 分片合并进主仓 canonical 分片 (真实 resolver)', async () => {
    const f = await makeFixture();
    try {
      // 真实 resolveMemoryScopeKey: wt → repoRoot
      const plan = await planLegacyShardMigration(f.memoryRoot);
      expect(plan.mergeCandidates).toHaveLength(1);
      expect(plan.mergeCandidates[0].canonicalDirName).toBe(sanitizeWorkdir(f.repoRoot));
      expect(plan.mergeCandidates[0].recordCount).toBe(2);

      const result = await runLegacyShardMigration(plan);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].action).toBe('merged');
      expect(result.results[0].mergedFiles).toEqual(
        expect.arrayContaining([
          { filename: 'feedback_a.md', outcome: 'same-skipped' },
          { filename: 'project_b.md', outcome: 'copied' },
        ]),
      );

      // worktree 分片目录被删 (无冲突)
      await expect(fs.stat(f.wtDir)).rejects.toThrow();
      // 主仓分片包含合并结果
      const target = f.mainDir;
      expect(await fs.readFile(path.join(target, 'project_b.md'), 'utf8')).toContain('Y');
      const index = await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8');
      expect(index).toContain('feedback_a.md');
      expect(index).toContain('project_b.md');
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it('幂等: 迁移后二次扫描不再产生迁移项', async () => {
    const f = await makeFixture();
    try {
      const plan1 = await planLegacyShardMigration(f.memoryRoot);
      await runLegacyShardMigration(plan1);

      const plan2 = await planLegacyShardMigration(f.memoryRoot);
      expect(plan2.mergeCandidates).toHaveLength(0);
      expect(plan2.emptyToDelete).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  }, 30_000);
});
