/**
 * pre-run-hook-child 门面测试:桌面端 utilityProcess 的 ChildProcess 适配层。
 *
 * 覆盖 #11149 的真实边界 —— 子进程已经退出,但 stdio 两条管道不再派发 `end`
 * (Electron utilityProcess 在 Windows 上没写过 stderr 时的表现),此时
 * `executePreRunHook` 只认 `close`,包装层必须自己把管道读干后收敛,否则整轮
 * 前置检查会等满 10s 超时并 fail-closed 阻断任务;而收敛又不能早于尾部输出到达,
 * 否则 `CINDY_PRECHECK_OK` / 诊断行会被丢掉。
 *
 * 全部用假 worker + 假时钟驱动,不启动 Electron、不落文件、无真实等待。
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { adaptPreRunHookWorker, type PreRunHookWorker } from '../pre-run-hook-child';

class FakeWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: string[] = [];
  pid = 4242;
  killed = false;
  readonly stdin = { write: (chunk: string): boolean => { this.sent.push(chunk); return true; } };
  sendControl(message: unknown): boolean { this.sent.push(JSON.stringify(message)); return true; }
  kill(): boolean { this.killed = true; return true; }
}

function worker(): FakeWorker {
  return new FakeWorker();
}

function fakeWorker(fake: FakeWorker): PreRunHookWorker {
  return fake as unknown as PreRunHookWorker;
}

function onceClose(child: ChildProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => {
    child.once('close', (code: number | null, signal: string | null) => resolve([code, signal]));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('adaptPreRunHookWorker close 收敛', () => {
  it('exit 之后两流不再派发 end → 静默窗口到点即按退出码发 close', async () => {
    vi.useFakeTimers();
    const fake = worker();
    const child = adaptPreRunHookWorker(fakeWorker(fake));
    let closed = false;
    const closedAt = onceClose(child).then(([code, signal]) => { closed = true; return [code, signal]; });

    fake.emit('spawn');
    fake.emit('exit', 2, null);

    // 前置检查的超时判定是 10s;门面必须在百毫秒级收敛,不能等满。
    await vi.advanceTimersByTimeAsync(120);
    expect(closed).toBe(true);
    expect(await closedAt).toEqual([2, null]);
  });

  it('两流 end + exit 都到齐时立即发 close,不再等排空窗口', async () => {
    vi.useFakeTimers();
    const fake = worker();
    const child = adaptPreRunHookWorker(fakeWorker(fake));
    const closes: Array<number | null> = [];
    child.on('close', (code: number | null) => { closes.push(code); });

    fake.stdout.emit('end');
    fake.stderr.emit('end');
    fake.emit('exit', 0, null);

    expect(closes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(closes).toEqual([0]);
  });

  it('尾部输出晚于 exit 才到达时先读完再发 close', async () => {
    vi.useFakeTimers();
    const fake = worker();
    const child = adaptPreRunHookWorker(fakeWorker(fake));
    const chunks: string[] = [];
    (child.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer | string) => {
      chunks.push(String(chunk));
    });
    let onClose: string[] = [];
    child.on('close', () => { onClose = [...chunks]; });

    fake.emit('spawn');
    fake.emit('exit', 2, null);
    // 报告里那条结论与诊断行就在 exit 之后才从管道读到的这一段。
    await vi.advanceTimersByTimeAsync(60);
    fake.stdout.write('Only 18/20 human messages in the last day; review skipped.\nCINDY_PRECHECK_DONE\n');

    // 60ms < 静默窗口,数据到达后窗口重新计时,close 还不该来。
    expect(onClose).toEqual([]);
    await vi.advanceTimersByTimeAsync(120);
    expect(onClose.join('')).toContain('CINDY_PRECHECK_DONE');
  });

  it('长时间无输出后才 exit 时,静默窗口仍从 exit 起算', async () => {
    vi.useFakeTimers();
    const fake = worker();
    const child = adaptPreRunHookWorker(fakeWorker(fake));
    const chunks: string[] = [];
    (child.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer | string) => {
      chunks.push(String(chunk));
    });
    let onClose: string[] = [];
    child.on('close', () => { onClose = [...chunks]; });

    fake.emit('spawn');
    // 只在结束时打标记的检查:构造后 5s 内没有任何输出。
    await vi.advanceTimersByTimeAsync(5_000);
    fake.emit('exit', 0, null);
    // 排空窗口不能被「构造至今已静默 5s」提前判死。
    expect(onClose).toEqual([]);

    await vi.advanceTimersByTimeAsync(60);
    fake.stdout.write('CINDY_PRECHECK_OK\n');
    expect(onClose).toEqual([]);

    await vi.advanceTimersByTimeAsync(120);
    expect(onClose.join('')).toContain('CINDY_PRECHECK_OK');
  });

  it('worker 不提供 once 时仍靠排空窗口收敛', async () => {
    vi.useFakeTimers();
    // 生产 worker 一定有 once；这里用最小能力实现（只有 on('data')），证明接口把 once 声明为
    // 可选项不是靠强转绕过，而是真的降级到「退出后的排空窗口」。
    const minimal = Object.assign(new EventEmitter(), {
      pid: 4243,
      killed: false,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      stdin: { write: () => true },
      sendControl: () => true,
      kill: () => true,
    });
    const child = adaptPreRunHookWorker(minimal as unknown as PreRunHookWorker);
    const closed = onceClose(child);

    minimal.emit('exit', 2, null);
    await vi.advanceTimersByTimeAsync(120);
    expect(await closed).toEqual([2, null]);
  });

  it('两流在 exit 之后才 end 时不会重复收敛', async () => {
    vi.useFakeTimers();
    const fake = worker();
    const child = adaptPreRunHookWorker(fakeWorker(fake));
    let closes = 0;
    child.on('close', () => { closes += 1; });

    fake.emit('spawn');
    fake.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(120);
    expect(closes).toBe(1);

    fake.stdout.emit('end');
    fake.stderr.emit('end');
    await vi.advanceTimersByTimeAsync(120);
    expect(closes).toBe(1);
  });
});
