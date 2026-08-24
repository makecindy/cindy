/**
 * gitExec 超时收口单测 —— child_process 与 proc-util 全 mock(不 spawn 真进程)。
 * 覆盖:Windows 超时走 killProcessTree(taskkill /T /F)且树杀收尾后 Promise 稳定
 * 收口(即使 git 回调因后代进程占住 stdio 永不到来)、POSIX 整组 SIGTERM 后按
 * **进程组清空**判定收口(直接 git 进程 exit ≠ 组清空,幸存后代在场时不得提前
 * 收口)+ 宽限期整组 SIGKILL 兜底、正常完成清理定时器、超时后迟到回调不覆盖结果。
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  killProcessTree: vi.fn(),
  withCrossProcessLock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../../scheduler-host/proc-util', () => ({ killProcessTree: mocks.killProcessTree }));
vi.mock('../../device-link/crossProcessLock', () => ({
  withCrossProcessLock: mocks.withCrossProcessLock,
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  gitExec,
  GitExecError,
  normalizeSafeDirectorySpelling,
  safeDirectorySpellings,
} from '../gitExec';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

type FakeChild = EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
};

interface FakeGit {
  child: FakeChild;
  gitOpts: { detached?: boolean } | undefined;
  gitCb: ExecCb | undefined;
  /** powershell 进程表应答:null = 查询失败(降级路径),数组 = Win32_Process 行。 */
  psTable: Array<{ ProcessId: number; ParentProcessId: number; CreationDate: string }> | null;
  /** ≥1 时:从第 N 次 powershell 调用起,应答延迟该毫秒数(模拟 WMI 卡顿)。 */
  psDelayFromCall: number;
  psDelayMs: number;
  psCalls: number;
  /** 每次 powershell 调用收到的 execFile timeout 值。 */
  psTimeouts: number[];
  /** true = 查询永不应答,只在自身 execFile timeout 到点报错(模拟 WMI 挂死)。 */
  psHangUntilTimeout: boolean;
}

/** git 调用返回假 child 并捕获回调与 spawn 选项;powershell 调用按 psTable 应答。 */
function installExecFileMock(): FakeGit {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  const state: FakeGit = {
    child,
    gitOpts: undefined,
    gitCb: undefined,
    psTable: null,
    psDelayFromCall: 0,
    psDelayMs: 0,
    psCalls: 0,
    psTimeouts: [],
    psHangUntilTimeout: false,
  };
  mocks.execFile.mockImplementation(
    (file: string, _args: string[], opts: FakeGit['gitOpts'] & { timeout?: number }, cb?: ExecCb) => {
      if (file === 'powershell.exe') {
        state.psCalls += 1;
        state.psTimeouts.push(opts?.timeout ?? -1);
        if (state.psHangUntilTimeout) {
          // 模拟 WMI 挂死:只有 execFile 自身的 timeout 到点才以错误收口
          setTimeout(() => cb!(new Error('powershell query timed out'), '', ''), opts?.timeout ?? 3_000);
          return {};
        }
        const answer = () => {
          if (state.psTable === null) cb!(new Error('powershell unavailable'), '', '');
          else cb!(null, JSON.stringify(state.psTable), '');
        };
        if (state.psDelayFromCall > 0 && state.psCalls >= state.psDelayFromCall) {
          setTimeout(answer, state.psDelayMs);
        } else {
          answer();
        }
        return {};
      }
      if (file !== 'git') throw new Error(`unexpected execFile: ${file}`);
      state.gitOpts = opts;
      state.gitCb = cb;
      return state.child;
    },
  );
  return state;
}

/**
 * 模拟 POSIX 进程组:kill(-pid, 0) 探测按 group.alive 应答(空组抛 ESRCH),
 * 其余信号记录后吞掉。返回可变的 group 状态与信号记录。
 */
function installProcessKillMock() {
  const group = { alive: true, signals: [] as (string | number)[] };
  const spy = vi.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    if (pid === -4242) {
      if (signal === 0) {
        if (group.alive) return true;
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      group.signals.push(signal ?? 'SIGTERM');
      return true;
    }
    return true;
  }) as typeof process.kill);
  return { group, spy };
}

