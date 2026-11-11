import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createInterface: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:readline', () => ({ createInterface: mocks.createInterface }));

import { createStdioTransport } from './stdioTransport.js';
import { AppServerHost, CodexNativeInitializationStoppedError } from './host.js';
import type { Logger } from '../../../interfaces/logger.js';

function makeEmitterStream() {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stream.setEncoding = vi.fn();
  return stream;
}

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: ReturnType<typeof makeEmitterStream>;
    stderr: ReturnType<typeof makeEmitterStream>;
    stdin: EventEmitter & {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = makeEmitterStream();
  child.stderr = makeEmitterStream();
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn((_line, _encoding, callback: (error?: Error) => void) => {
      callback();
      return true;
    }),
    end: vi.fn(),
  });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
  const readline = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  readline.close = vi.fn();
  mocks.createInterface.mockReset().mockReturnValue(readline);
  mocks.spawn.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('createStdioTransport process observer', () => {
  it.each(['exit', 'pending', 'stdout', 'signal', 'other-error', 'different-path'])('classifies only a confirmed pre-protocol SQLite exit (%s)', (scenario) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: 'codex' });
    const error = scenario === 'other-error' ? 'Error: failed to load configuration: revoked'
      : `Error: failed to initialize sqlite state runtime under /synthetic: failed to initialize state runtime at ${scenario === 'different-path' ? '/other' : '/synthetic'}`;
    child.stderr.emit('data', `${error}\n`);
    if (scenario === 'stdout') child.stdout.emit('data', '{}');
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(false);
    if (scenario !== 'pending') {
      child.emit('exit', 1, scenario === 'signal' ? 'SIGTERM' : null);
      expect(transport.nativeSqliteInitializationFailed?.()).toBe(false);
      child.emit('close', 1, scenario === 'signal' ? 'SIGTERM' : null);
    }
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(scenario === 'exit');
  });
  it.each(['/synthetic/db', String.raw`C:\synthetic\db`])('drains split fatal output after physical exit (%s)', async (home) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const disposed = vi.fn();
    const transport = createStdioTransport({ binaryPath: 'codex', onProcessSpawned: () => disposed });
    const closed = vi.fn();
    const stderr = vi.fn();
    transport.onClose(closed);
    transport.onStderr?.(stderr);
    child.stderr.emit('data', `diagnostic\r\nError: failed to initialize sqlite state runtime under ${home}: failed to initialize state runtime at `);
    child.emit('exit', 1, null);
    expect(disposed).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(mocks.createInterface.mock.results[0]!.value.close).not.toHaveBeenCalled();
    child.stderr.emit('data', home + '\r'); // No final newline.
    child.emit('close', 1, null);
    expect(stderr).toHaveBeenLastCalledWith(`Error: failed to initialize sqlite state runtime under ${home}: failed to initialize state runtime at ${home}`);
    expect(closed).toHaveBeenCalledOnce();
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(true);
    await transport.close('strict cleanup');
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stdout', 'cancel', 'drain-timeout'])('refuses recovery when %s arrives between exit and drain', async (scenario) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: 'codex', outputDrainMs: 25 });
    const closed = vi.fn();
    transport.onClose(closed);
    child.stderr.emit('data', 'Error: failed to initialize sqlite state runtime under /x: failed to initialize state runtime at /x');
    child.emit('exit', 1, null);
    expect(closed).not.toHaveBeenCalled();
    if (scenario === 'stdout') child.stdout.emit('data', '{}');
    if (scenario === 'cancel') await transport.close('initialize timeout / cancellation');
    if (scenario === 'drain-timeout') await vi.advanceTimersByTimeAsync(25);
    child.emit('close', 1, null);
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(false);
    expect(closed).toHaveBeenCalledOnce();
    await transport.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels recovery when the drained stderr callback closes synchronously', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: 'codex' });
    transport.onStderr?.(() => { void transport.close('callback cancelled startup'); });
    const closed = vi.fn();
    transport.onClose(closed);
    child.stderr.emit('data', 'Error: failed to initialize sqlite state runtime under /x: failed to initialize state runtime at /x');
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    expect(transport.nativeSqliteInitializationFailed?.()).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith({ reason: 'callback cancelled startup' });
    await transport.close();
  });

  it('starts the app-server without a visible Windows console', () => {
    mocks.spawn.mockReturnValue(makeChild());

    createStdioTransport({ binaryPath: '/codex', cwd: '/workspace' });

    expect(mocks.spawn).toHaveBeenCalledWith(
      '/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: '/workspace',
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it('close 先 EOF，真正退出前保持进程登记和 stdout 排空，并发调用共享完成', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const onProcessSpawned = vi.fn(() => dispose);
    const transport = createStdioTransport({ binaryPath: '/codex', onProcessSpawned });

    expect(onProcessSpawned).toHaveBeenCalledWith(4321);
    const onClose = vi.fn();
    const onLine = vi.fn();
    transport.onClose(onClose);
    transport.onLine(onLine);
    const closing = transport.close();
    expect(transport.close()).toBe(closing);
    const settled = vi.fn();
    void closing.then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    const readline = mocks.createInterface.mock.results[0]!.value;
    expect(readline.close).not.toHaveBeenCalled();
    readline.emit('line', 'late response');
    expect(onLine).not.toHaveBeenCalled();
    await expect(transport.writeLine('new request')).rejects.toThrow('after close');
    child.emit('exit', 0, null);
    await closing;
    expect(onClose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(readline.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('自然退出时清理；随后 close 不重复清理', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const transport = createStdioTransport({
      binaryPath: '/codex',
      onProcessSpawned: () => dispose,
    });

    child.emit('exit', 0, null);
    await transport.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('观察器抛错不影响 transport 启动', () => {
    mocks.spawn.mockReturnValue(makeChild());
    expect(() => createStdioTransport({
      binaryPath: '/codex',
      onProcessSpawned: () => {
        throw new Error('observer failed');
      },
    })).not.toThrow();
  });
});

describe('production stdio initialization recovery', () => {
  it.each(['recover', 'exhaust', 'timeout'])('keeps drain classification and the three-process budget on %s', async (scenario) => {
    const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
    const children: ReturnType<typeof makeChild>[] = [];
    const readers: EventEmitter[] = [];
    const requests: string[][] = [];
    mocks.createInterface.mockImplementation(() => {
      const reader = Object.assign(new EventEmitter(), { close: vi.fn() });
      readers.push(reader); return reader;
    });
    mocks.spawn.mockImplementation(() => {
      const child = makeChild(4321 + children.length);
      const index = children.length;
      children.push(child); requests.push([]);
      child.stdin.end.mockImplementation(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
      child.stdin.write.mockImplementation((line: string, _encoding: string, done: () => void) => {
        const rpc = JSON.parse(line);
        if (rpc.method) requests[index].push(rpc.method);
        queueMicrotask(() => {
          if (index === 2 && scenario === 'recover') {
            if (rpc.id != null) readers[index].emit('line', JSON.stringify({ id: rpc.id, result: {} }));
          } else if (rpc.method === 'initialize') {
            child.stderr.emit('data', 'Error: failed to initialize sqlite state runtime under /x: failed to initialize state runtime at ');
            child.emit('exit', 1, null);
            // Late pipes: timeout must revoke retry eligibility before close.
            setTimeout(() => { child.stderr.emit('data', '/x'); child.emit('close', 1, null); }, 20);
          }
        });
        done(); return true;
      });
      return child;
    });
    const host = new AppServerHost({ logger, clientInfo: { name: 'test', version: '0' },
      createTransport: () => createStdioTransport({ binaryPath: 'codex' }),
    });
    const started = scenario === 'timeout' ? host.ensureStartedWithTimeout(10, 'test') : host.ensureStarted();
    const result = scenario === 'recover' ? expect(started).resolves.toBeDefined()
      : scenario === 'exhaust' ? expect(started).rejects.toBeInstanceOf(CodexNativeInitializationStoppedError)
        : expect(started).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(children).toHaveLength(scenario === 'timeout' ? 1 : 3);
    if (scenario === 'recover') {
      await host.request('thread/start');
      children[0].emit('exit', 1, null); children[0].emit('close', 1, null);
      expect(host.hasStarted).toBe(true);
      expect(requests).toEqual([['initialize'], ['initialize'], ['initialize', 'thread/start']]);
    } else expect(requests.every(methods => methods.every(method => method === 'initialize'))).toBe(true);
    await host.retire();
  });
});

describe('close() 强杀兜底 (#3699)', () => {
  it('SIGTERM 后进程未退出 → 宽限期到点补 SIGKILL(卡死 app-server 不再活体泄漏)', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      const closing = transport.close();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // 进程无视 SIGTERM(exitCode/signalCode 保持 null)→ 宽限期后强杀。
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('exit', null, 'SIGKILL');
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期内正常退出 → 不发 SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      const closing = transport.close();
      await vi.advanceTimersByTimeAsync(1_500);
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      await closing;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledTimes(1); // 仅 SIGTERM
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() 前已退出 → 全程不发信号', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      child.exitCode = 0;
      child.emit('exit', 0, null);
      await transport.close();
      vi.advanceTimersByTime(5_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('发送信号失败且无法确认退出时拒绝关闭，不冒充已释放进程', async () => {
    const child = makeChild();
    child.kill.mockImplementation(() => { throw new Error('kill denied'); });
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const transport = createStdioTransport({ binaryPath: '/codex', onProcessSpawned: () => dispose });
    const closing = transport.close();
    const failure = expect(closing).rejects.toThrow('did not exit after SIGKILL');
    await vi.advanceTimersByTimeAsync(3_000);
    await failure;
    await expect(transport.close()).rejects.toThrow('did not exit after SIGKILL');
    expect(dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    child.emit('exit', null, 'SIGKILL');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();
    // 迟到退出只改变后续检查，不能把原调用的严格失败变成成功。
    await expect(closing).rejects.toThrow('did not exit after SIGKILL');
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stdin 错误不冒充进程退出，仍执行 EOF 和强杀收尾', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: '/codex' });
    child.stdin.emit('error', new Error('EPIPE'));
    const closing = transport.close();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await closing;
  });

  it('spawn 失败没有子进程，不等待或发送信号', async () => {
    const child = makeChild();
    Object.assign(child, { pid: undefined });
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: '/missing-codex' });
    child.emit('error', new Error('ENOENT'));
    await transport.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onClose 同步重入也不会提前完成或重复关闭', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const transport = createStdioTransport({ binaryPath: '/codex' });
    let reentered: Promise<void> | undefined;
    transport.onClose(() => { reentered = transport.close(); });
    const closing = transport.close();
    expect(reentered).toBe(closing);
    await vi.advanceTimersByTimeAsync(1);
    child.emit('exit', 0, null);
    await closing;
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});
