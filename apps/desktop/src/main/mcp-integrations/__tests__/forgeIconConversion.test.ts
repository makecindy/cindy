import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createForgeIconConverter,
  type ForgeIconConversionChildLike,
} from '../forgeIconConversion.js';
import type { ForgeIconConversionRequest } from '../forgeIconConversionProtocol.js';

class FakeConversionChild extends EventEmitter implements ForgeIconConversionChildLike {
  pid: number | undefined;
  readonly processPid: number;
  alive = true;
  readonly posted: unknown[] = [];
  readonly kill = vi.fn(() => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.processPid = pid;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  request(): ForgeIconConversionRequest {
    return this.posted[0] as ForgeIconConversionRequest;
  }

  exit(code = 0): void {
    this.alive = false;
    this.pid = undefined;
    this.emit('exit', code);
  }
}

function isPidAlive(...children: FakeConversionChild[]) {
  return (pid: number): boolean =>
    children.some((child) => child.processPid === pid && child.alive);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createForgeIconConverter', () => {
  it('返回隔离进程产出的合规 PNG，并终止一次性进程', async () => {
    const child = new FakeConversionChild(101);
    const convert = createForgeIconConverter({
      fork: () => child,
      isPidAlive: isPidAlive(child),
    });

    const result = convert('/tmp/icon.png');
    const request = child.request();
    expect(request).toMatchObject({
      kind: 'convert',
      absPath: '/tmp/icon.png',
      timeoutSeconds: 5,
    });
    child.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('png')),
    });

    await expect(result).resolves.toEqual(Buffer.from('png'));
    expect(child.kill).toHaveBeenCalledTimes(1);

