import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 60_000 });

import { runGit } from '../../git-review/gitRunner';
import { readStatus } from '../../git-review/statusReader';
import type { ReviewScope } from '../../git-review/types';
import {
  readReviewSubmoduleIdentity,
  ReviewSubmoduleIdentityError,
} from '../reviewSubmoduleIdentity';

let workRoot: string;
let parentPath: string;

const canLinkFile = (() => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'review-submodule-file-link-probe-'));
  try {
    const target = path.join(root, 'target');
    fsSync.writeFileSync(target, 'probe');
    fsSync.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
})();

// CI runner 没有全局 git 身份;每个会执行 commit 的仓库(含 submodule 克隆)都要配本地身份。
async function configureRepo(dir: string): Promise<void> {
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(['init'], { cwd: dir });
  await configureRepo(dir);
}

/** 父仓 + 已初始化 submodule(vendor/lib,含一个已提交文件 inner.txt)。 */
async function setupParentWithSubmodule(): Promise<{ parent: string; sub: string }> {
  const upstream = path.join(workRoot, 'lib-upstream');
  await initRepo(upstream);
  await fs.writeFile(path.join(upstream, 'inner.txt'), 'inner-v1\n');
  await runGit(['add', 'inner.txt'], { cwd: upstream });
  await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });

  const parent = path.join(workRoot, 'parent');
  await initRepo(parent);
  await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
  await runGit(['add', 'root.txt'], { cwd: parent });
  await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
  await runGit(
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor/lib'],
    { cwd: parent },
  );
  await runGit(['commit', '--no-gpg-sign', '-m', 'add submodule'], { cwd: parent });
  const sub = path.join(parent, 'vendor', 'lib');
  await configureRepo(sub);
  return { parent, sub };
}

beforeEach(async () => {
  workRoot = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'xdt-review-submodule-'));
  parentPath = '';
});

