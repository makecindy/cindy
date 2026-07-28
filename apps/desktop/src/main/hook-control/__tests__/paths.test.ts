/**
 * hook-control/paths 单测。
 *
 * `isPathWithin` 是工作目录映射这条安全边界的算术 —— 它决定"远端能不能驱动这个
 * 目录"。归一化细节(`sub/..`、兄弟目录前缀、Windows 大小写)错一点就是放行或
 * 误拒, 所以单独覆盖(PR #733 review 指出抽模块后丢了覆盖)。
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPathWithin } from '../paths';

const BASE = path.resolve('/repos/demo');

describe('isPathWithin', () => {
  it('相等 / 子目录算在内, 外部路径不算', () => {
    expect(isPathWithin(BASE, BASE)).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, 'sub'))).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, 'a', 'b', 'c'))).toBe(true);
    expect(isPathWithin(BASE, path.resolve('/repos/other'))).toBe(false);
  });

  it('前缀相同但不是子目录的兄弟目录不算(字符串前缀比较会误判)', () => {
    expect(isPathWithin(BASE, path.resolve('/repos/demo-2'))).toBe(false);
    expect(isPathWithin(BASE, `${BASE}-backup`)).toBe(false);
  });

  it('先归一化再判定: `..` 不能借道逃出去', () => {
    expect(isPathWithin(BASE, path.join(BASE, 'sub', '..'))).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, '..'))).toBe(false);
    expect(isPathWithin(BASE, path.join(BASE, 'sub', '..', '..', 'elsewhere'))).toBe(false);
  });

  it('空 / 全空白路径 fail closed(空串会 resolve 成 cwd, 那是假放行)', () => {
    expect(isPathWithin(BASE, '')).toBe(false);
    expect(isPathWithin(BASE, '   ')).toBe(false);
    expect(isPathWithin('', BASE)).toBe(false);
    expect(isPathWithin('', '')).toBe(false);
    // 具体证据: 拿进程 cwd 当映射根时, 空目标不能被判成"在里面"
    expect(isPathWithin(process.cwd(), '')).toBe(false);
  });

  it('Windows 路径在任意 CI 主机上都按大小写不敏感和 win32 分隔符判定', () => {
    const windowsBase = 'C:\\Repos\\Demo';
    expect(isPathWithin(windowsBase, 'c:\\repos\\demo', 'win32')).toBe(true);
    expect(isPathWithin(windowsBase, 'c:\\REPOS\\DEMO\\sub', 'win32')).toBe(true);
    expect(isPathWithin(windowsBase, 'C:\\Repos\\Demo-2', 'win32')).toBe(false);
    expect(isPathWithin(windowsBase, 'C:\\Repos\\Demo\\sub\\..\\..\\outside', 'win32')).toBe(false);
  });

  it('POSIX 路径在任意 CI 主机上都保持大小写敏感', () => {
    const posixBase = '/repos/demo';
    expect(isPathWithin(posixBase, '/repos/demo/sub', 'linux')).toBe(true);
    expect(isPathWithin(posixBase, '/REPOS/DEMO/sub', 'linux')).toBe(false);
    expect(isPathWithin('/REPOS/DEMO', posixBase, 'darwin')).toBe(false);
  });
});