/** 探针:promise 是否已 settle(拒绝被吞掉,只记录状态)。 */
function probe(p: Promise<unknown>) {
  const s = { settled: false };
  p.then(
    () => {
      s.settled = true;
    },
    () => {
      s.settled = true;
    },
  );
  return s;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.execFile.mockReset();
  mocks.killProcessTree.mockReset();
  mocks.withCrossProcessLock.mockReset();
  // 默认按「持锁成功」直通, 让 dubious-ownership 的 read+add 序列可逐步驱动;
  // 需要验证锁被使用时单独断言 mock 调用即可。
  mocks.withCrossProcessLock.mockImplementation(
    (_lockPath: string, _opts: unknown, task: (status: unknown) => Promise<unknown>) =>
      task({ held: true }),
  );
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('gitExec timeoutMs', () => {
  it('Windows 超时 → 快照确认 git 树幸存者(含 git.exe 已退但后代仍活)全部消失才收口', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    // git.exe(4242)已退出不在表里,但它的后代 credential helper(5001)仍存活
    state.psTable = [
      { ProcessId: 5001, ParentProcessId: 4242, CreationDate: '/Date(1)/' },
      { ProcessId: 9999, ParentProcessId: 1, CreationDate: '/Date(2)/' }, // 无关进程
    ];
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      name: 'GitExecError',
      exitCode: null,
      stderr: expect.stringContaining('timed out after 1000ms'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4242, state.child, expect.any(Function));
    // 后代 5001 仍在进程表 → 不收口;stdio 放手也不当作证明
    state.gitCb!(new Error('killed'), '', '');
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    // 后代退出(从进程表消失)→ 下一轮轮询确认后收口
    state.psTable = [{ ProcessId: 9999, ParentProcessId: 1, CreationDate: '/Date(2)/' }];
    await vi.advanceTimersByTimeAsync(250);
    await expectation;
    // Windows 不开 detached(语义是脱离控制台,树杀走 taskkill /T)
    expect(state.gitOpts?.detached).toBe(false);
  });

  it('Windows 快照后新派生的后代按闭包并入追踪 → 初始成员消失但新后代仍活时不收口', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = [{ ProcessId: 5001, ParentProcessId: 4242, CreationDate: '/Date(1)/' }];
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('timed out'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    // 5001 在两轮之间 fork 出 5002 后自己退出:初始快照键全部消失,但树未退净
    state.psTable = [{ ProcessId: 5002, ParentProcessId: 5001, CreationDate: '/Date(9)/' }];
    await vi.advanceTimersByTimeAsync(250);
    expect(s.settled).toBe(false);

    // 新后代也退出且 stdio 放手 → 血缘清空 + 句柄释放双信号,下一轮确认后收口
    state.gitCb!(new Error('killed'), '', '');
    state.psTable = [];
    await vi.advanceTimersByTimeAsync(250);
    await expectation;
  });

  it('Windows 进程表轮询串行化 → 上一轮查询未完成不叠加新的 PowerShell 查询', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = [{ ProcessId: 5001, ParentProcessId: 4242, CreationDate: '/Date(1)/' }];
    // 从第 2 次查询(首轮轮询)起模拟 WMI 卡顿 600ms(> 250ms 轮询间隔)
    state.psDelayFromCall = 2;
    state.psDelayMs = 600;
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    probe(p);
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(state.psCalls).toBe(2); // 杀前血缘快照 + 树杀收尾后的首轮查询(在途,延迟应答)

    // 首轮轮询 t≈+600 才完成,+850 启动第二轮(其应答 +1450);若是 setInterval
    // 会在 250/500/750/1000 不断叠加新查询
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.psCalls).toBe(3);
  });

  it('Windows 血缘集为空(树在表中不可见)≠ 树已清空 → 还要等 stdio 放手才判 terminated', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = [{ ProcessId: 9999, ParentProcessId: 1, CreationDate: '/Date(2)/' }];
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('process tree terminated'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    // trackedKeys 为空不等于树已退净:血缘不可见的孤儿可能仍持有继承句柄
    expect(s.settled).toBe(false);

    state.gitCb!(new Error('killed'), '', '');
    await expectation;
  });

  it('Windows 中间父在快照前已亡 → 其孤儿后代血缘不可见,靠 stdio 信号封堵不误判', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    // 快照时 git.exe(4242)还在,但 credential helper(5002)的父 4700 已退出:
    // 5002 的 ppid 链断裂,血缘追踪不到它
    state.psTable = [
      { ProcessId: 4242, ParentProcessId: 100, CreationDate: '/Date(0)/' },
      { ProcessId: 5002, ParentProcessId: 4700, CreationDate: '/Date(3)/' },
    ];
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('process tree terminated'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    // 树杀后 git.exe 消失,血缘集清空——但 5002(孤儿)仍在且持有继承的 stdio:
    // 不得判 terminated
    state.psTable = [{ ProcessId: 5002, ParentProcessId: 4700, CreationDate: '/Date(3)/' }];
    await vi.advanceTimersByTimeAsync(250);
    expect(s.settled).toBe(false);

    // 孤儿退出并放开 stdio → 双信号满足,收口
    state.gitCb!(new Error('killed'), '', '');
    await expectation;
  });

  it('Windows 进程表不可用 → 降级 stdio 放手信号收口', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = null; // PowerShell 查询失败
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    state.gitCb!(new Error('killed'), '', '');
    await expectation;
  });

  it('Windows 幸存者始终不消失 → 总看门狗按 cleanup unconfirmed 收口(有界,不当清空证明)', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = [{ ProcessId: 5001, ParentProcessId: 4242, CreationDate: '/Date(1)/' }];
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('cleanup unconfirmed'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    await expectation;
  });

  it('Windows 血缘快照挂死 → 独立短预算(1s)失效后树杀仍在总看门狗到期前启动', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psHangUntilTimeout = true; // WMI 挂死:快照只能靠自身 timeout 结束
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('cleanup unconfirmed'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    // 快照使用独立短预算,不与总看门狗(3s)同预算
    expect(state.psTimeouts[0]).toBe(1_000);
    expect(mocks.killProcessTree).not.toHaveBeenCalled();

    // 快照 1s 到点失败 → 树杀立刻启动,距总看门狗(+3s)还有 2s 余量
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4242, state.child, expect.any(Function));

    // 进程表不可用 → 降级 stdio 等待;放手后按 cleanup unconfirmed 收口
    state.gitCb!(new Error('killed'), '', '');
    await expectation;
  });

  it('Windows taskkill 自身卡住(killProcessTree 收尾永不回调)→ 入口看门狗有界收口', async () => {
    setPlatform('win32');
    const state = installExecFileMock();
    state.psTable = [{ ProcessId: 5001, ParentProcessId: 4242, CreationDate: '/Date(1)/' }];
    mocks.killProcessTree.mockImplementation(() => {
      /* 收尾回调永不触发:看门狗必须先于树杀武装,否则 Promise 永悬 */
    });

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 1000 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('cleanup unconfirmed'),
    });
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(s.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await expectation;
  });

  it('POSIX 超时 → 整组 SIGTERM;直接 git 已 exit 但后代仍存活 → 不提前收口,组清空才收口', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const { group } = installProcessKillMock();

    const p = gitExec(['fetch', 'origin', 'main'], '/repo', { timeoutMs: 500 });
    const s = probe(p);
    const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);

    // 直接 git 进程已退出(exit ≠ 组清空),组里的 git-remote-http 仍存活
    state.child.exitCode = 0;
    vi.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(state.gitOpts?.detached).toBe(true);
    expect(group.signals).toContain('SIGTERM');
    // 组未清空 → 不许收口,后续 rev-parse/createWorktree 不得与幸存后代并发
    expect(s.settled).toBe(false);
    vi.advanceTimersByTime(300); // 几个轮询周期后依旧存活 → 仍不收口
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    // 后代终于退出,组清空 → 下一个轮询周期收口
    group.alive = false;
    vi.advanceTimersByTime(100);
    await expectation;
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
  });

  it('POSIX 宽限期到点整组 SIGKILL → 硬杀后组仍在(将死进程)不立即收口,组消失才收口', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const { group } = installProcessKillMock(); // group.alive 始终 true
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
    const s = probe(p);
    const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);

    vi.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    // 宽限期到点 → 整组硬杀;SIGKILL 发送成功 ≠ 组已消失,仍不许收口
    vi.advanceTimersByTime(1_500);
    await flushMicrotasks();
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4242, state.child, expect.any(Function));
    expect(s.settled).toBe(false);

    // 将死进程被内核回收、组消失 → 轮询确认后收口
    group.alive = false;
    vi.advanceTimersByTime(100);
    await expectation;
  });

  it('POSIX 硬杀后组始终不消失(不可杀进程)→ 入口看门狗按 cleanup unconfirmed 收口,不永悬', async () => {
    setPlatform('linux');
    installExecFileMock();
    installProcessKillMock(); // group.alive 始终 true
    mocks.killProcessTree.mockImplementation(
      (_pid: number, _child: unknown, onSettled?: () => void) => onSettled?.(),
    );

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('cleanup unconfirmed'),
    });

    vi.advanceTimersByTime(500 + 1_500);
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    vi.advanceTimersByTime(1_500);
    await expectation;
  });

  it('POSIX 超时时进程组已清空(回调被继承的 stdio 拖住)→ 直接收口,不发终止信号', async () => {
    setPlatform('linux');
    installExecFileMock();
    const { group } = installProcessKillMock();
    group.alive = false;

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
    const expectation = expect(p).rejects.toBeInstanceOf(GitExecError);
    vi.advanceTimersByTime(500);
    await expectation;

    expect(group.signals).toEqual([]);
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
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

  it('超时后 execFile 回调先到而组未清空 → 不提前 settle,组清空才 reject', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const { group } = installProcessKillMock();

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 500 });
    const s = probe(p);
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('timed out'),
    });

    vi.advanceTimersByTime(500);
    await flushMicrotasks();
    // leader 退出、stdio 关闭 → execFile 回调到了,但 credential helper 还活着:
    // 回调不得抢先 settle,否则调用方与幸存后代并发争锁
    state.gitCb!(new Error('killed'), '', '');
    await flushMicrotasks();
    expect(s.settled).toBe(false);

    group.alive = false;
    vi.advanceTimersByTime(100);
    await expectation;
  });

  it('超时收口后迟到的 git 回调不覆盖结果', async () => {
    setPlatform('linux');
    const state = installExecFileMock();
    const { group } = installProcessKillMock();

    const p = gitExec(['fetch'], '/repo', { timeoutMs: 300 });
    const expectation = expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('timed out'),
    });
    vi.advanceTimersByTime(300);
    group.alive = false;
    vi.advanceTimersByTime(100);
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

