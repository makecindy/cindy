import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createForgeIconConverter,
  type ForgeIconConversionChildLike,
} from '../forgeIconConversion.js';
import type { ForgeIconConversionRequest } from '../forgeIconConversionProtocol.js';

class FakeConversionChild extends EventEmitter implements ForgeIconConversionChildLike {
  pid = 123;
  readonly posted: unknown[] = [];
  readonly kill = vi.fn(() => true);

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  request(): ForgeIconConversionRequest {
    return this.posted[0] as ForgeIconConversionRequest;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createForgeIconConverter', () => {
  it('返回隔离进程产出的合规 PNG，并终止一次性进程', async () => {
    const child = new FakeConversionChild();
    const convert = createForgeIconConverter({ fork: () => child });

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
    child.emit('exit', 0);
  });

  it('超时会 kill 隔离进程；锁由 exit 释放，不依赖 Sharp promise settle', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild();
    const second = new FakeConversionChild();
    const fork = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const convert = createForgeIconConverter({ fork });

    const slow = convert('/tmp/slow.png');
    const slowExpectation = expect(slow).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await slowExpectation;
    expect(first.kill).toHaveBeenCalledTimes(1);

    await expect(convert('/tmp/busy.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    first.emit('exit', 0);
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
  });

  it('error 没有后续 exit 时 fail-fast 但不与旧进程并发', async () => {
    const first = new FakeConversionChild();
    const second = new FakeConversionChild();
    const fork = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const convert = createForgeIconConverter({ fork });

    const failed = convert('/tmp/error.png');
    first.emit('error', 'FatalError', 'forge-icon', 'diagnostic report');
    await expect(failed).rejects.toThrow('转换进程异常');

    // 模拟 error 后没有 exit：当前请求已 fail-fast，但旧进程仍占槽，
    // 不允许第二个转换进程与它并发。
    await expect(convert('/tmp/next-after-error.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    first.emit('exit', 1);
    const next = convert('/tmp/next-after-error-exit.png');
    const request = second.request();
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('成功回执后 error 没有 exit 也不提前释放转换槽位', async () => {
    const first = new FakeConversionChild();
    const second = new FakeConversionChild();
    const fork = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const convert = createForgeIconConverter({ fork });

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

    first.emit('exit', 1);
    const next = convert('/tmp/next-after-late-error-exit.png');
    const nextRequest = second.request();
    second.emit('message', {
      kind: 'result',
      id: nextRequest.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('kill 返回 false 且没有 exit 时保持单飞直到 exit', async () => {
    vi.useFakeTimers();
    const first = new FakeConversionChild();
    first.kill.mockReturnValue(false);
    const second = new FakeConversionChild();
    const fork = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const convert = createForgeIconConverter({ fork });

    const failed = convert('/tmp/kill-false.png');
    const failedExpectation = expect(failed).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await failedExpectation;

    // kill 返回 false 不能证明旧进程已经退出；先保持单飞，等 exit 后再开新进程。
    await expect(convert('/tmp/next-after-kill-false.png')).rejects.toThrow('转换繁忙');
    expect(fork).toHaveBeenCalledTimes(1);

    first.emit('exit', 1);
    const next = convert('/tmp/next-after-kill-false-exit.png');
    const request = second.request();
    second.emit('message', {
      kind: 'result',
      id: request.id,
      ok: true,
      png: new Uint8Array(Buffer.from('next')),
    });
    await expect(next).resolves.toEqual(Buffer.from('next'));
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('转换结果超过安装器上限时回退失败', async () => {
    const child = new FakeConversionChild();
    const convert = createForgeIconConverter({ fork: () => child });
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
  });
});
