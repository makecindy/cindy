/**
 * nodeRuntimeVirtualStdin.test — 虚拟 stdin 装载的两条路径。
 *
 * Windows 上 Electron(lib/common/init.ts)把 process.stdin 钉成
 * configurable: false 的 getter,返回一条创建时即 EOF 的假 Readable;
 * 直接 defineProperty 会抛 "Cannot redefine property: stdin"。这里用
 * 同形状的假体验证原地复活路径,防 Node 升级悄悄改掉 _readableState
 * 的 bitfield setter 行为。
 */

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { installVirtualStdin } from '../nodeRuntimeVirtualStdin';

type ProcessLike = Pick<NodeJS.Process, 'stdin'>;

async function collectUntilEnd(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => stream.on('end', resolve));
  return Buffer.concat(chunks);
}

describe('installVirtualStdin', () => {
  it('stdin 可配置时整体替换,喂入的字节按序可读', async () => {
    const proc = {} as ProcessLike;
    const sink = installVirtualStdin(proc);
    const stream = proc.stdin as unknown as Readable;
    expect(stream).toBeInstanceOf(Readable);

    const done = collectUntilEnd(stream);
    sink.feed('{"jsonrpc":"2.0"}\n');
    sink.feed(Buffer.from('第二行\n', 'utf8'));
    sink.end();
    expect((await done).toString('utf8')).toBe('{"jsonrpc":"2.0"}\n第二行\n');
  });

  it('stdin 被钉成不可配置 EOF 流时原地复活(Electron win32 形状)', async () => {
    // 复刻 Electron common/init 的 win32 行为:EOF Readable + 不可配置 getter。
    const stub = new Readable();
    stub.push(null);
    // 让 EOF 引发的 nextTick 排水先跑完,贴近真实装载时机。
    await new Promise((resolve) => setImmediate(resolve));

    const proc = {} as ProcessLike;
    Object.defineProperty(proc, 'stdin', {
      configurable: false,
      enumerable: true,
      get: () => stub,
    });

    const sink = installVirtualStdin(proc);
    // 属性无法重定义,插件读到的必须仍是同一个对象。
    expect(proc.stdin as unknown).toBe(stub);

    const done = collectUntilEnd(stub);
    sink.feed('hello ');
    sink.feed(Buffer.from('world'));
    sink.end();
    expect((await done).toString('utf8')).toBe('hello world');
  });

  it('stdin 不可重定义且形状不符时抛错,不让插件读到静默 EOF', () => {
    const proc = {} as ProcessLike;
    Object.defineProperty(proc, 'stdin', {
      configurable: false,
      enumerable: true,
      get: () => 42,
    });
    expect(() => installVirtualStdin(proc)).toThrow(/stdin/);
  });
});
