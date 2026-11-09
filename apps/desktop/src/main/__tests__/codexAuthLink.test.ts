/**
 * codex-auth-link 单测 — 真实 fs tmpdir fixture。
 *
 * 这套测试守护 reconcile 替换 codex auth.json 共享链接时的原子性、自愈与并发安全。
 * 名 + 无串行化导致并发撞 `EEXIST` / `ENOENT`,且 rename 失败会让用户的 auth.json 凭空消失。
 * 覆盖:
 *   - 基本 link(myAuth 已存在 / 不存在)→ 'linked' 且与 systemAuth 同 inode、内容一致
 *   - systemAuth 不存在 → 'link-unsupported' 且 myAuth 不受影响
 *   - 并发回归(核心):大量并发 relink 全部 settle、无 'lost'、结束后 myAuth 完好且共享 inode
 *   - recoverCodexAuth 兜底:systemAuth 在→重建成功;不在→失败
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit boundary for the Windows syscall. The real PowerShell/File.Move path is
// exercised separately by check-windows-codex-auth-move.mjs in Windows CI.
vi.mock('../maker-host/codex-auth-file-move', () => ({
  moveCodexAuthFile: async (from: string, to: string) => {
    if (fs.existsSync(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    fs.renameSync(from, to);
  },
}));

import {
  copyCodexAuthSnapshot,
  codexAuthLinkAcceptanceFor,
  codexAuthPathsShareIdentity,
  inspectCodexAuthLink,
  relinkSharedCodexAuth,
  recoverCodexAuth,
} from '../maker-host/codex-auth-link';

let tmpRoot: string;
let systemAuth: string;
let myAuth: string;

const SYSTEM_CONTENT = JSON.stringify({ tokens: { access_token: 'system-token' } });
const MY_CONTENT = JSON.stringify({ tokens: { access_token: 'stale-local-token' } });

/** 探测宿主真实能力，不假设每台 Windows 机器都能创建文件 symlink。 */
function canCreateFileSymlink(): boolean {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-auth-link-probe-'));
  try {
    const target = path.join(probeRoot, 'target');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(probeRoot, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const canLinkFile = canCreateFileSymlink();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-link-test-'));
  // 模拟 ~/.codex/auth.json 与 codex-home/auth.json 两个独立路径。
  systemAuth = path.join(tmpRoot, 'system', 'auth.json');
  myAuth = path.join(tmpRoot, 'codex-home', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.mkdirSync(path.dirname(myAuth), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 两个路径最终是否解析到同一个 inode。 */
function sameInode(a: string, b: string): boolean {
  // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER; compare without rounding.
  const sa = fs.statSync(a, { bigint: true });
  const sb = fs.statSync(b, { bigint: true });
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** 列出 myAuth 同目录下残留的 .linktmp sidecar 文件。 */
function leftoverSidecars(): string[] {
  return fs.readdirSync(path.dirname(myAuth)).filter((name) => name.includes('.linktmp'));
}

describe('relinkSharedCodexAuth', () => {
  // #9316 / unit: a junction aliases a directory entry, unlike a second hardlink.
  // Exercise each mutating primitive: none may delete/replace the native auth inode.
  describe.each(['win32', 'darwin'] as const)('directory alias (%s)', (platform) => {
    it.each(['relink', 'snapshot', 'recover'] as const)(
      '%s preserves the native entry',
      async (operation) => {
        fs.rmdirSync(path.dirname(myAuth));
        fs.symlinkSync(path.dirname(systemAuth), path.dirname(myAuth), 'junction');
        fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
        // An unrelated old profile may still hold a hardlink. Same-entry protection
        // must not depend on nlink === 1 or mistake this path for a removable alias.
        fs.linkSync(systemAuth, `${systemAuth}.other-profile`);
        const before = fs.statSync(systemAuth, { bigint: true });
        if (operation === 'relink') {
          await expect(relinkSharedCodexAuth(systemAuth, myAuth, platform)).resolves.toMatchObject({
            kind: 'same-entry',
          });
        } else if (operation === 'snapshot') {
          await expect(copyCodexAuthSnapshot(systemAuth, myAuth, platform)).resolves.toMatchObject({
            kind: 'copy-unsupported',
          });
        } else {
          await expect(recoverCodexAuth(systemAuth, myAuth, platform)).resolves.toBe(true);
        }
        expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
        expect(fs.lstatSync(systemAuth).isSymbolicLink()).toBe(false);
        expect(fs.statSync(systemAuth, { bigint: true })).toMatchObject({
          ino: before.ino,
          nlink: before.nlink,
        });
        expect(fs.readdirSync(path.dirname(systemAuth)).sort()).toEqual([
          'auth.json',
          'auth.json.other-profile',
        ]);
      },
    );
  });

  it.skipIf(!canLinkFile)('POSIX:myAuth 已存在→原子替换为 symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out.kind).toBe('linked');
    expect(out.linkType).toBe('symlink');
    expect(out.error).toBeUndefined();
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it.skipIf(!canLinkFile)('POSIX:myAuth 不存在 → linked,直接建出 symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out.kind).toBe('linked');
    expect(out.linkType).toBe('symlink');
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
  });

  it.skipIf(!canLinkFile)('POSIX:系统 auth 原子替换后 symlink 自动跟随新 inode', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');
    const oldInode = fs.statSync(myAuth, { bigint: true }).ino;
    const replacement = `${systemAuth}.new`;
    fs.writeFileSync(replacement, JSON.stringify({ tokens: { access_token: 'rotated' } }));

    fs.renameSync(replacement, systemAuth);

    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(fs.statSync(myAuth, { bigint: true }).ino).not.toBe(oldInode);
    expect(fs.readFileSync(myAuth, 'utf-8')).toContain('rotated');
  });

  // #9277: Codex 0.165+ 拒绝 nlink>1。Windows 也建文件 symlink,系统文件链接数保持 1。
  it.skipIf(!canLinkFile)('Windows 使用文件 symlink,不建立 hardlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32');

    expect(out).toMatchObject({ kind: 'linked', linkType: 'symlink' });
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
  });

  it.skipIf(!canLinkFile)('Windows 存量 hardlink 被替换成 symlink,系统 nlink 回到 1', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.linkSync(systemAuth, myAuth);
    expect(fs.statSync(systemAuth).nlink).toBe(2);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32');

    expect(out).toMatchObject({ kind: 'linked', linkType: 'symlink' });
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('Windows symlink 被拒绝时不退回 hardlink,原凭证保留', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const link = vi.spyOn(fs.promises, 'link');
    vi.spyOn(fs.promises, 'symlink').mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('link-unsupported');
    expect(link).not.toHaveBeenCalled();
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(leftoverSidecars()).toEqual([]);
  });

  it.skipIf(!canLinkFile)('POSIX 会原子替换 dangling symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.symlinkSync(path.join(tmpRoot, 'missing-auth.json'), myAuth);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out).toMatchObject({ kind: 'linked', linkType: 'symlink' });
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('systemAuth 不存在 → link-unsupported,myAuth 一字未动', async () => {
    fs.writeFileSync(myAuth, MY_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth);

    expect(out.kind).toBe('link-unsupported');
    expect(out.error).toBeInstanceOf(Error);
    // myAuth 原样保留,绝不能被删。
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(MY_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('并发回归:20 个并发 relink 全部 settle、无 lost,结束后 myAuth 完好且共享 inode', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    // 旧实现(固定 sidecar + rm→rename)在这里会撞 EEXIST/ENOENT,甚至把 myAuth 弄丢。
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => relinkSharedCodexAuth(systemAuth, myAuth)),
    );

    // 没有任何一次把 auth.json 弄丢。
    expect(outcomes.some((o) => o.kind === 'lost')).toBe(false);
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
    if (canLinkFile) {
      // 至少有人成功建立了共享链接。
      expect(outcomes.some((o) => o.kind === 'linked')).toBe(true);
      // 终态:myAuth 存在、内容是 systemAuth、与 systemAuth 同 inode。
      expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
      expect(sameInode(systemAuth, myAuth)).toBe(true);
    } else {
      // 建不出 symlink:relink 走 link-unsupported,原凭证一字未动(降级路径由
      // 独立登录负责,不在这条断言里)。
      expect(outcomes.every((o) => o.kind === 'link-unsupported')).toBe(true);
      expect(fs.readFileSync(myAuth, 'utf-8')).toBe(MY_CONTENT);
    }
  });

  it('幂等:对已是 symlink 的 myAuth 再 relink 仍 linked、仍共享', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const first = await relinkSharedCodexAuth(systemAuth, myAuth);
    const second = await relinkSharedCodexAuth(systemAuth, myAuth);

    if (!canLinkFile) {
      // 建不出 symlink:两次都是 link-unsupported,凭证保持原样。
      expect(first.kind).toBe('link-unsupported');
      expect(second.kind).toBe('link-unsupported');
      expect(fs.existsSync(myAuth)).toBe(false);
      expect(leftoverSidecars()).toEqual([]);
      return;
    }
    expect(first.kind).toBe('linked');
    expect(second.kind).toBe('linked');
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
  });
});

describe('copyCodexAuthSnapshot', () => {
  it('publishes an independent snapshot so child writes cannot mutate the source', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const out = await copyCodexAuthSnapshot(systemAuth, myAuth, process.platform);

    expect(out.kind).toBe('copied');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(sameInode(systemAuth, myAuth)).toBe(false);

    fs.writeFileSync(myAuth, JSON.stringify({ tokens: { access_token: 'child-refresh' } }));
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('leaves the existing local credential intact when the source cannot be copied', async () => {
    fs.writeFileSync(myAuth, MY_CONTENT);

    const out = await copyCodexAuthSnapshot(path.join(tmpRoot, 'missing-auth.json'), myAuth);

    expect(out.kind).toBe('copy-unsupported');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
  });
});

describe('recoverCodexAuth', () => {
  it('systemAuth 存在 → 重建 myAuth 并返回 true', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    expect(fs.existsSync(myAuth)).toBe(false);

    const ok = await recoverCodexAuth(systemAuth, myAuth);

    expect(ok).toBe(true);
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
  });

  it('systemAuth 不存在 → 返回 false,不创建 myAuth', async () => {
    const ok = await recoverCodexAuth(systemAuth, myAuth);

    expect(ok).toBe(false);
    expect(fs.existsSync(myAuth)).toBe(false);
  });

  it('Windows symlink 失败时不复制凭证,由调用方独立登录', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const link = vi.spyOn(fs.promises, 'link');
    vi.spyOn(fs.promises, 'symlink').mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    await expect(recoverCodexAuth(systemAuth, myAuth, 'win32')).resolves.toBe(false);

    expect(link).not.toHaveBeenCalled();
    expect(fs.existsSync(myAuth)).toBe(false);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  // 测试价值(#9316 review): 重建的前提是目标此刻仍然不存在。本机 Codex 在这段
  // 空窗里把目标重建出来(新一代凭证)时,拿旧字节覆盖它就等于丢掉刚刷新的
  // refresh token —— 目标在,就不是「丢了」,不重建也不覆盖。
  it('目标已被本机 Codex 重建出来时,不拿旧字节覆盖它', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    const ok = await recoverCodexAuth(systemAuth, myAuth, 'win32');

    expect(ok).toBe(false);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
  });
});

describe('shared credential identity', () => {
  it.skipIf(!canLinkFile)('身份核对期间系统凭证被原子替换时,共享链接仍认账', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const originalStat = fs.promises.stat.bind(fs.promises);
    const oldStat = await originalStat(systemAuth, { bigint: true });
    // 本机 Codex 原子替换系统凭证 → 新 inode。
    const replacement = `${systemAuth}.new`;
    fs.writeFileSync(replacement, SYSTEM_CONTENT);
    fs.renameSync(replacement, systemAuth);
    fs.symlinkSync(systemAuth, myAuth);
    let firstSystemStat = true;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, opts) => {
      // 第一次读到替换前的旧代次,之后读到新代次。
      if (String(target) === systemAuth && firstSystemStat) {
        firstSystemStat = false;
        return oldStat as never;
      }
      return originalStat(target as never, opts as never);
    });

    const sharesIdentity = await codexAuthPathsShareIdentity(myAuth, systemAuth);

    expect(sharesIdentity).toBe(true);
    expect(codexAuthLinkAcceptanceFor('linked', sharesIdentity, 'linux')).toBe('accept-shared');
  });

  it.skipIf(!canLinkFile)('relink 以 recovered 收口时,本地凭证已经共享了系统凭证', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === myAuth && String(from).includes('.linktmp')) {
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from as never, to as never);
    });

    const relink = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(relink.kind).toBe('recovered');
    // 重建出来的是指向系统凭证的链接:身份上已经共享。
    const sharesIdentity = await codexAuthPathsShareIdentity(myAuth, systemAuth);
    expect(sharesIdentity).toBe(true);
    // 登录路径按最终身份认账 —— 不因为 relink 的分类不是 linked 就判失败。
    expect(codexAuthLinkAcceptanceFor(relink.kind, sharesIdentity, 'linux')).toBe('accept-shared');
    // 身份不成立时,recovered 只能退回独立副本路径(POSIX 直接判失败)。
    expect(codexAuthLinkAcceptanceFor(relink.kind, false, 'linux')).toBe('reject');
    expect(codexAuthLinkAcceptanceFor(relink.kind, false, 'win32')).toBe('independent-login');
  });
});

