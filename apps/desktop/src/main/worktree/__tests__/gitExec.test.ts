/**
 * gitExec 超时收口单测 —— child_process 全 mock(不 spawn 真进程)。
 * 覆盖:Windows 超时走 taskkill /T /F 进程树终止且树终止后 Promise 稳定收口
 * (即使 git 回调因后代进程占住 stdio 永不到来)、非 Windows 维持 SIGTERM 语义
 * 并在 deadline 处收口、正常完成清理定时器、超时后迟到回调不覆盖结果。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

import { gitExec, GitExecError } from '../gitExec';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

interface FakeGit {
  child: { pid: number; kill: ReturnType<typeof vi.fn> };
  gitCb: ExecCb | undefined;
  taskkillArgs: string[] | undefined;
}

/** git 调用返回假 child 并捕获回调;taskkill 调用记录参数并同步回调完成。 */
function installExecFileMock(): FakeGit {
  const state: FakeGit = {
    child: { pid: 4242, kill: vi.fn() },
    gitCb: undefined,
    taskkillArgs: undefined,
  };
  mocks.execFile.mockImplementation((file: string, args: string[], optsOrCb: unknown, cb?: ExecCb) => {
    if (file === 'git') {
      state.gitCb = cb;
      return state.child;
    }
    if (file === 'taskkill') {
      state.taskkillArgs = [...args];
      (optsOrCb as ExecCb)(null, '', '');
      return {};
    }
    throw new Error(`unexpected execFile: ${file}`);
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.execFile.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

describe('gitExec timeoutMs', () => {
  it('Windows 超时 → taskkill /T /F 终止进程树,树终止后 Promise 稳定收口(git 回调永不到来)', async () => {
    setPlatform('win32');
    const state = installExecFileMock();

    const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 1000 });
    const expectation = expect(p).rejects.toMatchObject({
      name: 'GitExecError',
      exitCode: null,
      stderr: expect.stringContaining('timed out after 1000ms'),
    });
    vi.advanceTimersByTime(1000);
    await expectation;

    expect(state.taskkillArgs).toEqual(['/pid', '4242', '/T', '/F']);
    expect(state.child.kill).not.toHaveBeenCalled();
  });

  it('非 Windows 超时 → SIGTERM 直接子进程并在 deadline 处收口,不等 git 回调', async () => {
    setPlatform('linux');
    const state = installExecFileMock();

    const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 500 });
    const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
    vi.advanceTimersByTime(500);
    await expectation;

    expect(state.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(state.taskkillArgs).toBeUndefined();
  });

  it('正常完成 → 清理定时器,超时到点不再触发终止', async () => {
    setPlatform('linux');
    const state = installExecFileMock();

    const p = gitExec(['status'], '/repo', { timeoutMs: 1000 });
    state.gitCb!(null, 'clean', '');
    await expect(p).resolves.toEqual({ stdout: 'clean', stderr: '' });

    vi.advanceTimersByTime(2000);
    expect(state.child.kill).not.toHaveBeenCalled();
    expect(state.taskkillArgs).toBeUndefined();
  });

  it('超时收口后迟到的 git 回调不覆盖结果', async () => {
    setPlatform('linux');
    const state = installExecFileMock();

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 300 });
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('timed out'),
    });
    vi.advanceTimersByTime(300);
    await expectation;

    // 后代进程终于释放 stdio,回调姗姗来迟——结果必须仍是超时错误,且不抛未处理异常
    expect(() => state.gitCb!(null, 'late-output', '')).not.toThrow();
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