afterEach(async () => {
  await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('readReviewSubmoduleIdentity (#2463)', () => {
  it('binds inner dirty content: swapping one internal edit for another changes the manifest', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const inner = path.join(sub, 'inner.txt');

    // 内部改动 A:同长度字节,父仓 porcelain 只有一个 dirty 布尔位可看。
    await fs.writeFile(inner, 'inner-vA\n');
    const withEditA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    // 内部改动 B:同尺寸另一份 —— #2463 的攻击形态。
    await fs.writeFile(inner, 'inner-vB\n');
    const withEditB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(withEditA.identities).toHaveLength(1);
    expect(withEditA.hashedContent).toBe(true);
    expect(withEditB.identities).not.toEqual(withEditA.identities);
  });

  it('binds the inner staged identity: index blob swap with restored worktree changes the manifest', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const inner = path.join(sub, 'inner.txt');

    await fs.writeFile(inner, 'inner-vA\n');
    await runGit(['add', 'inner.txt'], { cwd: sub });
    const stagedA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    // 换 index blob 后把工作树字节还原:工作树哈希看不出差异,靠 staged 身份。
    await fs.writeFile(inner, 'inner-vB\n');
    await runGit(['add', 'inner.txt'], { cwd: sub });
    await fs.writeFile(inner, 'inner-vA\n');
    const stagedB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(stagedB.identities).not.toEqual(stagedA.identities);
  });

  it('keeps a clean submodule manifest stable and records gitlink + inner HEAD', async () => {
    const { parent } = await setupParentWithSubmodule();
    parentPath = parent;

    const first = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    const second = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(second).toEqual(first);
    const identity = first.identities[0];
    expect(identity.path).toBe('vendor/lib');
    expect(identity.indexRecord).toMatch(/^160000 0 [0-9a-f]{40,64}$/);
    expect(identity.headRecord).toMatch(/^160000 commit [0-9a-f]{40,64}$/);
    expect(identity.subHead).toMatch(/^[0-9a-f]{40,64}$/);
    expect(identity.stagedIdentity).toEqual([]);
    expect(identity.dirtyContentFingerprint).toBeNull();
    expect(first.hashedContent).toBe(false);
  });

  it('changes the manifest when the inner checkout moves to another commit', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const before = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    await fs.writeFile(path.join(sub, 'inner.txt'), 'inner-v2\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'inner v2'], { cwd: sub });
    const after = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(after.identities[0].subHead).not.toBe(before.identities[0].subHead);
    // 父仓 gitlink 记录(index / HEAD tree)不动 —— 变化只发生在子仓内部。
    expect(after.identities[0].indexRecord).toBe(before.identities[0].indexRecord);
  });

  it('records an uninitialized submodule without touching inner state', async () => {
    const { parent } = await setupParentWithSubmodule();
    parentPath = parent;
    // 模拟未初始化:清掉子仓工作区,只留空目录(gitlink 仍在 index/HEAD)。
    await runGit(['submodule', 'deinit', '-f', 'vendor/lib'], { cwd: parent });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities[0].subHead).toBe('uninitialized');
    expect(result.identities[0].indexRecord).toMatch(/^160000 0 [0-9a-f]{40,64}$/);
    expect(result.hashedContent).toBe(false);
  });

  // Windows 无 POSIX 权限位,chmod 000 制造不出读取失败。
  it.skipIf(process.platform === 'win32')(
    'fails closed (not uninitialized) when the submodule worktree is unreadable',
    async () => {
      const { parent, sub } = await setupParentWithSubmodule();
      parentPath = parent;
      try {
        await fs.chmod(sub, 0o000);
        await expect(
          readReviewSubmoduleIdentity(parentPath, ['vendor/lib']),
        ).rejects.toThrow();
      } finally {
        await fs.chmod(sub, 0o755);
      }
    },
  );

  it('treats a fully removed submodule worktree as uninitialized', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    await runGit(['submodule', 'deinit', '-f', 'vendor/lib'], { cwd: parent });
    await fs.rm(sub, { recursive: true, force: true });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities[0].subHead).toBe('uninitialized');
  });

  it('shares one content-hash budget across submodules instead of resetting per repo', async () => {
    // 两个子仓各有一个 6 字节 dirty 文件:预算 8 字节 —— 单个子仓够用,两个
    // 合计超限。共享预算必须在第二个子仓 fail closed;按子仓重置则两个都过。
    const upstream = path.join(workRoot, 'lib-upstream');
    await initRepo(upstream);
    await fs.writeFile(path.join(upstream, 'inner.txt'), 'seed\n');
    await runGit(['add', 'inner.txt'], { cwd: upstream });
    await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });

    const parent = path.join(workRoot, 'parent');
    await initRepo(parent);
    await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
    await runGit(['add', 'root.txt'], { cwd: parent });
    await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
    for (const name of ['vendor/a', 'vendor/b']) {
      await runGit(
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, name],
        { cwd: parent },
      );
      await configureRepo(path.join(parent, ...name.split('/')));
    }
    await runGit(['commit', '--no-gpg-sign', '-m', 'add submodules'], { cwd: parent });
    parentPath = parent;
    await fs.writeFile(path.join(parent, 'vendor', 'a', 'inner.txt'), 'dirtyA\n');
    await fs.writeFile(path.join(parent, 'vendor', 'b', 'inner.txt'), 'dirtyB\n');

    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/a'], { maxContentBytes: 8 }),
    ).resolves.toBeTruthy();
    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/b'], { maxContentBytes: 8 }),
    ).resolves.toBeTruthy();
    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/a', 'vendor/b'], { maxContentBytes: 8 }),
    ).rejects.toThrow();
  });

  it('binds a gitlink-to-regular-file typechange to the file bytes instead of erroring', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    // 用户把整个 submodule 目录换成同名普通文件(porcelain 仍标 S,statusReader
    // 会把它当 submodule 送进来)。
    await fs.rm(sub, { recursive: true, force: true });
    await fs.writeFile(sub, 'file-vA\n');

    const withA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(withA.identities[0].subHead).toBe('typechange');
    expect(withA.identities[0].dirtyContentFingerprint).not.toBeNull();
    expect(withA.hashedContent).toBe(true);

    // 同尺寸另一份字节必须被身份变化捕获。
    await fs.writeFile(sub, 'file-vB\n');
    const withB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(withB.identities).not.toEqual(withA.identities);
  });

  it('queries inner paths in pathspec batches identically to a single call', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    for (const name of ['d1.txt', 'd2.txt', 'd3.txt']) {
      await fs.writeFile(path.join(sub, name), `${name}\n`);
    }
    await runGit(['add', '--', 'd1.txt', 'd2.txt'], { cwd: sub });

    const single = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    const batched = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib'], {
      batch: { maxBatchPaths: 1, maxBatchPathspecBytes: 8 },
    });
    expect(batched).toEqual(single);
  });

  it('counts staged identity records against the shared path budget', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    await fs.writeFile(path.join(sub, 's1.txt'), 'one\n');
    await fs.writeFile(path.join(sub, 's2.txt'), 'two\n');
    await runGit(['add', '--', 's1.txt', 's2.txt'], { cwd: sub });

    // 预算按「子仓条目 1 + staged 记录 2 = 3」消耗:2 不够,3 恰好。
    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/lib'], { maxContentPaths: 2 }),
    ).rejects.toThrow(/content-path budget/);
    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/lib'], { maxContentPaths: 3 }),
    ).resolves.toBeTruthy();
  });

  it('allows the shared byte budget to be exactly exhausted by earlier submodules', async () => {
    const upstream = path.join(workRoot, 'lib-upstream');
    await initRepo(upstream);
    await fs.writeFile(path.join(upstream, 'inner.txt'), 'seed\n');
    await runGit(['add', 'inner.txt'], { cwd: upstream });
    await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });

    const parent = path.join(workRoot, 'parent');
    await initRepo(parent);
    await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
    await runGit(['add', 'root.txt'], { cwd: parent });
    await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
    for (const name of ['vendor/a', 'vendor/b']) {
      await runGit(
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, name],
        { cwd: parent },
      );
      await configureRepo(path.join(parent, ...name.split('/')));
    }
    await runGit(['commit', '--no-gpg-sign', '-m', 'add submodules'], { cwd: parent });
    parentPath = parent;
    // vendor/a 的 7 字节文件恰好吃满预算;vendor/b 只有零字节 dirty 文件,
    // 不需要再读任何字节 —— 不允许恰好用尽会在这里误报超限。
    await fs.writeFile(path.join(parent, 'vendor', 'a', 'inner.txt'), 'dirtyA\n');
    await fs.writeFile(path.join(parent, 'vendor', 'b', 'zero.txt'), '');

    await expect(
      readReviewSubmoduleIdentity(parentPath, ['vendor/a', 'vendor/b'], { maxContentBytes: 7 }),
    ).resolves.toBeTruthy();
  });

  it('records every index stage for an unmerged gitlink instead of keeping only the last', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const { stdout: baseOut } = await runGit(['rev-parse', 'HEAD'], { cwd: sub });
    const base = baseOut.trim();

    // 子仓分叉出两个互不为祖先的 commit(祖先关系会被 gitlink 合并自动收敛,
    // 构造不出冲突),父仓两个分支各记一个 → merge 后 index 里 stage 1/2/3。
    await runGit(['checkout', '-b', 'left'], { cwd: parent });
    await fs.writeFile(path.join(sub, 'inner.txt'), 'sub-left\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'sub left'], { cwd: sub });
    await runGit(['add', 'vendor/lib'], { cwd: parent });
    await runGit(['commit', '--no-gpg-sign', '-m', 'parent left'], { cwd: parent });

    await runGit(['checkout', '-b', 'right', 'HEAD~1'], { cwd: parent });
    await runGit(['checkout', base], { cwd: sub });
    await fs.writeFile(path.join(sub, 'inner.txt'), 'sub-right\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'sub right'], { cwd: sub });
    await runGit(['add', 'vendor/lib'], { cwd: parent });
    await runGit(['commit', '--no-gpg-sign', '-m', 'parent right'], { cwd: parent });

    await runGit(['merge', 'left'], { cwd: parent, allowedExitCodes: [0, 1] });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    const rows = result.identities[0].indexRecord.split(',');
    expect(rows).toHaveLength(3);
    expect([...rows].sort()).toEqual(rows);
    expect(rows.map((row) => row.split(' ')[1]).sort()).toEqual(['1', '2', '3']);
    for (const row of rows) {
      expect(row).toMatch(/^160000 [123] [0-9a-f]{40,64}$/);
    }
  });

  it('records an initialized checkout with unborn HEAD as unborn', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    // orphan checkout:HEAD 指向尚不存在的 ref —— 已初始化空仓的合法形态。
    await runGit(['checkout', '--orphan', 'fresh'], { cwd: sub });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities[0].subHead).toBe('unborn');
  });

  it('fails closed when the parent repository cannot be read', async () => {
    await expect(
      readReviewSubmoduleIdentity(path.join(workRoot, 'no-such-repo'), ['vendor/lib']),
    ).rejects.toThrow();
  });
});