describe('gitExec dubious-ownership safe.directory', () => {
  /**
   * 只按调用顺序捕获每次 git execFile 的 args 与回调(不 spawn 真进程),
   * 供 dubious-ownership 的「幂等 add + 重试一次」路径逐步驱动。
   */
  function installSequenceMock() {
    const calls: string[][] = [];
    const cbs: ExecCb[] = [];
    mocks.execFile.mockImplementation(
      (file: string, args: string[], _opts: unknown, cb?: ExecCb) => {
        if (file !== 'git') throw new Error(`unexpected execFile: ${file}`);
        calls.push(args as string[]);
        cbs.push(cb as ExecCb);
        return new EventEmitter();
      },
    );
    return { calls, cbs };
  }

  async function flushDeep() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('首次 dubious ownership → 幂等加入 safe.directory 后重试一次', async () => {
    const { calls, cbs } = installSequenceMock();

    const p = gitExec(['status'], '/repo');
    expect(calls).toEqual([['status']]);
    cbs[0](new Error('boom'), '', "fatal: detected dubious ownership in repository at '/repo'");
    await flushDeep();

    // read+add 必须包在跨进程锁里, 保证并发实例下仍是原子的
    expect(mocks.withCrossProcessLock).toHaveBeenCalledTimes(1);

    // 读取现有 safe.directory → 未配置(exit 1)按空处理
    expect(calls[1]).toEqual(['config', '--global', '--get-all', 'safe.directory']);
    cbs[1](Object.assign(new Error('exit 1'), { code: 1 }), '', '');
    await flushDeep();

    // 尚不存在 → 幂等 add 一次
    expect(calls[2]).toEqual(['config', '--global', '--add', 'safe.directory', '/repo']);
    cbs[2](null, '', '');
    await flushDeep();

    // 重试原命令
    expect(calls[3]).toEqual(['status']);
    cbs[3](null, 'ok', '');
    await expect(p).resolves.toEqual({ stdout: 'ok', stderr: '' });
  });

  it('路径已在 safe.directory 中 → 不重复 --add, 直接重试原命令', async () => {
    const { calls, cbs } = installSequenceMock();

    const p = gitExec(['status'], '/repo');
    cbs[0](new Error('boom'), '', "fatal: detected dubious ownership in repository at '/repo'");
    await flushDeep();

    expect(calls[1]).toEqual(['config', '--global', '--get-all', 'safe.directory']);
    cbs[1](null, '/repo\n', '');
    await flushDeep();

    // 已存在 → 跳过 --add, 直接重试
    expect(calls[2]).toEqual(['status']);
    cbs[2](null, 'ok', '');
    await expect(p).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(calls.some((a) => a.includes('--add'))).toBe(false);
  });

  it('--get-all 读取失败(非「键不存在」) → 不 --add, 原错误上抛', async () => {
    const { calls, cbs } = installSequenceMock();

    const p = gitExec(['status'], '/repo');
    cbs[0](new Error('boom'), '', "fatal: detected dubious ownership in repository at '/repo'");
    await flushDeep();

    expect(calls[1]).toEqual(['config', '--global', '--get-all', 'safe.directory']);
    // 读取错误(exit 3 = 配置文件损坏/锁冲突)不得被当成「未配置」,后续 --add 不得发生
    const readErr = Object.assign(new Error('bad config'), { code: 3 });
    cbs[1](readErr, '', 'error: could not lock config file');
    await flushDeep();

    expect(calls.some((a) => a.includes('--add'))).toBe(false);
    // 原 dubious-ownership 错误上抛(不再重试)
    await expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('dubious ownership'),
    });
  });

  it('未持锁(held:false) → 不做无锁 read+add, 原错误上抛', async () => {
    const { calls, cbs } = installSequenceMock();
    mocks.withCrossProcessLock.mockImplementation((_lp, _opts, task) =>
      task({ held: false, reason: 'busy' }),
    );

    const p = gitExec(['status'], '/repo');
    cbs[0](new Error('boom'), '', "fatal: detected dubious ownership in repository at '/repo'");
    await flushDeep();

    // 锁未拿到 → 不得执行任何 config 读写, 原 dubious-ownership 错误上抛
    expect(calls).toEqual([['status']]);
    await expect(p).rejects.toMatchObject({
      stderr: expect.stringContaining('dubious ownership'),
    });
  });
});

describe('safe.directory path spelling', () => {
  it('normalizes Windows backslashes to forward slashes', () => {
    setPlatform('win32');
    expect(normalizeSafeDirectorySpelling('C:\\repo\\.xdt-worktrees\\s1')).toBe(
      'C:/repo/.xdt-worktrees/s1',
    );
    expect(normalizeSafeDirectorySpelling('C:/repo/.xdt-worktrees/s1')).toBe(
      'C:/repo/.xdt-worktrees/s1',
    );
  });

  it('returns the native spelling only on POSIX', () => {
    setPlatform('linux');
    expect(normalizeSafeDirectorySpelling('/repo/.xdt-worktrees/s1')).toBe(
      '/repo/.xdt-worktrees/s1',
    );
    expect(safeDirectorySpellings('/repo/.xdt-worktrees/s1')).toEqual([
      '/repo/.xdt-worktrees/s1',
    ]);
  });

  it('covers both spellings on Windows for exact --fixed-value cleanup', () => {
    setPlatform('win32');
    expect(safeDirectorySpellings('C:\\repo\\s1')).toEqual(['C:/repo/s1', 'C:\\repo\\s1']);
    expect(safeDirectorySpellings('C:/repo/s1')).toEqual(['C:/repo/s1']);
  });
});
