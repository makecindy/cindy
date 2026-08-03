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