    // The slot remains occupied until the utility process has actually exited.
    await expect(convert('/tmp/overlap.png')).rejects.toThrow('转换繁忙');
    child.exit(0);
  });

  it('超时会 kill 隔离进程；锁由 exit 释放，不依赖 Sharp promise settle', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(102);
    const second = new FakeConversionChild(103);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const convert = createForgeIconConverter({
      fork,
      isPidAlive: isPidAlive(first, second),
    });

    const slow = convert('/tmp/slow.png');
    const slowExpectation = expect(slow).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await slowExpectation;
    expect(first.kill).toHaveBeenCalledTimes(1);

    await expect(convert('/tmp/busy.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    first.exit(0);
    const next = convert('/tmp/next.png');
    const request = second.request();
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
    second.exit(0);
  });

  it('error 没有后续 exit 时，旧进程存活则保持繁忙，确认死亡后恢复', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(104);
    const second = new FakeConversionChild(105);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const probePid = vi.fn(isPidAlive(first, second));
    const convert = createForgeIconConverter({
      fork,
      terminationGraceMs: 100,
      isPidAlive: probePid,
    });

    const failed = convert('/tmp/error.png');
    first.emit('error', 'FatalError', 'forge-icon', 'diagnostic report');
    await expect(failed).rejects.toThrow('转换进程异常');

    // 模拟 error 后没有 exit：当前请求已 fail-fast，隔离窗口内不允许
    // 第二个转换进程与旧进程并发。
    await expect(convert('/tmp/next-after-error.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(first.kill).toHaveBeenCalledTimes(2);
    await expect(convert('/tmp/still-busy-after-error.png')).rejects.toThrow('转换繁忙');

    // Electron 在进程结束后会把 pid 清空；converter 必须继续使用 kill 前
    // 保存的最后一个有效 PID，不能因当前属性变成 undefined 而永久占槽。
    first.pid = undefined;
    first.alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probePid).toHaveBeenCalledWith(104);
    const next = convert('/tmp/next-after-error-recovered.png');
    const request = second.request();
    // 旧实例迟到的 exit 不能清掉已经启动的新一代 active 槽位。
    first.exit(1);
    await expect(convert('/tmp/overlap-after-old-exit.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(2);
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
    second.exit(0);
  });

  it('成功回执后 error 没有 exit 时，旧进程存活则保持繁忙，确认死亡后恢复', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(106);
    const second = new FakeConversionChild(107);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const convert = createForgeIconConverter({
      fork,
      terminationGraceMs: 100,
      isPidAlive: isPidAlive(first, second),
    });

    const firstResult = convert('/tmp/success-then-error.png');
    const firstRequest = first.request();
    first.emit('message', {
      kind: 'result',
      id: firstRequest.id,
      ok: true,
      png: new Uint8Array(Buffer.from('first')),
    });
    await expect(firstResult).resolves.toEqual(Buffer.from('first'));
    first.emit('error', 'FatalError', 'forge-icon', 'diagnostic report');

    await expect(convert('/tmp/next-after-late-error.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(first.kill).toHaveBeenCalledTimes(2);
    await expect(convert('/tmp/still-busy-after-late-error.png')).rejects.toThrow('转换繁忙');

    first.alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const next = convert('/tmp/next-after-late-error-recovered.png');
    const nextRequest = second.request();
    first.exit(1);
    second.emit('message', {
      kind: 'result',
      id: nextRequest.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
    second.exit(0);
  });

  it('kill 抛错且没有 exit 时，无法确认死亡则继续 quarantine', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(111);
    first.kill.mockImplementation(() => {
      throw new Error('kill unavailable');
    });
    const second = new FakeConversionChild(112);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const convert = createForgeIconConverter({
      fork,
      timeoutMs: 50,
      terminationGraceMs: 100,
      isPidAlive: isPidAlive(first, second),
    });

    const failed = convert('/tmp/kill-throws.png');
    const failedExpectation = expect(failed).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(50);
    await failedExpectation;
    await vi.advanceTimersByTimeAsync(100);
    expect(first.kill).toHaveBeenCalledTimes(2);
    await expect(convert('/tmp/still-busy-after-kill-throws.png')).rejects.toThrow('转换繁忙');

    first.alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const next = convert('/tmp/next-after-kill-throws.png');
    const request = second.request();
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    second.exit(0);
  });

  it('探活返回未知错误时 fail-closed，直到收到 exit 才释放', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(113);
    const second = new FakeConversionChild(114);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const isPidAliveUnknown = vi.fn(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    const convert = createForgeIconConverter({
      fork,
      terminationGraceMs: 100,
      isPidAlive: isPidAliveUnknown,
    });

    const firstResult = convert('/tmp/unknown-liveness.png');
    const firstRequest = first.request();
    first.emit('message', {
      kind: 'result',
      id: firstRequest.id,
      ok: true,
      png: new Uint8Array(Buffer.from('first')),
    });
    await expect(firstResult).resolves.toEqual(Buffer.from('first'));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(convert('/tmp/still-busy-after-unknown-liveness.png')).rejects.toThrow('转换繁忙');

    first.exit(0);
    const next = convert('/tmp/next-after-unknown-liveness.png');
    const nextRequest = second.request();
    second.emit('message', {
      kind: 'result',
      id: nextRequest.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    second.exit(0);
  });

  it('kill 返回 false 且没有 exit 时，确认死亡后才恢复', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild(108);
    first.kill.mockReturnValue(false);
    const second = new FakeConversionChild(109);
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const convert = createForgeIconConverter({
      fork,
      timeoutMs: 50,
      terminationGraceMs: 100,
      isPidAlive: isPidAlive(first, second),
    });

    const failed = convert('/tmp/kill-false.png');
    const failedExpectation = expect(failed).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(50);
    await failedExpectation;

    // kill 返回 false 不能证明旧进程已经退出；即使首轮窗口到期，仍保持单飞。
    await expect(convert('/tmp/next-after-kill-false.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(first.kill).toHaveBeenCalledTimes(2);
    await expect(convert('/tmp/still-busy-after-kill-false.png')).rejects.toThrow('转换繁忙');

    first.alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const next = convert('/tmp/next-after-kill-false-recovered.png');
    const request = second.request();
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
    second.exit(0);
  });

  it('转换结果超过安装器上限时回退失败', async () => {
    const child = new FakeConversionChild(110);
    const convert = createForgeIconConverter({
      fork: () => child,
      isPidAlive: isPidAlive(child),
    });
    const result = convert('/tmp/large.png');
    const request = child.request();
    child.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(512 * 1024 + 1),
    });

    await expect(result).rejects.toThrow('转换结果必须在');
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.exit(1);
  });
});
