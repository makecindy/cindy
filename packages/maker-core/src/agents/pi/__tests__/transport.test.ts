/**
 * PiTransport 单元测试(轮 25 F1:transport.ts 此前零直测)。
 *
 * 覆盖:
 *   - createPiStdioTransport:spawn 参数、onClose 单次、close() 幂等竞态
 *     (轮 21 H-1)、SIGTERM→SIGKILL 升级、writeLine 关闭后拒绝、stderr 缓冲
 *   - attachJsonlReader:跨 chunk UTF-8、尾部 flush、OOM 守卫(轮 21 H-3)、
 *     CRLF strip、error 事件不崩(轮 21 M-1)
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import {
  attachJsonlReader,
  createPiStdioTransport,
  type PiTransport,
} from '../transport.js';

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function makeTransport(): { transport: PiTransport; child: ReturnType<typeof makeChild> } {
  const child = makeChild();
  mocks.spawn.mockReturnValue(child);
  const transport = createPiStdioTransport({
    binaryPath: '/pi',
    args: ['--mode', 'rpc'],
    cwd: '/work',
    env: {},
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } } as never,
  });
  return { transport, child };
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('createPiStdioTransport', () => {
  it('spawns pi with --mode rpc and piped stdio', () => {
    makeTransport();
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/pi',
      ['--mode', 'rpc'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('close() is idempotent under concurrency (round 21 H-1 — no twin SIGTERM/SIGKILL)', async () => {
    const { transport, child } = makeTransport();
    // 并发两个 close:closed 标志须同步置位, 第二次直接 return。
    const p1 = transport.close();
    const p2 = transport.close();
    // mock child 不自动退出 —— close 内部 SIGTERM 后等 'close' 事件, 补发。
    setImmediate(() => child.emit('close', null, null));
    await Promise.all([p1, p2]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(transport.isClosed()).toBe(true);
  });

  // 轮 40-w4-t16 HIGH-2(测试盲区):close() 进行中(child 尚未真正退出)的窗口,
  // writeLine 必须立即 reject 且不再写 stdin —— 否则 teardown 期间尾包写入
  // 已关闭连接, 协议污染。
  it('rejects writeLine during in-flight close, before child exits (round 40-w4-t16)', async () => {
    const { transport, child } = makeTransport();
    // close 开始但不触发 child close(窗口保持)。
    const closePromise = transport.close();
    // 窗口内写入:立即 reject, 且 child.stdin 未被写入。
    await expect(transport.writeLine('{"x":1}')).rejects.toThrow(/closed/);
    expect(child.stdin.write).not.toHaveBeenCalled();
    // 收口:触发 child close 让 close() 完成。
    child.emit('close', null, null);
    await closePromise;
  });

  it('escalates to SIGKILL after grace period (round 21 H-1 semantics)', async () => {
    vi.useFakeTimers();
    try {
      const { transport, child } = makeTransport();
      // child 不响应 SIGTERM(不 emit close)
      const closePromise = transport.close();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      // 补发 close 让 promise 结束
      child.emit('close', null, null);
      await closePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() resolves even if child never confirms exit after SIGKILL (round 40-w4-t3 HIGH — no hang)', async () => {
    vi.useFakeTimers();
    try {
      const { transport, child } = makeTransport();
      // child 不响应任何信号:不 emit close, kill 是 no-op。
      child.kill.mockImplementation(() => true);
      const onClose = vi.fn();
      transport.onClose(onClose);

      const closePromise = transport.close();
      // SIGTERM 宽限期(3s)→ SIGKILL
      await vi.advanceTimersByTimeAsync(3_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      // SIGKILL 确认窗口(5s)超时 → close() 必须 resolve(不再永久挂住)
      await vi.advanceTimersByTimeAsync(5_000);
      await closePromise;
      // 主动 close 语义:onClose 收到通知
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(transport.isClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writeLine rejects when closed', async () => {
    const { transport, child } = makeTransport();
    child.emit('close', 0, null);
    await expect(transport.writeLine('{"x":1}')).rejects.toThrow(/closed/);
  });

  it('onClose fires exactly once (child close + explicit close race)', async () => {
    const { transport, child } = makeTransport();
    const handler = vi.fn();
    transport.onClose(handler);
    // child 自然退出触发 onClose
    child.emit('close', 0, null);
    // 再显式 close —— 不重复触发
    await transport.close();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.isClosed()).toBe(true);
  });

  it('explicit close() still notifies onClose (round 40-w1 MEDIUM-2 — closed-before-notify regression)', async () => {
    const { transport, child } = makeTransport();
    const handler = vi.fn();
    transport.onClose(handler);
    // 显式 close:child 不先 emit close(主动 kill 场景), close() 必须补发通知。
    const p = transport.close();
    setImmediate(() => child.emit('close', null, null));
    await p;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.isClosed()).toBe(true);
    // 通知后 writeLine 拒绝
    await expect(transport.writeLine('{"x":1}')).rejects.toThrow(/closed/);
  });

  it('buffers stderr until first handler registers, then drains', () => {
    const { transport, child } = makeTransport();
    child.stderr.emit('data', Buffer.from('line1\n'));
    child.stderr.emit('data', Buffer.from('line2\n'));
    const handler = vi.fn();
    transport.onStderr?.(handler);
    // drain:历史行喂给第一个 handler
    expect(handler).toHaveBeenCalledWith('line1');
    expect(handler).toHaveBeenCalledWith('line2');
  });
});

describe('attachJsonlReader', () => {
  function makeStream() {
    return new EventEmitter() as EventEmitter & { pipe(): void };
  }

  it('splits lines across chunk boundaries (UTF-8 safe)', () => {
    const stream = makeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));
    // 中文 3 字节被拆到两个 chunk
    const buf = Buffer.from('{"m":"你好"}\n{"m":"x"}\n', 'utf8');
    stream.emit('data', buf.subarray(0, 8));
    stream.emit('data', buf.subarray(8));
    expect(lines).toEqual(['{"m":"你好"}', '{"m":"x"}']);
  });

  it('flushes remaining buffer on end (no trailing newline)', () => {
    const stream = makeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));
    stream.emit('data', '{"a":1}');
    stream.emit('end');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('strips trailing CR (CRLF tolerance)', () => {
    const stream = makeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));
    stream.emit('data', '{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('discards buffer over OOM guard (round 21 H-3)', () => {
    const stream = makeStream();
    const lines: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachJsonlReader(stream, (l) => lines.push(l));
    // 超 16MB 无换行的流
    const big = 'a'.repeat(16 * 1024 * 1024 + 100);
    stream.emit('data', big);
    // 缓冲被丢弃, 后续合法行不受影响
    stream.emit('data', '{"ok":1}\n');
    expect(lines).toEqual(['{"ok":1}']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not crash on stream error (round 21 M-1)', () => {
    const stream = makeStream();
    attachJsonlReader(stream, () => {});
    expect(() => stream.emit('error', new Error('boom'))).not.toThrow();
  });
});