/**
 * 自底向上构造 levels 层子仓链:chain-l{levels} 是最内层普通仓(含 leaf.txt),
 * 每一层把下一层作为 child 子仓;父仓把 chain-l1 挂在 vendor/lib,随后
 * `submodule update --init --recursive` 初始化全链。返回最内层 worktree 路径。
 * 注意:嵌套子仓只有**脏了**才会出现在上层 status 里、才会被递归绑定 ——
 * 用例都先改脏最内层再读 manifest。
 */
async function setupNestedChain(levels: number): Promise<{ parent: string; innermost: string }> {
  let upstream = path.join(workRoot, `chain-l${levels}`);
  await initRepo(upstream);
  await fs.writeFile(path.join(upstream, 'leaf.txt'), 'leaf-v1\n');
  await runGit(['add', 'leaf.txt'], { cwd: upstream });
  await runGit(['commit', '--no-gpg-sign', '-m', 'leaf seed'], { cwd: upstream });
  for (let i = levels - 1; i >= 1; i -= 1) {
    const repo = path.join(workRoot, `chain-l${i}`);
    await initRepo(repo);
    await fs.writeFile(path.join(repo, `file-l${i}.txt`), `l${i}\n`);
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '--no-gpg-sign', '-m', `l${i} seed`], { cwd: repo });
    await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'child'], {
      cwd: repo,
    });
    await runGit(['commit', '--no-gpg-sign', '-m', 'add child'], { cwd: repo });
    upstream = repo;
  }
  const parent = path.join(workRoot, 'parent-nested');
  await initRepo(parent);
  await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
  await runGit(['add', 'root.txt'], { cwd: parent });
  await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
  await runGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor/lib'], {
    cwd: parent,
  });
  await runGit(['commit', '--no-gpg-sign', '-m', 'add submodule'], { cwd: parent });
  await runGit(
    ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'],
    { cwd: parent },
  );
  const innermost = path.join(parent, 'vendor', 'lib', ...Array(levels - 1).fill('child'));
  return { parent, innermost };
}

