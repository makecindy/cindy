import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createForgeIconConverter,
  type ForgeSharpModule,
} from '../forgeIconConversion.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSharpFactory(outputs: Array<Promise<Buffer>>) {
  const timeout = vi.fn();
  const png = vi.fn();
  const factory = vi.fn(() => {
    const output = outputs.shift();
    if (!output) throw new Error('missing fake sharp output');
    const pipeline = {
      rotate: vi.fn(() => pipeline),
      resize: vi.fn(() => pipeline),
      png: png.mockImplementation(() => pipeline),
      timeout: timeout.mockImplementation(() => pipeline),
      toBuffer: vi.fn(() => output),
    };
    return pipeline;
  });
  return {
    sharp: factory as unknown as ForgeSharpModule,
    factory,
    png,
    timeout,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createForgeIconConverter', () => {
  it('启用 sharp 原生超时、palette 量化并返回合规 PNG', async () => {
    const fake = makeSharpFactory([Promise.resolve(Buffer.from('png'))]);
    const convert = createForgeIconConverter({ loadSharp: () => fake.sharp });

    await expect(convert('/tmp/icon.png')).resolves.toEqual(Buffer.from('png'));
    expect(fake.timeout).toHaveBeenCalledWith({ seconds: 5 });
    expect(fake.png).toHaveBeenCalledWith({
      compressionLevel: 9,
      palette: true,
      colours: 256,
      effort: 7,
    });
  });

  it('wall-clock 超时后保持单飞，直到原生任务真正 settle 才允许下一次转换', async () => {
    vi.useFakeTimers();
    const firstNative = deferred<Buffer>();
    const fake = makeSharpFactory([
      firstNative.promise,
      Promise.resolve(Buffer.from('next')),
    ]);
    const convert = createForgeIconConverter({ loadSharp: () => fake.sharp });

    const first = convert('/tmp/slow.png');
    const firstExpectation = expect(first).rejects.toThrow('转换超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await firstExpectation;

    await expect(convert('/tmp/busy.png')).rejects.toThrow('转换繁忙');
    expect(fake.factory).toHaveBeenCalledTimes(1);

    firstNative.reject(new Error('late native failure'));
    await vi.runAllTicks();
    await Promise.resolve();

    await expect(convert('/tmp/next.png')).resolves.toEqual(Buffer.from('next'));
    expect(fake.factory).toHaveBeenCalledTimes(2);
  });

  it('转换结果超过安装器上限时回退失败，不把不可安装的 icon 交给 Forge', async () => {
    const fake = makeSharpFactory([Promise.resolve(Buffer.alloc(512 * 1024 + 1))]);
    const convert = createForgeIconConverter({ loadSharp: () => fake.sharp });

    await expect(convert('/tmp/large.png')).rejects.toThrow('转换结果必须在');
  });
});