describe('inspectCodexAuthLink', () => {
  it('本地缺失时仍返回系统权威文件元数据', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toMatchObject({
      linkType: 'missing',
      healthy: false,
      systemAuthMtimeMs: expect.any(Number),
      systemAuthLinkCount: 1,
    });
  });

  it.skipIf(!canLinkFile)('返回 symlink 健康度与权威文件元数据', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    const diagnostics = await inspectCodexAuthLink(systemAuth, myAuth);

    expect(diagnostics).toMatchObject({ linkType: 'symlink', healthy: true });
    expect(diagnostics.systemAuthMtimeMs).toEqual(expect.any(Number));
    expect(diagnostics.systemAuthLinkCount).toBe(1);
  });

  it.skipIf(!canLinkFile)('识别 dangling symlink', async () => {
    fs.symlinkSync(systemAuth, myAuth);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toEqual({
      linkType: 'dangling-symlink',
      healthy: false,
    });
  });

  it('识别无 provenance 普通文件为不健康', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toMatchObject({
      linkType: 'file',
      healthy: false,
    });
  });

  it('系统权威文件缺失时仍识别本地普通文件', async () => {
    fs.writeFileSync(myAuth, MY_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toEqual({
      linkType: 'file',
      healthy: false,
    });
  });
});

describe('Windows 死 SID ACL 自愈 (#3469)', () => {
  // 迁移来的 auth.json 只带旧账户单条 ACE 时,当前账户 unlink 必 EPERM;
  // 此前 reconcile 只能永久 swap-failed-intact,登录卡在最后一步。
  function epermRmOnce(target: string): { calls: () => number } {
    const originalRm = fs.promises.rm.bind(fs.promises);
    let denied = false;
    let targetCalls = 0;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
      if (String(p) === target) {
        targetCalls += 1;
        if (!denied) {
          denied = true;
          const err = new Error('EPERM: operation not permitted, unlink') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
      }
      return originalRm(p as never, opts as never);
    });
    return { calls: () => targetCalls };
  }

  it.skipIf(!canLinkFile)('unlink EPERM → icacls 自愈成功 → 重试完成替换 (linked)', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const { calls } = epermRmOnce(myAuth);
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32', execFileImpl as never);

    expect(out.kind).toBe('linked');
    expect(execFileImpl).toHaveBeenCalledWith('icacls', [myAuth, '/reset']);
    expect(calls()).toBe(2); // 首次 EPERM + 自愈后重试
    expect(sameInode(systemAuth, myAuth)).toBe(true);
  });

  it.skipIf(!canLinkFile)(
    '自愈两步都失败 → 按原路径 swap-failed-intact,myAuth 原样保留',
    async () => {
      fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
      fs.writeFileSync(myAuth, MY_CONTENT);
      epermRmOnce(myAuth);
      const execFileImpl = vi.fn().mockRejectedValue(new Error('icacls denied'));

      const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32', execFileImpl as never);

      expect(out.kind).toBe('swap-failed-intact');
      expect((out.error as NodeJS.ErrnoException).code).toBe('EPERM');
      // reset 与 grant 两步都试过。
      expect(execFileImpl).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
    },
  );

  it.skipIf(!canLinkFile)('非 ACL 类失败(EBUSY)不触发自愈,行为与修复前一致', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const originalRm = fs.promises.rm.bind(fs.promises);
    let denied = false;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
      if (String(p) === myAuth && !denied) {
        denied = true;
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRm(p as never, opts as never);
    });
    const execFileImpl = vi.fn();

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32', execFileImpl as never);

    expect(out.kind).toBe('swap-failed-intact');
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
