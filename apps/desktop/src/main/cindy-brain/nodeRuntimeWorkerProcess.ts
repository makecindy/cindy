/**
 * nodeRuntimeWorkerProcess — 随包 Node 插件的 Electron utilityProcess 入口。
 *
 * 正式包关闭 Electron RunAsNode fuse，不能靠 ELECTRON_RUN_AS_NODE 启动脚本。
 * 本入口由 utilityProcess.fork 以 Cindy 自带的 Node service process 运行：
 * main 通过 parentPort 送入 stdio 字节，本入口把它写进一条只存在于子进程内的
 * stdin；插件仍按逐行 JSON-RPC/MCP stdio 编写，stdout/stderr 则由 main 直接接管。
 *
 * 双模式(2026-07-23,宿主代启子进程):
 * - 普通 worker 模式(argv = [entryPath]):行为同旧版,另在加载插件前往
 *   全局挂 __CINDY_NODE__.spawnEntry 窄接口——worker 可请求宿主代启一个
 *   **已申报入口**的子进程,拿回形似 ChildProcess 的把手(stdio 流/kill/exit)。
 *   控制帧走本引导层私藏的 parentPort,插件代码摸不到通道本身;能不能生、
 *   生谁、生几个全在主机侧守门(broker),这里只是电话机。
 * - 子进程原样模式(argv = [entryPath, CHILD_FLAG, ...args]):不挂接口、
 *   不受逐行 JSON 检查(主机只做字节中继);把 process.argv 伪装成
 *   [node, entryPath, ...args],让 Maker 这类库以为自己被 node 正常启动。
 *
 * 插件代码拥有当前系统用户级本机权限。这里提供的是进程隔离与通信收口,不是
 * OS 沙箱；能力在插件详情中披露，运行期由 Main 按 manifest 严格守门。
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { GhostNodeChildToWorkerMessage } from '../../shared/ghost.js';
import { GHOST_NODE_CHILD_MODE_FLAG } from '../../shared/ghost.js';
import { installVirtualStdin } from './nodeRuntimeVirtualStdin.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const entryPath = process.argv[2];
const childMode = process.argv[3] === GHOST_NODE_CHILD_MODE_FLAG;
const childArgs = childMode ? process.argv.slice(4) : [];

if (!parentPort) throw new Error('Node 插件工作进程缺少 parentPort');
if (
  typeof entryPath !== 'string' ||
  !path.isAbsolute(entryPath) ||
  !/\.(?:c?js)$/.test(entryPath)
) {
  throw new Error('Node 插件工作进程入口不合法');
}

// Windows 上 Electron 把 process.stdin 钉成不可配置 getter,不能整体替换;
// 替换或原地复活的分支收敛在 installVirtualStdin 里。
const virtualStdin = installVirtualStdin(process);

/* ── spawnEntry 窄接口(仅普通 worker 模式;子进程模式不给,树深恒为 1)── */

interface ChildHandleInternal {
  stdout: PassThrough;
  stderr: PassThrough;
  events: EventEmitter;
  exited: boolean;
}

const childHandles = new Map<string, ChildHandleInternal>();
const pendingSpawns = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
>();
let nextSpawnReq = 1;

