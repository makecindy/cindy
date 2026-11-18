import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EventEmitter } from 'node:events';
import { spawn as spawnNative, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import spawn from 'cross-spawn';
import { killProcessTree } from '../../scheduler-host/proc-util.js';
import { AppConnection } from '../connection.js';
import { AppStdioTransport, stdioAppEnvironment } from '../stdioTransport.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
vi.mock('../windowsStdioLaunch.js', () => ({
  prepareWindowsStdioLaunch: vi.fn(async () => ({ command: 'job.exe', args: [] })),
}));
vi.mock('../../scheduler-host/proc-util.js', () => ({ killProcessTree: vi.fn() }));

afterEach(() => vi.restoreAllMocks());
const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };

describe('MCP App connection recovery', () => {
  it('observes the SDK initialize-failure close while reporting failed process cleanup to the owner', async () => {
    vi.spyOn(AppStdioTransport.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(AppStdioTransport.prototype, 'send').mockImplementation(async function (this: AppStdioTransport, message) {
      if ('id' in message) queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id!,
        error: { code: -32603, message: 'fixture initialize rejected' } }));
    });
    vi.spyOn(AppStdioTransport.prototype, 'close').mockRejectedValue(new Error('MCP_STDIO_CLOSE_FAILED'));
    const current = new AppConnection({ id: 'stdio', transport: 'stdio', command: 'fixture', args: [], env: {} });
    await expect(current.getClient()).rejects.toThrow('MCP_STDIO_CLOSE_FAILED');
    await new Promise(resolve => setImmediate(resolve));
    // The actual SDK calls void this.close() on the initialize error. Vitest
    // reports the discarded rejection if the owning Client doesn't observe it.
    expect(current.isClosed).toBe(true);
    await expect(current.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
  });

  // Stdio adds owned processes: initialization failure and repeated teardown
  // must settle the same owned transport, unlike the existing HTTP-only cases.
  it('closes a stdio transport after failed initialization and rejects reuse after release', async () => {
    vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('MCP_STDIO_START_FAILED'));
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const close = vi.spyOn(AppStdioTransport.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection({ id: 'stdio', transport: 'stdio', command: 'fixture', args: [], env: {} });
    await expect(connection.getClient()).rejects.toThrow('MCP_STDIO_START_FAILED');
    expect(close).toHaveBeenCalledOnce();
    await Promise.all([connection.close(), connection.close()]);
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
  });

  // Unit regression: a transient transport close failure must remain visible but
  // not permanently poison the owner's later explicit cleanup. Existing tests
  // only repeated successful closes; one failed close then a receipt is enough.
  it('retries failed stdio cleanup without reopening the connection', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const close = vi.spyOn(AppStdioTransport.prototype, 'close')
      .mockRejectedValueOnce(new Error('MCP_STDIO_CLOSE_FAILED')).mockResolvedValue(undefined);
    const connection = new AppConnection({ id: 'stdio', transport: 'stdio', command: 'fixture', args: [], env: {} });
    await connection.getClient();
    await expect(connection.close()).rejects.toThrow('MCP_STDIO_CLOSE_FAILED');
    await expect(connection.close()).resolves.toBeUndefined();
    await expect(connection.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
  });

  it('inherits execution basics without leaking unrelated host secrets and respects explicit Windows PATH', async () => {
    const env = await stdioAppEnvironment({ Path: 'selected-path', TOKEN: 'invalid-selected-token' },
      { Path: 'host-path', SystemRoot: 'system-root', CINDY_TOKEN: 'invalid-host-token', HTTPS_PROXY: 'invalid-secret-proxy' }, 'win32', 'unused');
    expect(env).toEqual({ PATH: 'selected-path', SYSTEMROOT: 'system-root', TOKEN: 'invalid-selected-token' });
  });

  it('retries a failed connection only for a later independent request', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    await expect(connection.getClient()).rejects.toThrow('offline');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.isClosed).toBe(false);
    const [first, second] = await Promise.all([connection.getClient(), connection.getClient()]);
    expect(first).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    await connection.close();
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not replay an in-flight tool when the transport closes, or retire its replacement', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    const first = await connection.getClient();
    const call = vi.spyOn(first, 'callTool').mockImplementation(async () => {
      first.onclose?.();
      throw new Error('connection lost after send');
    });
    await expect(first.callTool({ name: 'submit' })).rejects.toThrow('connection lost');
    expect(call).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    const second = await connection.getClient();
    expect(second).not.toBe(first);
    first.onclose?.();
    expect(await connection.getClient()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledOnce();
    await connection.close();
  });

  it('never revives a connection closed while initialization was pending', async () => {
    let finish!: () => void;
    vi.spyOn(Client.prototype, 'connect').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const connection = new AppConnection(config);
    const pending = connection.getClient();
    await connection.close();
    finish();
    await expect(pending).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
    await expect(connection.getClient()).rejects.toThrow('MCP_APP_CONNECTION_CLOSED');
  });
});