describe('readReviewSubmoduleIdentity 嵌套递归 (#2463 维护者 review)', () => {
  it('binds nested submodule content: an innermost edit changes the outer manifest', async () => {
    const { parent, innermost } = await setupNestedChain(2);
    parentPath = parent;
    const leaf = path.join(innermost, 'leaf.txt');

    await fs.writeFile(leaf, 'leaf-vA\n');
    const withEditA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    await fs.writeFile(leaf, 'leaf-vB\n');
    const withEditB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    // 递归确实展开了内层:外层身份携带 nested 子身份,且内层内容参与指纹。
    expect(withEditA.identities).toHaveLength(1);
    expect(withEditA.identities[0].nested).toHaveLength(1);
    expect(withEditA.identities[0].nested[0].path).toBe('child');
    expect(withEditA.identities[0].nested[0].dirtyContentFingerprint).not.toBeNull();
    expect(withEditA.hashedContent).toBe(true);
    // 内层同尺寸字节替换必须改变外层 manifest —— #2463 攻击形态的嵌套版。
    expect(withEditB.identities).not.toEqual(withEditA.identities);
  });

  it('fails closed when the dirty chain nests deeper than the recursion cap', async () => {
    // 6 层脏链:vendor/lib 为深度 1,最内层为深度 6 > MAX(5) —— 必须整体拒绝,
    // 不允许静默截断(截断会让更深处的内容变化映射到同一 manifest)。
    const { parent, innermost } = await setupNestedChain(6);
    parentPath = parent;
    await fs.writeFile(path.join(innermost, 'leaf.txt'), 'leaf-dirty\n');

    await expect(readReviewSubmoduleIdentity(parentPath, ['vendor/lib'])).rejects.toThrow(
      /nested deeper than 5/,
    );
  });
});