/** 主机 → worker 的子进程控制帧分发(形状不合的静默忽略)。 */
function handleChildControlMessage(m: GhostNodeChildToWorkerMessage): void {
  if (m.type === 'spawn-child-result') {
    const pending = pendingSpawns.get(m.reqId);
    if (!pending) return;
    pendingSpawns.delete(m.reqId);
    clearTimeout(pending.timer);
    if (!m.ok) {
      pending.reject(new Error(m.message));
      return;
    }
    const internal: ChildHandleInternal = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      events: new EventEmitter(),
      exited: false,
    };
    childHandles.set(m.childId, internal);
    const childId = m.childId;
    // 形似 child_process.ChildProcess 的窄把手:够 Maker 垫片改道用,
    // 不冒充完整实现(spawnfile/channel 等一概没有)。
    const handle = {
      pid: m.pid,
      stdout: internal.stdout,
      stderr: internal.stderr,
      stdin: {
        write(chunk: string | Uint8Array): boolean {
          if (internal.exited) return false;
          parentPort!.postMessage({
            type: 'child-stdin',
            childId,
            b64: Buffer.from(chunk as Uint8Array).toString('base64'),
          });
          return true;
        },
        end(): void {
          if (internal.exited) return;
          parentPort!.postMessage({ type: 'child-stdin-end', childId });
        },
      },
      get killed() {
        return internal.exited;
      },
      kill(): boolean {
        if (internal.exited) return false;
        parentPort!.postMessage({ type: 'child-kill', childId });
        return true;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        internal.events.on(event, listener);
        return handle;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        internal.events.once(event, listener);
        return handle;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        internal.events.off(event, listener);
        return handle;
      },
    };
    pending.resolve(handle);
    return;
  }
  const internal = childHandles.get(m.childId);
  if (!internal) return;
  if (m.type === 'child-stdout') {
    internal.stdout.write(Buffer.from(m.b64, 'base64'));
  } else if (m.type === 'child-stderr') {
    internal.stderr.write(Buffer.from(m.b64, 'base64'));
  } else if (m.type === 'child-exit') {
    childHandles.delete(m.childId);
    internal.exited = true;
    internal.stdout.end();
    internal.stderr.end();
    // exit 与 close 都发:child_process 消费方两个事件名都常见。
    internal.events.emit('exit', m.code, null);
    internal.events.emit('close', m.code, null);
  }
}

/**
 * 请求宿主代启一个已申报入口的子进程。能不能生(childSpawn 开关/入口申报/
 * 数量顶)全由主机裁决,这里只发申请并在 15 秒内等答复。
 */
function spawnEntry(entry: string, args?: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = `r${nextSpawnReq++}`;
    const timer = setTimeout(() => {
      pendingSpawns.delete(reqId);
      reject(new Error('spawnEntry 等待宿主答复超时'));
    }, 15_000);
    timer.unref?.();
    pendingSpawns.set(reqId, { resolve, reject, timer });
    parentPort!.postMessage({
      type: 'spawn-child',
      reqId,
      entry,
      ...(args !== undefined ? { args } : {}),
    });
  });
}

/* ── parentPort 分发与就绪握手 ─────────────────────────────────────── */

parentPort.on('message', (event) => {
  const data = event.data;
  if (!isRecord(data)) return;
  if (data.type === 'stdin' && typeof data.chunk === 'string') {
    if (Buffer.byteLength(data.chunk, 'utf8') <= 1024 * 1024) virtualStdin.feed(data.chunk);
    return;
  }
  // 子进程原样模式的字节口(base64,防多字节字符被 chunk 边界切坏)。
  if (data.type === 'stdin-b64' && typeof data.chunk === 'string') {
    if (data.chunk.length <= 2 * 1024 * 1024) virtualStdin.feed(Buffer.from(data.chunk, 'base64'));
    return;
  }
  if (data.type === 'stdin-end') {
    virtualStdin.end();
    return;
  }
  if (!childMode && typeof data.type === 'string' && data.type.startsWith('child-')) {
    handleChildControlMessage(data as GhostNodeChildToWorkerMessage);
    return;
  }
  if (!childMode && data.type === 'spawn-child-result') {
    handleChildControlMessage(data as unknown as GhostNodeChildToWorkerMessage);
  }
});

// 主机只等这条固定就绪消息;普通模式下引导层继续私用 parentPort 走子进程
// 控制帧,但随后把公开引用从 process 上拿掉——插件代码的正式通信面只剩
// stdin/stdout/stderr 与 __CINDY_NODE__ 窄接口。
parentPort.postMessage({ type: 'ready' });
try {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
  });
} catch {
  // 部分 Electron 版本可能不允许重定义；main 侧只认形状合法的控制帧。
}

if (childMode) {
  // 原样模式:把 argv 伪装成 [node, entryPath, ...args],库按普通 node 进程
  // 的认知读参数;不暴露 spawnEntry(树深恒为 1,子进程不能再生孙进程)。
  process.argv = [process.argv[0], entryPath, ...childArgs];
} else {
  // 普通模式 argv 保持旧形状([electron, 引导层, entryPath]),存量插件零变化。
  Object.defineProperty(globalThis, '__CINDY_NODE__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ spawnEntry }),
  });
}

const requireFromWorker = createRequire(__filename);
requireFromWorker(entryPath);