describe('stdio tree-close receipt', () => {
  function childFixture(pid: number) {
    const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), stdout: new EventEmitter() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    });
    return child;
  }
  // macOS real-process fixture: kill(-pgid, 0) can report EPERM for one poll
  // while the last member exits, then ESRCH. Permission denial alone cannot
  // establish either a successful close or a permanent failure (unit, fake time).
  it.each([true, false])('requires a POSIX exit receipt after permission denial (transient=%s)', async transient => {
    const child = childFixture(42_004);
    let probes = 0;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('group exiting'), { code: ++probes > 1 && transient ? 'ESRCH' : 'EPERM' });
      return true;
    });
    const kill = vi.mocked(killProcessTree).mockReset().mockImplementation((_pid, _child, callback) => callback!(false));
    vi.mocked(child.stdin!.end).mockImplementation(() => {
      child.exitCode = 0; child.emit('exit'); child.emit('close');
      return child.stdin!;
    });
    const transport = new AppStdioTransport({ command: 'fixture', args: [], cwd: os.tmpdir(), env: { PATH: 'fixture-path' } }, 'darwin');
    await transport.start();
    vi.useFakeTimers();
    try {
      const closing = transport.close().then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(transient ? 20 : 1_000);
      if (transient) {
        expect(await closing).toBeUndefined();
        expect(kill).not.toHaveBeenCalled();
      } else expect(await closing).toEqual(new Error('MCP_STDIO_CLOSE_FAILED'));
    } finally { vi.useRealTimers(); }
  });

  // Unit regression: the group can disappear between the final TERM poll and
  // the KILL attempt. A negative kill receipt is not failure if ESRCH proves
  // that group is already gone; previous cases only covered immediate receipts.
  it('confirms a POSIX group that exits just before the force-kill attempt', async () => {
    const child = childFixture(42_003);
    let forceAttempted = false;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && forceAttempted) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      return true;
    });
    vi.mocked(killProcessTree).mockReset().mockImplementation((_pid, _child, callback) => {
      forceAttempted = true; callback!(false);
    });
    vi.mocked(child.stdin!.end).mockImplementation(() => {
      child.exitCode = 0; child.emit('exit'); child.emit('close');
      return child.stdin!;
    });
    const transport = new AppStdioTransport({ command: 'fixture', args: [], cwd: os.tmpdir(), env: { PATH: 'fixture-path' } }, 'darwin');
    await transport.start();
    vi.useFakeTimers();
    try {
      const closing = transport.close().then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      expect(await closing).toBeUndefined();
      expect(forceAttempted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  function windowsJob(receipt?: string) {
    const child = Object.assign(childFixture(42_002), { stderr: new PassThrough(), kill: vi.fn() });
    const spawned = Promise.withResolvers<void>();
    vi.mocked(spawnNative).mockImplementationOnce(() => {
      if (receipt !== undefined) queueMicrotask(() => child.stderr.end(receipt));
      spawned.resolve();
      return child as unknown as ChildProcess;
    });
    const transport = new AppStdioTransport({ command: 'fixture.exe', args: [], cwd: os.tmpdir(), env: {} }, 'win32');
    return { transport, child, spawned: spawned.promise };
  }

  // The supervisor's receipt covers the job after the launcher has exited.
  // An unconfirmed exit must remain visible to callers, including on retry.
  it.each([0, 3])('closes stdin and waits for the Windows job receipt (%s)', async code => {
    const { transport, child } = windowsJob('READY\n');
    await transport.start();
    const closing = transport.close();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    child.emit('close', code);
    if (code === 0) await closing;
    else {
      await expect(closing).rejects.toThrow('MCP_STDIO_CLOSE_FAILED');
      await expect(transport.close()).rejects.toThrow('MCP_STDIO_CLOSE_FAILED');
    }
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports a missing Windows tool without confusing startup failure with cleanup failure', async () => {
    const { transport, child } = windowsJob('NOT_FOUND\n');
    await expect(transport.start()).rejects.toThrow('MCP_STDIO_COMMAND_NOT_FOUND');
    child.emit('close', 2);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('bounds startup when a Windows supervisor never confirms that it launched the tool', async () => {
    const { transport, child, spawned } = windowsJob();
    vi.useFakeTimers();
    try {
      const starting = expect(transport.start()).rejects.toThrow('MCP_STDIO_START_FAILED');
      await spawned;
      await vi.advanceTimersByTimeAsync(30_000);
      await starting;
      child.emit('close', 2);
      await transport.close();
    } finally { vi.useRealTimers(); }
  });

  it('bounds an unresponsive Windows job and accepts a later confirmed close', async () => {
    const { transport, child } = windowsJob('READY\n');
    await transport.start();
    vi.useFakeTimers();
    try {
      const closing = expect(transport.close()).rejects.toThrow('MCP_STDIO_CLOSE_FAILED');
      await vi.advanceTimersByTimeAsync(3_000);
      await closing;
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit('close', 0);
      await expect(transport.close()).resolves.toBeUndefined();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe.each(['http', 'sse'] as const)('MCP App %s discovery cancellation', (transport) => {
  it('does not establish an authenticated connection for an already cancelled request', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const connection = new AppConnection({ ...config, transport });
    const cancelled = new AbortController();
    const reason = new Error('discovery cancelled before connect');
    cancelled.abort(reason);
    try {
      await expect(connection.tools(cancelled.signal)).rejects.toBe(reason);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each([false, true])('cancels one initialization waiter without cancelling its peer (reconnect=%s)', async (reconnect) => {
    let finish!: () => void;
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const connection = new AppConnection({ ...config, transport });
    if (reconnect) (await connection.getClient()).onclose?.();
    connect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancelled = new AbortController();
    const reason = new Error('discovery cancelled during connect');
    const pending = connection.tools(cancelled.signal);
    const peer = connection.tools();
    try {
      const settled = pending.then(() => 'resolved', (error: unknown) => error);
      cancelled.abort(reason);
      // Initialization deliberately stays pending: no wall-clock timeout can mask it.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(await Promise.race([settled, Promise.resolve('still waiting')])).toBe(reason);
      expect(list).not.toHaveBeenCalled();
      finish();
      await expect(peer).resolves.toEqual([]);
      expect(list).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(reconnect ? 2 : 1);
      await expect(connection.tools()).resolves.toEqual([]);
      expect(connect).toHaveBeenCalledTimes(reconnect ? 2 : 1);
    } finally {
      finish();
      await Promise.allSettled([pending, peer]);
      await connection.close();
    }
  });
});