describe('readReviewSubmoduleIdentity 路径边界 (#2463 review)', () => {
  // Windows 文件系统不允许目录名以空格结尾,该形态仅在 POSIX 侧存在。
  it.skipIf(process.platform === 'win32')(
    'binds a submodule whose directory name ends with a space (no path trim)',
    async () => {
      const upstream = path.join(workRoot, 'lib-upstream-sp');
      await initRepo(upstream);
      await fs.writeFile(path.join(upstream, 'inner.txt'), 'inner-v1\n');
      await runGit(['add', 'inner.txt'], { cwd: upstream });
      await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });

      const parent = path.join(workRoot, 'parent-space');
      await initRepo(parent);
      await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
      await runGit(['add', 'root.txt'], { cwd: parent });
      await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
      // 目录名以空格结尾:macOS/Linux 文件系统与 git 都合法。rev-parse
      // --show-toplevel 输出被 trim 会裁掉路径本身的尾随空格,realpath 查错
      // 路径 → 整次 Review 失败。
      await runGit(
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor/lib '],
        { cwd: parent },
      );
      await runGit(['commit', '--no-gpg-sign', '-m', 'add submodule'], { cwd: parent });
      const sub = path.join(parent, 'vendor', 'lib ');
      await configureRepo(sub);
      await fs.writeFile(path.join(sub, 'inner.txt'), 'inner-dirty\n');

      const result = await readReviewSubmoduleIdentity(parent, ['vendor/lib ']);
      expect(result.identities).toHaveLength(1);
      expect(result.identities[0].subHead).not.toBe('uninitialized');
      expect(result.identities[0].dirtyContentFingerprint).not.toBeNull();
    },
  );
});

describe('readReviewSubmoduleIdentity 路径边界:尾随回车 (#2463 review)', () => {
  // Windows 文件名不可能含 \r,该形态仅在 POSIX 侧存在。git 的 submodule
  // porcelain 会规范掉路径尾随 \r,所以用「直接 clone + update-index 手工
  // 注册 gitlink」构造:身份读取只依赖 index 里的 gitlink 记录与目录自身的
  // git toplevel 归属,不依赖 .gitmodules。
  it.skipIf(process.platform === 'win32')(
    'binds a submodule whose directory name ends with a carriage return',
    async () => {
      const upstream = path.join(workRoot, 'lib-upstream-cr');
      await initRepo(upstream);
      await fs.writeFile(path.join(upstream, 'inner.txt'), 'inner-v1\n');
      await runGit(['add', 'inner.txt'], { cwd: upstream });
      await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });
      const { stdout: headOut } = await runGit(['rev-parse', 'HEAD'], { cwd: upstream });
      const innerHead = headOut.trim();

      const parent = path.join(workRoot, 'parent-cr');
      await initRepo(parent);
      await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
      await runGit(['add', 'root.txt'], { cwd: parent });
      await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
      const subName = 'vendor/lib\r';
      const sub = path.join(parent, 'vendor', 'lib\r');
      await runGit(['clone', upstream, sub], { cwd: parent });
      await configureRepo(sub);
      await runGit(['update-index', '--add', '--cacheinfo', `160000,${innerHead},${subName}`], {
        cwd: parent,
      });
      await fs.writeFile(path.join(sub, 'inner.txt'), 'inner-dirty\n');

      const result = await readReviewSubmoduleIdentity(parent, [subName]);
      expect(result.identities).toHaveLength(1);
      expect(result.identities[0].subHead).not.toBe('uninitialized');
      expect(result.identities[0].dirtyContentFingerprint).not.toBeNull();
    },
  );
});

describe('readReviewSubmoduleIdentity 无身份目录 (#2463 review)', () => {
  it('fails closed when the gitlink path is a non-empty plain directory without git identity', async () => {
    // .git 被移除、路径被普通目录 + 任意文件替换:porcelain 仍是同一条 S 记录,
    // 目录字节没有任何身份来源 —— 归入固定 'uninitialized' 会让不同内容映射到
    // 同一 manifest,必须整体拒绝。
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    await fs.rm(sub, { recursive: true, force: true });
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'arbitrary.txt'), 'not-a-repo\n');

    await expect(readReviewSubmoduleIdentity(parentPath, ['vendor/lib'])).rejects.toThrow(
      /no git identity but is not empty/,
    );
  });

  it('still records an empty deinit-style directory as uninitialized', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    await fs.rm(sub, { recursive: true, force: true });
    await fs.mkdir(sub, { recursive: true });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities[0].subHead).toBe('uninitialized');
  });
});

