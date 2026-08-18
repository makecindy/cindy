/**
 * Windows 树杀重试与严格身份确认。所有测试只 mock spawn，不依赖真实 taskkill/WMI。
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { killProcessTree } from '../proc-util';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
};

function fakeProcess(alive = true): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  proc.exitCode = alive ? null : 0;
  proc.signalCode = null;
  return proc;
}

function emitTable(query: FakeChild, rows: string[]): void {
  if (rows.length > 0) query.stdout.emit('data', Buffer.from(`${rows.join('\r\n')}\r\n`));
  query.emit('close', 0);
}

const ROOT = '123\t10\troot-created';
const CHILD = '456\t123\tchild-created';
const GRANDCHILD = '789\t456\tgrandchild-created';

describe('killProcessTree win32 PID identity safety', () => {
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

  it('普通模式重试三次成功，不启动 PowerShell 或回落直接 kill', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2]);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled);
    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 0);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls.every(([command]) => command === 'taskkill')).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('普通模式重试耗尽后只 kill Node 直接子进程，不按释放 PID 枚举后代', async () => {
    const killers = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    spawnMock
      .mockImplementationOnce(() => killers[0])
      .mockImplementationOnce(() => killers[1])
      .mockImplementationOnce(() => killers[2]);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled);
    killers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    killers[2].emit('exit', 1);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls.every(([command]) => command === 'taskkill')).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('普通模式重试间隙父进程退出，不再向可复用 PID 发 taskkill', async () => {
    const killer = new EventEmitter();
    spawnMock.mockImplementationOnce(() => killer);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled);
    killer.emit('exit', 1);
    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(150);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式先捕获存活树的稳定身份，再 taskkill 并只读确认消失', () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => verificationQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenLastCalledWith('powershell', expect.any(Array), expect.any(Object));

    emitTable(snapshotQuery, [ROOT, CHILD, GRANDCHILD]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith(
      'taskkill',
      ['/pid', '123', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    killer.emit('exit', 0);
    expect(onSettled).not.toHaveBeenCalled();
    emitTable(verificationQuery, []);

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式持续观察仍存活的已捕获身份，并在延迟退出后只 settle 一次', async () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const firstVerification = fakeProcess();
    const secondVerification = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => firstVerification)
      .mockImplementationOnce(() => secondVerification);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT, CHILD]);
    killer.emit('exit', 0);
    emitTable(firstVerification, [CHILD]);

    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    emitTable(secondVerification, []);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式忽略已复用 PID 和它的新后代，绝不把它们当 kill 目标', () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => verificationQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT, CHILD]);
    killer.emit('exit', 0);
    emitTable(verificationQuery, [
      '123\t10\tunrelated-root-created',
      '456\t123\tunrelated-child-created',
      '999\t456\tunrelated-grandchild-created',
    ]);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toEqual([
      ['taskkill', ['/pid', '123', '/T', '/F'], { windowsHide: true }],
    ]);
  });

  it('严格模式无法捕获存活期身份时只 kill 原始 ChildProcess，并保持 fail closed', () => {
    const snapshotQuery = fakeProcess();
    spawnMock.mockImplementationOnce(() => snapshotQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    snapshotQuery.emit('error', new Error('powershell unavailable'));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式入口发现父进程已退出时不查询、不 kill、不 settle', () => {
    const child = fakeProcess(false);
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式重试前刷新树身份，并把新后代纳入最终确认', async () => {
    const initialQuery = fakeProcess();
    const firstKiller = new EventEmitter();
    const refreshQuery = fakeProcess();
    const secondKiller = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => initialQuery)
      .mockImplementationOnce(() => firstKiller)
      .mockImplementationOnce(() => refreshQuery)
      .mockImplementationOnce(() => secondKiller)
      .mockImplementationOnce(() => verificationQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(initialQuery, [ROOT, CHILD]);
    firstKiller.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    emitTable(refreshQuery, [ROOT, CHILD, GRANDCHILD]);
    secondKiller.emit('exit', 0);
    emitTable(verificationQuery, [GRANDCHILD]);

    expect(onSettled).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(2);
    expect(
      spawnMock.mock.calls.some(([, args]) => (args as string[] | undefined)?.includes('789')),
    ).toBe(false);
  });

  it('严格模式刷新时 root 身份已变化，不再 taskkill 复用 PID，仅确认旧快照', async () => {
    const initialQuery = fakeProcess();
    const firstKiller = new EventEmitter();
    const refreshQuery = fakeProcess();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => initialQuery)
      .mockImplementationOnce(() => firstKiller)
      .mockImplementationOnce(() => refreshQuery)
      .mockImplementationOnce(() => verificationQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(initialQuery, [ROOT, CHILD]);
    firstKiller.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    emitTable(refreshQuery, ['123\t10\tunrelated-root-created']);
    emitTable(verificationQuery, ['123\t10\tunrelated-root-created']);

    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式三次失败后只 kill 直接子进程，退出后按快照确认', async () => {
    const initialQuery = fakeProcess();
    const firstKiller = new EventEmitter();
    const firstRefresh = fakeProcess();
    const secondKiller = new EventEmitter();
    const secondRefresh = fakeProcess();
    const thirdKiller = new EventEmitter();
    const verificationQuery = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => initialQuery)
      .mockImplementationOnce(() => firstKiller)
      .mockImplementationOnce(() => firstRefresh)
      .mockImplementationOnce(() => secondKiller)
      .mockImplementationOnce(() => secondRefresh)
      .mockImplementationOnce(() => thirdKiller)
      .mockImplementationOnce(() => verificationQuery);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(initialQuery, [ROOT, CHILD]);
    firstKiller.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    emitTable(firstRefresh, [ROOT, CHILD]);
    secondKiller.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(150);
    emitTable(secondRefresh, [ROOT, CHILD]);
    thirdKiller.emit('exit', 1);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(onSettled).not.toHaveBeenCalled();
    child.exitCode = 1;
    child.emit('exit', 1);
    emitTable(verificationQuery, []);

    expect(spawnMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(3);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式确认查询暂时失败后继续观察，并在身份消失时 settle', async () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const failedVerification = fakeProcess();
    const recoveredVerification = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => failedVerification)
      .mockImplementationOnce(() => recoveredVerification);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT]);
    killer.emit('exit', 0);
    failedVerification.emit('error', new Error('temporary CIM failure'));

    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    emitTable(recoveredVerification, []);

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式确认查询超时后继续观察，并在身份消失时 settle', async () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const timedOutVerification = fakeProcess();
    const recoveredVerification = fakeProcess();
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => timedOutVerification)
      .mockImplementationOnce(() => recoveredVerification);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT]);
    killer.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(timedOutVerification.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    emitTable(recoveredVerification, []);

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('严格模式连续无法查询身份时进入 fail-closed 终态', async () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const failedVerifications = [fakeProcess(), fakeProcess(), fakeProcess()];
    spawnMock
      .mockImplementationOnce(() => snapshotQuery)
      .mockImplementationOnce(() => killer)
      .mockImplementationOnce(() => failedVerifications[0])
      .mockImplementationOnce(() => failedVerifications[1])
      .mockImplementationOnce(() => failedVerifications[2]);
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT]);
    killer.emit('exit', 0);
    failedVerifications[0].emit('error', new Error('CIM unavailable'));
    await vi.advanceTimersByTimeAsync(150);
    failedVerifications[1].emit('error', new Error('CIM unavailable'));
    await vi.advanceTimersByTimeAsync(150);
    failedVerifications[2].emit('error', new Error('CIM unavailable'));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式不因固定轮数放弃仍存活的身份，并在最终消失后释放', async () => {
    const snapshotQuery = fakeProcess();
    const killer = new EventEmitter();
    const verifications = Array.from({ length: 21 }, () => fakeProcess());
    spawnMock.mockImplementationOnce(() => snapshotQuery).mockImplementationOnce(() => killer);
    for (const verification of verifications) {
      spawnMock.mockImplementationOnce(() => verification);
    }
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsDescendantConfirmation: true,
    });
    emitTable(snapshotQuery, [ROOT, CHILD]);
    killer.emit('exit', 0);
    emitTable(verifications[0], [CHILD]);
    for (const verification of verifications.slice(1, -1)) {
      await vi.advanceTimersByTimeAsync(150);
      emitTable(verification, [CHILD]);
    }
    await vi.advanceTimersByTimeAsync(150);
    emitTable(verifications.at(-1)!, []);

    expect(spawnMock).toHaveBeenCalledTimes(23);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
