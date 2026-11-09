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

import {
  copyCodexAuthSnapshot,
  codexAuthLinkAcceptanceFor,
  codexAuthPathsShareIdentity,
  inspectCodexAuthLink,
  relinkSharedCodexAuth,
  recoverCodexAuth,
  syncIndependentCodexAuth,
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
      // syncIndependentCodexAuth 负责,不在这条断言里)。
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

  it('Windows symlink 失败时复制独立副本,不建 hardlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const link = vi.spyOn(fs.promises, 'link');
    vi.spyOn(fs.promises, 'symlink').mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    await expect(recoverCodexAuth(systemAuth, myAuth, 'win32')).resolves.toBe(true);

    expect(link).not.toHaveBeenCalled();
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(false);
    expect(sameInode(systemAuth, myAuth)).toBe(false);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
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

describe('syncIndependentCodexAuth (#9277)', () => {
  it('拆开存量 hardlink,系统 auth.json 的 nlink 回到 1', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.linkSync(systemAuth, myAuth);
    expect(fs.statSync(systemAuth).nlink).toBe(2);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(sameInode(systemAuth, myAuth)).toBe(false);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('独立副本按较新 mtime 从本地同步回系统文件(已证明同账号)', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    expect(out.kind).toBe('copied-from-local');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(MY_CONTENT);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(sameInode(systemAuth, myAuth)).toBe(false);
    // 保留源 mtime,下一次按 mtime 的对账不会反向再拷。
    expect(fs.statSync(systemAuth).mtimeMs).toBeCloseTo(fs.statSync(myAuth).mtimeMs, 0);
  });

  it('账号未证明一致时,较新的本地副本绝不写回系统登录', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('内容一致时不反复复制(防止 mtime 来回覆盖)', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, SYSTEM_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);
    const systemMtimeBefore = fs.statSync(systemAuth).mtimeMs;

    const first = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');
    const second = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(first.kind).toBe('unchanged');
    expect(second.kind).toBe('unchanged');
    expect(fs.statSync(systemAuth).mtimeMs).toBe(systemMtimeBefore);
  });

  it('等 mtime 但内容不同:按授权方向挑确定权威端,不是「未变化」', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const same = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(systemAuth, same, same);
    fs.utimesSync(myAuth, same, same);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    // 账号未证明一致 → 系统凭证获胜,本地被刷成系统内容。
    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('等 mtime 且内容不同、允许回写时本地获胜(已证明同账号)', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const same = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(systemAuth, same, same);
    fs.utimesSync(myAuth, same, same);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    expect(out.kind).toBe('copied-from-local');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(MY_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
  });

  // 测试价值(#9316 review): 同机另一个升级前的 profile 也建过硬链时,只拆当前
  // 这一份,系统 auth.json 的 nlink 仍 > 1 —— Codex 0.165+ 照样拒绝写它。
  it('把系统凭证上残留的硬链一并清掉(同机另一个 profile 的旧链接)', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(systemAuth, myAuth);
    fs.linkSync(systemAuth, otherProfile);
    expect(fs.statSync(systemAuth).nlink).toBe(3);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    // 当前这一份已拆开,系统路径的 nlink 也回到 1。
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  // 测试价值(#9316 review): Cindy 与本机 Codex 是两个 writer。方向判定用的是
  // 过期快照时,本机 Codex 刚刷新的系统凭证会被旧本地副本覆盖(refresh token
  // 轮换后两端都登不上)。发布前必须复核目标代次。
  it('发布前复核目标代次:本机 Codex 刚刷新过的系统凭证不被旧本地副本覆盖', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    let refreshed = false;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, options) => {
      // 复制途中本机 Codex 把系统凭证刷新到新一代。
      if (!refreshed) {
        refreshed = true;
        fs.writeFileSync(systemAuth, REFRESHED_CONTENT);
        const refreshedMtime = new Date(Date.now() + 120_000);
        fs.utimesSync(systemAuth, refreshedMtime, refreshedMtime);
      }
      return originalCopyFile(from as never, to as never, options as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    // 复核发现目标换代 → 重新对账 → 系统凭证获胜,旧本地副本不再覆盖它。
    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(REFRESHED_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): 复制途中本机 Codex 把系统凭证刷到新一代时,撕裂代次
  // 的字节绝不能发布;更不能把旧字节贴上新一代的 mtime —— 下一次对账的等 mtime
  // 判定会让旧本地副本反向覆盖新的 refresh token,两端一起登不上。
  it('复制途中源换代时不发布旧字节,旧副本也不会反向覆盖新的系统凭证', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(myAuth, older, older);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const refreshedMtime = new Date(Date.now() + 120_000);
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    let refreshed = false;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, options) => {
      await originalCopyFile(from as never, to as never, options as never);
      // 复制完成后本机 Codex 原子刷新了系统凭证(新一代)。
      if (!refreshed && String(from) === systemAuth) {
        refreshed = true;
        fs.writeFileSync(systemAuth, REFRESHED_CONTENT);
        fs.utimesSync(systemAuth, refreshedMtime, refreshedMtime);
      }
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    expect(out.kind).toBe('copied-from-system');
    // 本地副本拿到的是新一代内容,不是复制途中作废的旧字节。
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
    // 发布的字节与它自己那一代的 mtime 绑定。
    expect(fs.statSync(myAuth).mtimeMs).toBeCloseTo(fs.statSync(systemAuth).mtimeMs, 0);

    // 再对账一次:等 mtime 的旧副本也不能反向覆盖系统凭证。
    const second = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });
    expect(second.kind).toBe('unchanged');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): 拆残余硬链时读到的内容可能已经过期(本机 Codex 刚
  // 刷新了系统凭证)。发布前必须复核代次,否则旧字节会盖回系统路径,把新的
  // refresh token 弄丢。
  it('拆残余硬链时源换代就不发布旧字节', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(systemAuth, myAuth);
    fs.linkSync(systemAuth, otherProfile);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const refreshedMtime = new Date(Date.now() + 120_000);
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    let refreshed = false;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      const result = await originalWriteFile(file as never, data as never, options as never);
      // 读到内容之后、写完副本时,本机 Codex 原子刷新了系统凭证。
      if (!refreshed && String(file).includes('.copytmp')) {
        refreshed = true;
        fs.writeFileSync(systemAuth, REFRESHED_CONTENT);
        fs.utimesSync(systemAuth, refreshedMtime, refreshedMtime);
      }
      return result;
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    // 系统凭证保留本机 Codex 刚刷新的内容,没被旧字节盖回。
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(REFRESHED_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): 换 inode 失败时的兜底会把内存里的旧内容写回系统
  // 路径 —— 若此时本机 Codex 已经原子重建了系统凭证,这一写会把新 token 截断。
  // 只有目标真的没了才允许写回。
  it('换 inode 失败时的兜底不截断本机 Codex 刚重建的系统凭证', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(systemAuth, myAuth);
    fs.linkSync(systemAuth, otherProfile);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const refreshedMtime = new Date(Date.now() + 120_000);
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === systemAuth && String(from).includes('.copytmp')) {
        // 本机 Codex 先原子重建了系统凭证,随后我们的 rename 失败。
        fs.writeFileSync(systemAuth, REFRESHED_CONTENT);
        fs.utimesSync(systemAuth, refreshedMtime, refreshedMtime);
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from as never, to as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'linux');

    expect(out.kind).toBe('copied-from-system');
    // 系统凭证保留本机 Codex 刚重建的内容,没被旧字节截断。
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): 内容一致 ≠ 系统路径干净。同机另一个升级前的 profile
  // 仍硬链着系统 auth.json 时,系统路径 nlink > 1,Codex 0.165+ 照样拒绝写它 ——
  // 「未变化」这条早退不能跳过清理。
  it('内容一致时也清掉系统凭证上残留的硬链', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(systemAuth, otherProfile);
    expect(fs.statSync(systemAuth).nlink).toBe(2);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('unchanged');
    expect(fs.statSync(systemAuth).nlink).toBe(1);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  // 测试价值(#9316 review): 内容一致 ≠ 本地路径干净。同机另一个升级前的 profile
  // 仍硬链着这份本地副本时,本地 auth.json 的 nlink 仍 > 1,Codex 0.165+ 照样
  // 拒绝写它 —— 只拆系统那一份不够,本地这份的硬链也要一并拆掉。
  // 测试价值(#9316 review): 身份核对期间本机 Codex 原子替换了系统凭证时,两次
  // stat 会横跨替换窗口(链接侧读到旧 inode,系统侧读到新 inode)。共享链接本身
  // 是健康的 —— 链接指向系统凭证路径这件事与文件是否被替换无关,不能因此判成
  // 「不是同一份」,否则登录会写下断线标记并报 local_auth_unavailable。
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

  it('内容一致时也拆掉本地副本上残留的硬链', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(myAuth, otherProfile);
    expect(fs.statSync(myAuth).nlink).toBe(2);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('unchanged');
    // 本地这份换到了新 inode:nlink 回到 1,Codex 能原子写入。
    expect(fs.statSync(myAuth).nlink).toBe(1);
    // 别的 profile 的旧链接留在旧 inode 上,内容不受影响。
    expect(fs.statSync(otherProfile).nlink).toBe(1);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    // 两侧都干净 → 没有残余要报。
    expect(out.residualSystemHardlinks).toBeUndefined();
    expect(out.residualLocalHardlinks).toBeUndefined();
  });

  // 测试价值(#9316 review): 拆残余硬链失败(ACL/EBUSY)时,返回值里区分不出
  // 「本来就没有」和「拆失败」。必须再数一次 nlink 把残余报出来 —— 否则调用方
  // 会把「凭证在,但 Codex 写不进去」当成同步成功,记下「共享已就绪」。
  it('拆残余硬链失败时把残余报出来,不当成已经干净', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, SYSTEM_CONTENT);
    const otherProfile = path.join(tmpRoot, 'other-profile', 'auth.json');
    fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
    fs.linkSync(systemAuth, otherProfile);
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === systemAuth && String(from).includes('.copytmp')) {
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from as never, to as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'linux');

    // 硬链还在 → 必须报出来,不能当成「已就绪」。
    expect(out.residualSystemHardlinks).toBe(2);
    expect(fs.statSync(systemAuth).nlink).toBe(2);
    // 拆失败不能把凭证弄丢。
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  // 测试价值(#9316 review): 代次比较必须精确到 ns。只比 ms 时,本机 Codex 在同
  // 一毫秒内原地改写系统凭证(同一个 inode、同样的字节数)会被漏判成「没换代」,
  // 撕裂代次的旧字节就被发布到本地 —— 本地凭证短暂停在上一代。
  it('复制期间源在同一毫秒内原地改写时,不发布旧字节', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    // 固定代次:mtime 的毫秒部分与下面那次改写相同,只有 ns 部分不同。
    fs.utimesSync(systemAuth, 1700000000, 1700000000);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'refreshed-tk' } });
    expect(REFRESHED_CONTENT.length).toBe(SYSTEM_CONTENT.length);
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    let refreshed = false;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, options) => {
      await originalCopyFile(from as never, to as never, options as never);
      // 复制完成后本机 Codex 在同一毫秒内原地改写了系统凭证(同一个 inode)。
      if (!refreshed && String(from) === systemAuth) {
        refreshed = true;
        fs.writeFileSync(systemAuth, REFRESHED_CONTENT);
        fs.utimesSync(systemAuth, 1700000000.0005, 1700000000.0005);
      }
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    // 本地副本拿到的是新一代内容,不是复制途中作废的旧字节。
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): relink 可能以 recovered 收口(替换失败后从系统凭证
  // 重建了共享链接)。此时本地凭证其实已经共享系统凭证 —— 登录路径要按最终身份
  // 认账,不能只因 relink 的分类不是 linked 就判成失败。
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
    expect(codexAuthLinkAcceptanceFor(relink.kind, false, 'win32')).toBe('fallback-copy');
    // 独立副本路径在这里会跳过(已是 symlink) —— 旧登录路径据此判成失败。
    await expect(syncIndependentCodexAuth(systemAuth, myAuth, 'darwin')).resolves.toEqual({
      kind: 'skipped',
    });
  });

  // 测试价值(#9316 review): 时间戳必须随 rename 一起原子生效。若发布后再按路径
  // utimes,本机 Codex 在 rename 之后刷新的新凭证会被盖上旧代次的时间戳,
  // 下一次对账的等 mtime 判定就会让旧本地副本反向覆盖它。
  it('发布后本机 Codex 立刻刷新时,新凭证不会被盖上旧代次的时间戳', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(myAuth, older, older);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const refreshedMtime = new Date(Date.now() + 300_000);
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      const result = await originalRename(from as never, to as never);
      // rename 之后本机 Codex 原子刷新了刚发布的凭证。
      if (String(to) === myAuth && String(from).includes('.copytmp')) {
        fs.writeFileSync(myAuth, REFRESHED_CONTENT);
        fs.utimesSync(myAuth, refreshedMtime, refreshedMtime);
      }
      return result;
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
    expect(fs.statSync(myAuth).mtimeMs).toBeCloseTo(refreshedMtime.getTime(), 0);
  });

  // 测试价值(#9316 review): 丢文件后的重建只在目标仍然缺失时进行。目标若已被
  // 本机 Codex 重新建出来,那是新的一代,不能拿旧字节覆盖它。
  it('重建时目标已被本机 Codex 重新建出来,就不拿旧字节覆盖它', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(myAuth, older, older);
    const REFRESHED_CONTENT = JSON.stringify({ tokens: { access_token: 'zhbgr-lpvos-kmkzj' } });
    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // 第一次发布:Windows 先删目标再 rename,rename 失败 → 目标丢失。
      if (String(to) === myAuth && renameCalls === 0) {
        renameCalls += 1;
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from as never, to as never);
    });
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    let copyCalls = 0;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, options) => {
      const result = await originalCopyFile(from as never, to as never, options as never);
      copyCalls += 1;
      // 重建副本拷贝期间,本机 Codex 把刚被删掉的凭证重新写了出来。
      if (copyCalls === 2) {
        fs.writeFileSync(myAuth, REFRESHED_CONTENT);
      }
      return result;
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    expect(out.kind).toBe('copied-from-local');
    // 重新出现的凭证是新一代,不能被旧字节覆盖。
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(REFRESHED_CONTENT);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(REFRESHED_CONTENT);
  });

  // 测试价值(#9316 review): 账号结论不能只在开头读一次。先前读到的「两侧同账号」
  // 可能已经过期(本机 Codex 换号),过期的结论会授权旧账号覆盖新登录。
  it('写回系统凭证前重新核对账号:账号已变就不写回', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
      confirmLocalToSystem: async () => false,
    });

    // 账号已换 → 不写回系统凭证,系统单向获胜。
    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('写回系统文件时 rename 失败会从仍存在的本地源恢复,不留空窗', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // 第一次写回系统:rm 成功后 rename 失败(copyCodexAuthSnapshot 的 lost)。
      if (String(to) === systemAuth && renameCalls === 0) {
        renameCalls += 1;
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return originalRename(from as never, to as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32', undefined, {
      allowLocalToSystem: true,
    });

    expect(out.kind).toBe('copied-from-local');
    expect(renameCalls).toBeGreaterThanOrEqual(1);
    // 系统登录文件不能被删掉后不还回来。
    expect(fs.existsSync(systemAuth)).toBe(true);
    expect(fs.readFileSync(systemAuth, 'utf8')).toBe(MY_CONTENT);
    expect(fs.statSync(systemAuth).nlink).toBe(1);
  });

  it.skipIf(!canLinkFile)('已是 symlink 时不拍成副本', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.symlinkSync(systemAuth, myAuth);

    await expect(syncIndependentCodexAuth(systemAuth, myAuth, 'win32')).resolves.toEqual({
      kind: 'skipped',
    });
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
  });

  // #9316 review:同机另一个 Cindy profile(或本机 Codex)原子替换凭证时会经历
  // rm → rename 的空窗,路径在那一瞬读不到。这不是终态失败:抛出去会让 getState()
  // 整个拒绝,登录路径还会写下断线标记 —— 文件其实可能已经回来了。
  it('系统凭证在对账途中瞬时消失:重新对账,不抛异常', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let systemStatCalls = 0;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, opts) => {
      // 第一次是对账前的存在性检查,第二次才是对账循环里读代次的那次。
      if (String(target) === systemAuth && opts === undefined) {
        systemStatCalls += 1;
        if (systemStatCalls === 2) {
          const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(target as never, opts as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
  });

  it('本地凭证在对账途中瞬时消失:重新对账,不抛异常', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(myAuth, newer, newer);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let localStatCalls = 0;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, opts) => {
      // 非 bigint 的第一次 stat(myAuth) 就是对账循环里读本地代次的那次。
      if (String(target) === myAuth && opts === undefined) {
        localStatCalls += 1;
        if (localStatCalls === 1) {
          const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(target as never, opts as never);
    });

    const out = await syncIndependentCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('copied-from-system');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
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

  it.skipIf(!canLinkFile)('自愈两步都失败 → 按原路径 swap-failed-intact,myAuth 原样保留', async () => {
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
  });

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
