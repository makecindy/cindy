import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { computeExcludedOldSideRemovals } from '../diff';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-learn-diff-test-'));

// Windows 未开发者模式/无特权时创建文件 symlink 会 EPERM(junction 只适用于目录);
// 探测一次,不可用则跳过依赖文件 symlink 的用例。
const canSymlink = (() => {
  const probe = path.join(os.tmpdir(), `xdt-symlink-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.symlinkSync(`${probe}-target`, probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('computeExcludedOldSideRemovals', () => {
  it('short-circuits excluded old directories instead of expanding every child', async () => {
    const oldDir = path.join(TEST_ROOT, 'old');
    await fs.promises.mkdir(path.join(oldDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.promises.writeFile(path.join(oldDir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    await fs.promises.writeFile(path.join(oldDir, '.env'), 'SECRET=1', 'utf8');

    const removals = await computeExcludedOldSideRemovals(oldDir);

    expect(removals.map((c) => c.path)).toEqual(['.env', 'node_modules']);
    expect(removals.find((c) => c.path === 'node_modules')).toMatchObject({
      kind: 'removed',
      isBinary: true,
      newSize: 0,
    });
  });
});

describe('非常规条目的旧侧删除可见性(规则 14 回归)', () => {
  it.skipIf(!canSymlink)('非排除路径下的 symlink 以 removed 摘要出现(listFiles 会静默丢掉它)', async () => {
    const oldDir = path.join(TEST_ROOT, 'old-symlink');
    await fs.promises.mkdir(path.join(oldDir, 'scripts'), { recursive: true });
    await fs.promises.writeFile(path.join(oldDir, 'SKILL.md'), 'x', 'utf8');
    await fs.promises.symlink('/etc/hosts', path.join(oldDir, 'scripts', 'helper-link'));

    const removals = await computeExcludedOldSideRemovals(oldDir);

    const link = removals.find((c) => c.path === 'scripts/helper-link');
    expect(link).toMatchObject({ kind: 'removed', isBinary: true, oldContent: '' });
    // 常规文件(SKILL.md)不属于本函数职责,不应出现
    expect(removals.some((c) => c.path === 'SKILL.md')).toBe(false);
  });
});
