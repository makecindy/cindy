/**
 * killProcessTree 的 win32 重试逻辑(与真机 taskkill 集成测试分开,见
 * procUtil.test.ts)——用 mocked spawn 精确断言重试次数与最终回落,不依赖真实
 * taskkill 的时序。platform 检查发生在 killProcessTree() 调用时(而非模块加载
 * 时),afterEach 里恢复 process.platform,不影响同进程其它测试文件。
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { killProcessTree } from '../proc-util';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('killProcessTree win32 重试(Greptile P1 加固)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('taskkill 前两次失败后第三次成功:重试 3 次、不回落 child.kill', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2]);
    const kill = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 0);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(kill).not.toHaveBeenCalled();
  });

  it('连续 3 次失败后回落 child.kill(SIGKILL)且额外发起后代兜底(Greptile 二次加固回归)', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    const descendantKiller = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      // 第 4 次 spawn:PowerShell 枚举直接子进程
      .mockImplementationOnce(() => psQuery)
      // 第 5 次 spawn:对枚举出的孙进程单独 taskkill /T /F
      .mockImplementationOnce(() => descendantKiller);
    const kill = vi.fn();
    const onSettled = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);

    expect(kill).toHaveBeenCalledWith('SIGKILL');

    // PowerShell 枚举出一个孙进程(python.exe,pid 456)——应对它单独 taskkill /T /F。
    psQuery.stdout.emit('data', Buffer.from('456\r\n'));
    psQuery.emit('close', 0);

    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(spawnMock).toHaveBeenLastCalledWith(
      'taskkill',
      ['/pid', '456', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    // onSettled 必须等孙进程自己的 taskkill 真正 exit 才调用——只枚举出、只发起
    // 是不够的(Greptile 二次 review 明确指出:枚举/taskkill/失败都不会被等待)。
    expect(onSettled).not.toHaveBeenCalled();
    descendantKiller.emit('exit', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('PowerShell 枚举不可用时后代兜底静默跳过,不影响主回落,且立即 settle', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      .mockImplementationOnce(() => psQuery);
    const kill = vi.fn();
    const onSettled = vi.fn();

    expect(() => {
      killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);
    }).not.toThrow();

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(onSettled).not.toHaveBeenCalled();

    expect(() => psQuery.emit('error', new Error('powershell not found'))).not.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(4);
    // PowerShell 本身不可用是"尽力而为"层的终态,不该悬着——立即 settle。
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('PowerShell 卡死(从不 close/error)时 3s 看门狗强杀并 settle,不无限挂起(codex review 四次发现)', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      .mockImplementationOnce(() => psQuery);
    const kill = vi.fn();
    const onSettled = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);
    expect(onSettled).not.toHaveBeenCalled();

    // psQuery 故意什么都不 emit——模拟 PowerShell/CIM 查询真的卡死。
    await vi.advanceTimersByTimeAsync(2_999);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(psQuery.kill).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('查询耗掉大半窗口后,已发起的后代 taskkill 拿到自己的完整窗口,不被阶段一 deadline 掐断(Greptile 五次发现)', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    const descendantKiller = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      .mockImplementationOnce(() => psQuery)
      .mockImplementationOnce(() => descendantKiller);
    const kill = vi.fn();
    const onSettled = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);

    // 查询拖到阶段一窗口只剩 100ms 才返回——若全链路共用一个 deadline,
    // 在途的后代 taskkill 只剩 100ms 就会被无条件掐断提前 settle。
    await vi.advanceTimersByTimeAsync(2_900);
    psQuery.stdout.emit('data', Buffer.from('456\r\n'));
    psQuery.emit('close', 0);

    // 越过原全链路 deadline(3s):阶段二已重新武装,不该提前 settle。
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onSettled).not.toHaveBeenCalled();

    descendantKiller.emit('exit', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('后代 taskkill 自己卡死时阶段二看门狗 3s 兜底 settle,不无界等', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    const descendantKiller = new EventEmitter(); // 从不 exit/error
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      .mockImplementationOnce(() => psQuery)
      .mockImplementationOnce(() => descendantKiller);
    const kill = vi.fn();
    const onSettled = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);
    psQuery.stdout.emit('data', Buffer.from('456\r\n'));
    psQuery.emit('close', 0);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('重试间隙原进程已自然退出时就地收束,不再对可复用的 pid 发第二次 taskkill(codex 五轮发现)', async () => {
    const killer = new EventEmitter();
    spawnMock.mockImplementationOnce(() => killer);
    const child = { kill: vi.fn(), exitCode: null as number | null, signalCode: null };
    const onSettled = vi.fn();
    killProcessTree(123, child as unknown as ChildProcess, onSettled);

    killer.emit('exit', 1); // 第一次 taskkill 失败,150ms 后将重试
    // 重试到来之前进程自然退出(timeout/abort 与自然退出竞速的典型时序)——
    // 此刻 pid 随时可能被 OS 复用,重试链路必须就地收束。
    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(150);

    expect(spawnMock).toHaveBeenCalledTimes(1); // 没有第二次 taskkill,也没有后代兜底
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('进程已退出时 killWindowsTree 入口直接收束,不发起任何 taskkill', () => {
    const child = { kill: vi.fn(), exitCode: 1, signalCode: null };
    const onSettled = vi.fn();
    killProcessTree(123, child as unknown as ChildProcess, onSettled);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽的瞬间子进程已退出时跳过 child.kill/后代兜底,直接收束(codex 第九轮)', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2]);
    const child = { kill: vi.fn(), exitCode: null as number | null, signalCode: null };
    const onSettled = vi.fn();
    killProcessTree(123, child as unknown as ChildProcess, onSettled);

    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    // 第三次 taskkill 报失败前子进程已自然退出——不回落、不发 PowerShell 枚举。
    child.exitCode = 0;
    killers[2].emit('exit', 1);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('taskkill 第一次就成功时 onSettled 同步调用(无需重试/后代兜底)', () => {
    const killer = new EventEmitter();
    spawnMock.mockImplementationOnce(() => killer);
    const kill = vi.fn();
    const onSettled = vi.fn();
    killProcessTree(123, { kill } as unknown as ChildProcess, onSettled);

    killer.emit('exit', 0);
    expect(kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式下父进程已退出仍枚举并终止后代，确认前不 settle', () => {
    const psQuery = fakeProcess();
    const descendantKiller = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => psQuery)
      .mockImplementationOnce(() => descendantKiller);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = 0;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith('powershell', expect.any(Array), expect.any(Object));
    psQuery.stdout.emit('data', Buffer.from('456\r\n'));
    psQuery.emit('close', 0);
    expect(onSettled).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenLastCalledWith(
      'taskkill',
      ['/pid', '456', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );

    descendantKiller.emit('exit', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式下后代在 taskkill 前自然退出会复查空树并 settle', () => {
    const initialQuery = fakeProcess();
    const descendantKiller = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => initialQuery)
      .mockImplementationOnce(() => descendantKiller)
      .mockImplementationOnce(() => verificationQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = 0;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    initialQuery.stdout.emit('data', Buffer.from('456\r\n'));
    initialQuery.emit('close', 0);
    descendantKiller.emit('exit', 128);

    expect(onSettled).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(3);
    verificationQuery.emit('close', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式下后代 taskkill 失败且复查仍存活时保持未 settle', () => {
    const initialQuery = fakeProcess();
    const descendantKiller = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => initialQuery)
      .mockImplementationOnce(() => descendantKiller)
      .mockImplementationOnce(() => verificationQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = 0;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    initialQuery.stdout.emit('data', Buffer.from('456\r\n'));
    initialQuery.emit('close', 0);
    descendantKiller.emit('exit', 128);
    verificationQuery.stdout.emit('data', Buffer.from('456\r\n'));
    verificationQuery.emit('close', 0);

    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式下主 taskkill 成功后仍等待后代确认', () => {
    const killer = new EventEmitter();
    const psQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => psQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: null;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = null;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    killer.emit('exit', 0);
    expect(onSettled).not.toHaveBeenCalled();

    psQuery.emit('close', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式下后代查询失败时保持未 settle', () => {
    const psQuery = fakeProcess();
    spawnMock.mockImplementationOnce(() => psQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = 0;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    psQuery.emit('error', new Error('powershell unavailable'));

    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式下后代查询超时会终止查询但保持未 settle', async () => {
    const psQuery = fakeProcess();
    spawnMock.mockImplementationOnce(() => psQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = 0;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(psQuery.kill).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式下回落 SIGKILL 后等待父进程退出再确认后代', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const psQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2])
      .mockImplementationOnce(() => psQuery);
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: null;
    };
    child.kill = vi.fn();
    child.exitCode = null;
    child.signalCode = null;
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(onSettled).not.toHaveBeenCalled();

    child.exitCode = 1;
    child.emit('exit', 1);
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(onSettled).not.toHaveBeenCalled();
    psQuery.emit('close', 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