describe('readReviewSubmoduleIdentity ignore 配置 (#2463 review)', () => {
  it('binds nested dirty content even when submodule.ignore=all is configured', async () => {
    // 子仓配置 submodule.<name>.ignore=all 会让 status 省略脏的嵌套子仓 ——
    // 身份绑定必须显式 --ignore-submodules=none 无视该配置,否则内层内容
    // 替换不进 nested manifest,旧结论照样通过新鲜度门。
    const { parent, innermost } = await setupNestedChain(2);
    parentPath = parent;
    const outerSub = path.join(parent, 'vendor', 'lib');
    await runGit(['config', 'submodule.child.ignore', 'all'], { cwd: outerSub });
    const leaf = path.join(innermost, 'leaf.txt');

    await fs.writeFile(leaf, 'leaf-vA\n');
    const withEditA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    await fs.writeFile(leaf, 'leaf-vB\n');
    const withEditB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(withEditA.identities[0].nested).toHaveLength(1);
    expect(withEditB.identities).not.toEqual(withEditA.identities);
  });
});

describe('readReviewSubmoduleIdentity index 已删的嵌套 gitlink (#2463 review)', () => {
  it('binds a nested checkout whose gitlink was removed from the index (git rm --cached)', async () => {
    // 外层子仓 git rm --cached child 保留内层 checkout:status 为 D child +
    // ?? child/。gitlink 判定须并入 HEAD tree,否则保留目录被当普通 worktree
    // 路径喂给文件指纹器抛错、Review 无法启动。
    const { parent, innermost } = await setupNestedChain(2);
    parentPath = parent;
    const outerSub = path.join(parent, 'vendor', 'lib');
    await runGit(['rm', '--cached', 'child'], { cwd: outerSub });
    await fs.writeFile(path.join(innermost, 'leaf.txt'), 'leaf-dirty\n');

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities).toHaveLength(1);
    const nested = result.identities[0].nested;
    expect(nested).toHaveLength(1);
    expect(nested[0].path).toBe('child');
    // index 里已无 gitlink:indexRecord 记 absent,但 HEAD 记录与内层身份仍绑定。
    expect(nested[0].indexRecord).toBe('absent');
    expect(nested[0].subHead).not.toBe('uninitialized');
  });
});

describe('readReviewSubmoduleIdentity intent-to-add 状态绑定 (#2463 review)', () => {
  it('distinguishes an intent-to-add file from the same bytes after git reset', async () => {
    // 子仓内 `git add -N new.txt` 与其 `git reset` 后:文件字节相同、内容指纹
    // 相同、staged 身份两态都为空(ita 条目 porcelain 记 ` A`,不进 staged
    // 桶),只有原始状态码(` A` vs `??`)能区分。manifest 不绑状态码时两态
    // 完全同一,旧结论可穿过新鲜度门。
    const { parent, innermost } = await setupNestedChain(1);
    parentPath = parent;
    const newFile = path.join(innermost, 'new.txt');
    await fs.writeFile(newFile, 'same-bytes\n');

    await runGit(['add', '-N', 'new.txt'], { cwd: innermost });
    const withIntentToAdd = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    await runGit(['reset', '--', 'new.txt'], { cwd: innermost });
    const afterReset = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    // 字节未动:内容指纹一致,差异必须由状态记录承担。
    expect(afterReset.identities[0].dirtyContentFingerprint).toBe(
      withIntentToAdd.identities[0].dirtyContentFingerprint,
    );
    expect(afterReset.identities).not.toEqual(withIntentToAdd.identities);
    expect(withIntentToAdd.identities[0].statusRecords).toContain(' A new.txt');
    expect(afterReset.identities[0].statusRecords).toContain('?? new.txt');
  });
});

