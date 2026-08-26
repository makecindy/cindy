/**
 * Windows 普通树杀重试与安全敏感句柄终止。所有测试只 mock spawn，
 * 不依赖真实 taskkill。
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
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
};

function fakeProcess(alive = true): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.kill = vi.fn();
  proc.exitCode = alive ? null : 0;
  proc.signalCode = null;
  return proc;
}

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

  it('普通模式重试三次成功，不回落直接 kill', async () => {
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

  it('普通模式重试耗尽后只 kill Node 直接子进程', async () => {
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

  it('严格模式只终止原始 ChildProcess 句柄，不向裸 PID 发 taskkill 并保持 fail closed', () => {
    const child = fakeProcess();
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsIdentityBoundTermination: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(onSettled).not.toHaveBeenCalled();

    // Direct-child exit or later PID reuse cannot release the package-store
    // lock without a future identity-bound Job Object implementation.
    child.exitCode = 1;
    child.emit('exit', 1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('严格模式入口发现原始子进程已退出时不查询、不 kill、不 settle', () => {
    const child = fakeProcess(false);
    const onSettled = vi.fn();

    killProcessTree(123, child as unknown as ChildProcess, onSettled, {
      requireWindowsIdentityBoundTermination: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
