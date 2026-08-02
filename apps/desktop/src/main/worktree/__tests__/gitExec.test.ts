/**
 * gitExec 超时收口单测 —— child_process 与 proc-util 全 mock(不 spawn 真进程)。
 * 覆盖:Windows 超时走 killProcessTree(taskkill /T /F)且树杀收尾后 Promise 稳定
 * 收口(即使 git 回调因后代进程占住 stdio 永不到来)、POSIX 对整个进程组 SIGTERM
 * 并在 deadline 处收口 + 宽限期后 SIGKILL 兜底、正常完成清理定时器、超时后迟到
 * 回调不覆盖结果。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../../scheduler-host/proc-util', () => ({ killProcessTree: mocks.killProcessTree }));

import { gitExec, GitExecError } from '../gitExec';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

interface FakeGit {
  child: {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
  };
  gitOpts: { detached?: boolean } | undefined;
  gitCb: ExecCb | undefined;
}

/** git 调用返回假 child 并捕获回调与 spawn 选项。 */
function installExecFileMock(): FakeGit {
  const state: FakeGit = {
    child: { pid: 4242, kill: vi.fn(), exitCode: null, signalCode: null },
    gitOpts: undefined,
    gitCb: undefined,
  };
  mocks.execFile.mockImplementation(
    (file: string, _args: string[], opts: FakeGit['gitOpts'], cb?: ExecCb) => {
      if (file !== 'git') throw new Error(`unexpected execFile: ${file}`);
      state.gitOpts = opts;
      state.gitCb = cb;
      return state.child;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.execFile.mockReset();
  mocks.killProcessTree.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

describe('gitExec timeoutMs', () => {
  it('Windows 超时 → killProcessTree 整树终止,树杀收尾后 Promise 稳定收口(git 回调永不到来)', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 1000 });
    const expectation = expect(p).rejects.toMatchObject({
      name: 'GitExecError',
      exitCode: null,
      stderr: expect.stringContaining('timed out after 1000ms'),
    });
    vi.advanceTimersByTime(1000);
    await expectation;

    expect(mocks.killProcessTree).toHaveBeenCalledWith(4242, state.child, expect.any(Function));
    // Windows 不开 detached(语义是脱离控制台,树杀走 taskkill /T)
    expect(state.gitOpts?.detached).toBe(false);
  });

  it('POSIX 超时 → 对整个进程组 SIGTERM 并在 deadline 处收口,不等 git 回调', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 500 });
      const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
      vi.advanceTimersByTime(500);
      await expectation;

      // detached 自成进程组长 → kill(-pid) 连 git-remote-http/credential helper 后代一起
      expect(state.gitOpts?.detached).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(mocks.killProcessTree).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('POSIX 超时后进程组仍存活 → 宽限期到点 killProcessTree 整组 SIGKILL 兜底', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
      const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
      vi.advanceTimersByTime(500);
      await expectation;

      // 子进程状态仍是运行中(exitCode/signalCode 均 null)→ 宽限期后兜底整组硬杀
      vi.advanceTimersByTime(1_500);
      expect(mocks.killProcessTree).toHaveBeenCalledWith(4242, state.child);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('POSIX 超时后进程已退出 → 宽限期到点不再兜底硬杀', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
      const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
      vi.advanceTimersByTime(500);
      await expectation;

      state.child.signalCode = 'SIGTERM'; // SIGTERM 已生效
      vi.advanceTimersByTime(1_500);
      expect(mocks.killProcessTree).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('正常完成 → 清理定时器,超时到点不再触发终止', async () => {
    setPlatform('linux');
    const state = installExecFileMock();

    const p = gitExec(['status'], '/repo', { timeoutMs: 1000 });
    state.gitCb!(null, 'clean', '');
    await expect(p).resolves.toEqual({ stdout: 'clean', stderr: '' });

    vi.advanceTimersByTime(2000);
    expect(state.child.kill).not.toHaveBeenCalled();
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
  });

  it('超时收口后迟到的 git 回调不覆盖结果', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const p = gitExec(['fetch'], '/repo', { timeoutMs: 300 });
      const expectation = expect(p).rejects.toMatchObject({
        stderr: expect.stringContaining('timed out'),
      });
      vi.advanceTimersByTime(300);
      await expectation;

      // 后代进程终于释放 stdio,回调姗姗来迟——结果必须仍是超时错误,且不抛未处理异常
      expect(() => state.gitCb!(null, 'late-output', '')).not.toThrow();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('未传 timeoutMs → 不设定时器,等回调正常 resolve', async () => {
    setPlatform('linux');
    const state = installExecFileMock();

    const p = gitExec(['status'], '/repo');
    state.gitCb!(null, 'ok', '');
    await expect(p).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
