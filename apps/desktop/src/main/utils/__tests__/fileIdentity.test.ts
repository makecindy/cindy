import { describe, expect, it } from 'vitest';

import { sameFileIdentity, samePathAndHandleFileIdentity } from '../fileIdentity.js';

describe('samePathAndHandleFileIdentity', () => {
  it('设备号和 inode 都可用时要求两者完整相等', () => {
    expect(
      samePathAndHandleFileIdentity({ dev: 10n, ino: 20n }, { dev: 10n, ino: 20n }, 'linux'),
    ).toBe(true);
    expect(
      samePathAndHandleFileIdentity({ dev: 10n, ino: 20n }, { dev: 11n, ino: 20n }, 'linux'),
    ).toBe(false);
    expect(
      samePathAndHandleFileIdentity({ dev: 10n, ino: 20n }, { dev: 10n, ino: 21n }, 'linux'),
    ).toBe(false);
  });

  it('仅 Windows 接受路径侧 dev=0、句柄侧 dev 非零且 FileId 相等', () => {
    expect(
      samePathAndHandleFileIdentity({ dev: 0n, ino: 20n }, { dev: 10n, ino: 20n }, 'win32'),
    ).toBe(true);
    expect(
      samePathAndHandleFileIdentity({ dev: 0n, ino: 20n }, { dev: 10n, ino: 20n }, 'linux'),
    ).toBe(false);
    expect(
      samePathAndHandleFileIdentity({ dev: 0n, ino: 20n }, { dev: 10n, ino: 21n }, 'win32'),
    ).toBe(false);
  });

  it('Windows dev 缺失分支只接受不会舍入 64-bit FileId 的 bigint stat', () => {
    expect(
      samePathAndHandleFileIdentity({ dev: 0, ino: 20 }, { dev: 10, ino: 20 }, 'win32'),
    ).toBe(false);
    expect(sameFileIdentity({ dev: 0, ino: 20 }, { dev: 0, ino: 20 }, 'win32')).toBe(false);
  });

  it('两边 dev 都缺失或任一 inode 缺失时拒绝', () => {
    expect(
      samePathAndHandleFileIdentity({ dev: 0n, ino: 20n }, { dev: 0n, ino: 20n }, 'win32'),
    ).toBe(false);
    expect(
      samePathAndHandleFileIdentity({ dev: 0n, ino: 0n }, { dev: 10n, ino: 0n }, 'win32'),
    ).toBe(false);
  });

  it('Windows 的两次路径 stat 可凭非零 FileId 匹配，但缺失 FileId 仍拒绝', () => {
    expect(sameFileIdentity({ dev: 0n, ino: 20n }, { dev: 0n, ino: 20n }, 'win32')).toBe(true);
    expect(sameFileIdentity({ dev: 0n, ino: 0n }, { dev: 0n, ino: 0n }, 'win32')).toBe(false);
  });
});
