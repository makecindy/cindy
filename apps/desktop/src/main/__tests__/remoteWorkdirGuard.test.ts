/**
 * remoteWorkdirGuard.test.ts —— 远程新建会话 workingDir 收敛(安全闸门)。
 *
 * dispatch 把控制端 args 原样喂本机 handler;create-session 的 workingDir 决定 agent 在哪起
 * 进程(可读写/执行)。allowlist 只挡 channel 不挡 args,故必须对 workingDir 收敛。
 * 所有本地路径都必须通过当前文件系统探测,历史 recent/session 记录不能替代可访问性。
 * SSH workdir 的端点识别由 file-browser 独立处理,不能放宽 create-session、worktree:create
 * 或远程 /cmd 共用的本地目录安全闸。这里锁住:目录放行、文件/不存在路径拒、空路径拒、
 * 断线探测不阻塞事件循环且在业务超时内收敛。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  let statImpl: (p: string) => Promise<{ isDirectory(): boolean }> = async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const statSpy = vi.fn((p: string) => statImpl(p));
  return {
    setStat: (fn: (p: string) => Promise<{ isDirectory(): boolean }>) => {
      statImpl = fn;
    },
    statSpy,
  };
});

vi.mock('node:fs/promises', () => ({ stat: (p: string) => h.statSpy(p) }));
vi.mock('../../shared/workingDir', () => ({
  normalizeWorkingDirForStorage: (p: string | null | undefined) => {
    if (!p) return null;
    const n = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return n || null;
  },
}));
import {
  checkRemoteWorkingDir,
  isRemoteWorkingDirAllowed,
  probeRemoteDirectory,
} from '../device-link/remote-workdir-guard.js';

const asDir = async () => ({ isDirectory: () => true });
const asFile = async () => ({ isDirectory: () => false });

beforeEach(() => {
  h.statSpy.mockClear();
  h.setStat(async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
});

describe('isRemoteWorkingDirAllowed', () => {
  it('空 / 非法路径 → 拒', async () => {
    expect(await isRemoteWorkingDirAllowed('')).toBe(false);
  });

  it('曾使用的本地路径仍探测当前可访问性', async () => {
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/proj/a/', { stat: h.statSpy })).toBe(true);
    expect(h.statSpy).toHaveBeenCalledWith('/proj/a/');
  });

  it('本地会话目录不因历史记录绕过探测', async () => {
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/proj/b', { stat: h.statSpy })).toBe(true);
    expect(h.statSpy).toHaveBeenCalledWith('/proj/b');
  });

  it('命中断线的已知本地目录时仍按业务超时拒绝', async () => {
    h.setStat(() => new Promise(() => undefined));

    await expect(checkRemoteWorkingDir('/disconnected/share', {
      stat: h.statSpy,
      timeoutMs: 20,
    })).resolves.toEqual({
      allowed: false,
      reason: 'timeout',
    });
  });

  it('被控端真实存在且是目录 → 放行(远程浏览新目录)', async () => {
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/freshly/browsed/dir', { stat: h.statSpy })).toBe(true);
  });

  it('真实存在的 Cindy 托管 worktree → 放行', async () => {
    h.setStat(asDir);
    expect(
      await isRemoteWorkingDirAllowed('/repo/.cindy-worktrees/auto-test', { stat: h.statSpy }),
    ).toBe(true);
  });

  it('路径不存在 → 拒(挡伪造/笔误路径)', async () => {
    // 默认异步 stat 抛 ENOENT
    expect(await isRemoteWorkingDirAllowed('/does/not/exist', { stat: h.statSpy })).toBe(false);
  });

  it('路径存在但是文件(非目录)→ 拒', async () => {
    h.setStat(asFile);
    expect(await isRemoteWorkingDirAllowed('/some/file.txt', { stat: h.statSpy })).toBe(false);
  });

  it('异步探测 pending 时主线程仍可执行 timer,且按业务超时收敛', async () => {
    h.setStat(() => new Promise(() => undefined));

    const check = checkRemoteWorkingDir('/disconnected/share', {
      stat: h.statSpy,
      timeoutMs: 20,
    });
    let eventLoopAdvanced = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        eventLoopAdvanced = true;
        resolve();
      }, 0);
    });

    expect(eventLoopAdvanced).toBe(true);
    await expect(check).resolves.toEqual({ allowed: false, reason: 'timeout' });
  });

  it('区分不存在、非目录与网络不可达', async () => {
    await expect(
      probeRemoteDirectory('/missing', {
        stat: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not-found' });
    await expect(
      probeRemoteDirectory('/file/child', {
        stat: async () => {
          throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not-directory' });
    await expect(probeRemoteDirectory('/file', { stat: asFile })).resolves.toEqual({
      allowed: false,
      reason: 'not-directory',
    });
    for (const code of ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE']) {
      await expect(
        probeRemoteDirectory('/invalid', {
          stat: async () => {
            throw Object.assign(new TypeError('invalid argument'), { code });
          },
        }),
      ).resolves.toEqual({ allowed: false, reason: 'invalid' });
    }
    await expect(
      probeRemoteDirectory('/offline', {
        stat: async () => {
          throw Object.assign(new Error('offline'), { code: 'EHOSTUNREACH' });
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'unavailable' });
  });
});