describe('子仓 symlink 按链接文本绑定 (#2463 review)', () => {
  it.skipIf(!canLinkFile)(
    'binds a dirty submodule symlink pointing outside the sub without aborting',
    async () => {
      // 子仓里指向子仓外(../ 解析进父仓)或悬空的 symlink 是常见合法改动:
      // 按目标解析会让整个快照 fail closed 中止 review;链接文本才是 Git 记录
      // 的内容,文本变化必须改变身份。
      const { parent, innermost } = await setupNestedChain(1);
      parentPath = parent;
      const link = path.join(innermost, 'escape-link');
      await fs.symlink('../outside-a', link);

      const withTargetA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
      await fs.unlink(link);
      await fs.symlink('../outside-b', link);
      const withTargetB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

      expect(withTargetA.identities).toHaveLength(1);
      expect(withTargetB.identities).not.toEqual(withTargetA.identities);
    },
  );

  it.skipIf(!canLinkFile)(
    'binds a gitlink replaced by an outside-pointing symlink (typechange) without aborting',
    async () => {
      // gitlink 整个被 symlink 替换(typechange):sub 字段仍标 S 路由到子仓
      // 分支;链接悬空 / 指向仓库外同样是合法 Git 状态,须按链接文本绑定。
      const { parent } = await setupNestedChain(1);
      parentPath = parent;
      const subDir = path.join(parent, 'vendor', 'lib');
      await fs.rm(subDir, { recursive: true, force: true });
      await fs.symlink('../outside-a', subDir);

      const withTargetA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
      await fs.unlink(subDir);
      await fs.symlink('../outside-b', subDir);
      const withTargetB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

      expect(withTargetA.identities[0].subHead).toBe('typechange');
      expect(withTargetB.identities).not.toEqual(withTargetA.identities);
    },
  );

  it(
    'fails closed when a symlinked ancestor resolves the sub outside the parent repo',
    async () => {
      // 祖先目录 vendor 被换成指向父仓外的 symlink:lstat/realpath 跟随中间
      // 链接,仓外 checkout 的 toplevel 等于其自身,仅比对「toplevel === 自身」
      // 拦不住 —— 解析结果必须仍在父仓边界内,否则拒绝读取仓外 status 与字节。
      const { parent } = await setupNestedChain(1);
      parentPath = parent;
      const escapeRoot = path.join(workRoot, 'escape-root');
      const escapeCheckout = path.join(escapeRoot, 'lib');
      await initRepo(escapeCheckout);
      await fs.writeFile(path.join(escapeCheckout, 'evil.txt'), 'outside\n');
      await runGit(['add', 'evil.txt'], { cwd: escapeCheckout });
      await runGit(['commit', '--no-gpg-sign', '-m', 'outside seed'], { cwd: escapeCheckout });

      await fs.rm(path.join(parent, 'vendor'), { recursive: true, force: true });
      await fs.symlink(
        escapeRoot,
        path.join(parent, 'vendor'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await expect(
        readReviewSubmoduleIdentity(parentPath, ['vendor/lib']),
      ).rejects.toBeInstanceOf(ReviewSubmoduleIdentityError);
    },
  );
});

describe('顶层 readStatus 的 --ignore-submodules=none (#2463 维护者 review)', () => {
  it('keeps an ignore=all submodule with untracked-only content visible in top-level status', async () => {
    // 父仓配置 submodule.<name>.ignore=all 时,不带 --ignore-submodules=none
    // 的 git status 会整个省略脏子仓;submoduleEvidencePaths() 的 status 兜底
    // 依赖顶层 readStatus() 显式覆盖该配置——这里用真实仓库锁住这个行为
    // (untracked-only 内部内容同时也是无 numstat 条目的形态)。
    const { parent } = await setupNestedChain(1);
    parentPath = parent;
    await runGit(['config', 'submodule.vendor/lib.ignore', 'all'], { cwd: parent });
    await fs.writeFile(path.join(parent, 'vendor', 'lib', 'untracked.txt'), 'u\n');

    const scope: ReviewScope = {
      sessionId: 's-status',
      workdir: parent,
      worktreePath: parent,
      workingDir: parent,
      repoRoot: parent,
      branch: null,
      headOid: null,
      isDetached: false,
      isUnborn: false,
      source: 'worktree',
      aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
      disabledReason: null,
      disabledMessage: null,
      resolutionChain: [],
    };
    const status = await readStatus(scope);

    const entry = status.files.find((file) => file.path === 'vendor/lib');
    expect(entry).toBeTruthy();
    expect(entry?.isSubmodule).toBe(true);
    expect(entry?.worktreeStatus).toBe('modified');
  });
});
