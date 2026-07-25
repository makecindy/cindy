/**
 * nodeRuntimeVirtualStdin — 把 process.stdin 接管为宿主可喂字节的虚拟流。
 *
 * macOS / Linux:Node 自身把 stdin 定义为可配置属性,直接整体替换成 PassThrough。
 * Windows:Electron 的 lib/common/init.ts 在 win32 把 process.stdin 钉成
 * configurable: false 的 getter,返回一条创建时即压入 EOF 的假 Readable
 * (browser / utility 进程一律如此),此时 defineProperty 会抛
 * "Cannot redefine property: stdin"。属性无法重定义,唯一出路是把这条假流
 * 原地复活:清掉 EOF 标志、补上空 _read,之后按 Readable.push 喂字节——
 * 插件从 process.stdin 读到的仍是同一个对象,require('node:process') 一致。
 * 复活依赖 _readableState.ended 的 setter(Node 22 / 24 的 bitfield 属性
 * 描述符均提供);复活失败时抛错让 worker 明确退出,不让插件读到静默 EOF。
 */

import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

export interface VirtualStdinSink {
  /** 宿主送来的插件方向字节从这里写入。 */
  feed(chunk: string | Buffer): void;
  /** 宿主宣布 stdin 结束。 */
  end(): void;
}

type StdinStub = Readable & {
  _read?: (size: number) => void;
  _readableState?: { ended?: boolean; endEmitted?: boolean };
};

export function installVirtualStdin(proc: Pick<NodeJS.Process, 'stdin'>): VirtualStdinSink {
  const descriptor = Object.getOwnPropertyDescriptor(proc, 'stdin');
  if (!descriptor || descriptor.configurable) {
    const virtual = new PassThrough();
    Object.defineProperty(proc, 'stdin', {
      configurable: true,
      enumerable: true,
      value: virtual,
    });
    return {
      feed(chunk) {
        virtual.write(chunk);
      },
      end() {
        virtual.end();
      },
    };
  }
  const stub = proc.stdin as unknown as StdinStub;
  const state = stub?._readableState;
  if (!state || typeof stub.push !== 'function' || state.endEmitted) {
    throw new Error('process.stdin 不可重定义且流形状不符合预期,虚拟 stdin 装载失败');
  }
  stub._read = () => {};
  state.ended = false;
  if (state.ended !== false) {
    throw new Error('process.stdin 的 EOF 标志清除失败,虚拟 stdin 装载失败');
  }
  return {
    feed(chunk) {
      stub.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    },
    end() {
      stub.push(null);
    },
  };
}
