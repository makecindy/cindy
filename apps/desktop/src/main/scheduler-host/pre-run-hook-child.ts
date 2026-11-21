import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * `cindy-node-script` 前置检查的进程门面:把桌面端 utilityProcess 包装出来的 worker
 * 适配成 `executePreRunHook` 认识的 ChildProcess 形状。
 *
 * 这里是纯事件/流适配,不 import electron——让「包装层能否结算」有可以直接驱动的单测
 * (#11149: 该收敛逻辑此前只活在 `.desktop.ts` 里,单测跑在纯 Node 环境,永远走不到)。
 */
export interface PreRunHookWorkerStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  /** 生产 worker 一定提供;缺失时只靠退出后的有界窗口收敛。 */
  once?(event: 'end', listener: () => void): unknown;
}

export interface PreRunHookWorker {
  readonly pid?: number;
  readonly killed?: boolean;
  readonly stdout: PreRunHookWorkerStream;
  readonly stderr: PreRunHookWorkerStream;
  stdin: { write(chunk: string): boolean };
  sendControl?(message: unknown): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** exit 之后排空管道的静默窗口:每收到一块尾部输出就在这个窗口上重新计时。 */
const EXIT_DRAIN_IDLE_MS = 100;
/** 排空窗口的总上限:管道一直有输出也不能无限拖住本轮前置检查。 */
const EXIT_DRAIN_MAX_MS = 1_000;

/** 前置检查脚本的 stdin:等 worker 就绪再写,写失败交给调用方回调,不吞成未处理异常。 */
function createStdin(worker: PreRunHookWorker): Writable {
  let ready = false;
  const waiting: Array<() => void> = [];
  const whenReady = (fn: () => void): void => { if (ready) fn(); else waiting.push(fn); };
  worker.once('spawn', () => { ready = true; for (const fn of waiting.splice(0)) fn(); });
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      whenReady(() => {
        try { worker.stdin.write(chunk.toString('base64')); callback(); }
        catch (error) { callback(error as Error); }
      });
    },
    final(callback) {
      whenReady(() => { worker.sendControl?.({ type: 'stdin-end' }); callback(); });
    },
  });
}

export function adaptPreRunHookWorker(worker: PreRunHookWorker): ChildProcess {
  const events = new EventEmitter();
  const stdin = createStdin(worker);
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let exited = false;
  let closed = false;
  let streams = 2;
  let lastOutputAt = Date.now();
  const emitClose = (): void => {
    if (closed) return;
    closed = true;
    events.emit('close', exitCode, signalCode);
  };
  const close = (): void => { if (exited && streams === 0) emitClose(); };
  for (const stream of [worker.stdout, worker.stderr]) {
    // 主路径仍是「两流都 end + exit」;once 缺失时退到退出后的排空窗口。
    stream.once?.('end', () => { streams--; close(); });
    // 只观测「最近一次有输出」的时刻,不消费数据:executePreRunHook 自己挂着 data 监听。
    stream.on('data', () => { lastOutputAt = Date.now(); });
  }
  worker.on('error', (error) => {
    stdin.destroy(error instanceof Error ? error : new Error(String(error)));
    events.emit('error', error);
  });
  /**
   * exit 已到但两流还没 end:继续把管道读干,直到连续 EXIT_DRAIN_IDLE_MS 没有新输出,
   * 或抵达 EXIT_DRAIN_MAX_MS 上限,再发 close。Electron utilityProcess 在 Windows 上若
   * 子进程没写过 stderr,管道可能始终不派发 `end`,只等 end 会让前置检查等满 10s 超时
   * 再 fail-closed(#11149);但也不能在 exit 当下或单个 tick 内关门,尾部结论
   * (`CINDY_PRECHECK_OK` / 诊断行 / stderr 原因)常晚于 exit 一到两轮 I/O 才读到。
   */
  const drainAfterExit = (): void => {
    // 静默窗口从 **exit 时刻**开始:脚本可能跑了很久且最后一次输出早于 100ms 前
    // (只在结束时打标记的检查很常见),用构造时的 lastOutputAt 会让第一次 check 直接收敛,
    // 把排队中的尾部 stdout 丢在 close 之后。
    const exitAt = Date.now();
    const deadline = exitAt + EXIT_DRAIN_MAX_MS;
    const check = (): void => {
      if (closed) return;
      const idleLeft = EXIT_DRAIN_IDLE_MS - (Date.now() - Math.max(lastOutputAt, exitAt));
      const hardLeft = deadline - Date.now();
      if (idleLeft <= 0 || hardLeft <= 0) { emitClose(); return; }
      setTimeout(check, Math.min(idleLeft, hardLeft)).unref?.();
    };
    check();
  };
  worker.on('exit', (code: number | null, signal: string | null) => {
    exitCode = code; signalCode = signal; exited = true;
    events.emit('exit', code, signal);
    if (streams === 0) { emitClose(); return; }
    drainAfterExit();
  });
  Object.defineProperties(events, {
    pid: { get: () => worker.pid },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
    killed: { get: () => worker.killed },
  });
  return Object.assign(events, {
    stdin,
    stdout: worker.stdout,
    stderr: worker.stderr,
    kill: (signal?: NodeJS.Signals) => worker.kill(signal),
  }) as unknown as ChildProcess;
}
