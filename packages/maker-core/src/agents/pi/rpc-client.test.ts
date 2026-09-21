import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { PiRpcProcess, createPiStdioTransport } from './rpc-client.js';

function makeStream() {
  return new EventEmitter();
}

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function createProcess(onProcessSpawned?: (pid: number) => void | (() => void)) {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const transport = createPiStdioTransport({
    binaryPath: '/pi',
    args: ['--mode', 'rpc'],
    cwd: '/work',
    env: {},
    logger,
    onProcessSpawned,
  });
  return new PiRpcProcess({
    transport,
    logger,
    onEvent: vi.fn(),
    onExit: vi.fn(),
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('PiRpcProcess frame diagnostics (#3696)', () => {
  function createProcessWithMocks() {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const transport = createPiStdioTransport({
      binaryPath: '/pi',
      args: ['--mode', 'rpc'],
      cwd: '/work',
      env: {},
      logger,
    });
    const onEvent = vi.fn();
    const proc = new PiRpcProcess({ transport, logger, onEvent, onExit: vi.fn() });
    const feed = (frame: Record<string, unknown>): void => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
    };
    return { proc, logger, onEvent, feed };
  }

  it('logs message_end frame metadata (block types + char counts) without message content', () => {
    const { logger, onEvent, feed } = createProcessWithMocks();
    feed({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: '思考中' },
          { type: 'text', text: 'hello world' },
        ],
      },
    });

    expect(logger.info).toHaveBeenCalledWith('pi rpc message_end frame', {
      role: 'assistant',
      stopReason: 'stop',
      blockTypes: ['thinking', 'text'],
      textChars: 'hello world'.length,
      thinkingChars: '思考中'.length,
    });
    // 事件仍照常透传,诊断不改变协议行为。
    expect(onEvent).toHaveBeenCalledTimes(1);
    // 隐私:任何日志载荷里不得出现消息正文。
    const serializedLogs = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.debug.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('hello world');
    expect(serializedLogs).not.toContain('思考中');
  });

  it('flushes an unsettled turn histogram at the next agent_start (no cross-turn bleed)', () => {
    const { logger, feed } = createProcessWithMocks();
    // 第一轮:abort 类结束,收不到 agent_settled。
    feed({ type: 'agent_start' });
    feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
    // 第二轮开始:先冲刷上一轮直方图并清零。
    feed({ type: 'agent_start' });
    expect(logger.info).toHaveBeenCalledWith('pi rpc turn frame histogram (no agent_settled)', {
      frames: { agent_start: 1, message_update: 1 },
    });
    feed({ type: 'agent_settled' });
    // 第二轮直方图不含第一轮的 message_update 计数。
    expect(logger.info).toHaveBeenCalledWith('pi rpc turn frame histogram', {
      frames: { agent_start: 1, agent_settled: 1 },
    });
  });

  it('normalizes non-identifier labels to (other) so hostile fields never reach logs', () => {
    const { logger, feed } = createProcessWithMocks();
    const smuggled = 'secret token value with spaces';
    feed({
      type: smuggled,
    });
    feed({
      type: 'message_end',
      message: {
        role: smuggled,
        stopReason: smuggled,
        content: [{ type: smuggled, text: 'x' }],
      },
    });
    feed({ type: 'agent_settled' });
    expect(logger.info).toHaveBeenCalledWith('pi rpc message_end frame', {
      role: '(other)',
      stopReason: '(other)',
      blockTypes: ['(other)'],
      textChars: 0,
      thinkingChars: 0,
    });
    const serializedLogs = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(serializedLogs).not.toContain(smuggled);
    // 直方图键同样被归一化。
    expect(logger.info).toHaveBeenCalledWith('pi rpc turn frame histogram', {
      frames: { '(other)': 1, message_end: 1, agent_settled: 1 },
    });
  });

  it('logs a per-turn frame histogram at agent_settled and resets counts', () => {
    const { logger, feed } = createProcessWithMocks();
    feed({ type: 'agent_start' });
    feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
    feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
    feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    feed({ type: 'agent_settled' });

    expect(logger.info).toHaveBeenCalledWith('pi rpc turn frame histogram', {
      frames: {
        agent_start: 1,
        message_update: 2,
        message_end: 1,
        agent_settled: 1,
      },
    });

    logger.info.mockClear();
    feed({ type: 'agent_start' });
    feed({ type: 'agent_settled' });
    // 第二轮直方图不包含第一轮计数(settled 后已清零)。
    expect(logger.info).toHaveBeenCalledWith('pi rpc turn frame histogram', {
      frames: { agent_start: 1, agent_settled: 1 },
    });
  });
});

describe('PiRpcProcess process observer', () => {
  it('registers the concrete PID and disposes that generation once on close', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const onProcessSpawned = vi.fn(() => dispose);

    createProcess(onProcessSpawned);
    expect(onProcessSpawned).toHaveBeenCalledWith(4321);

    child.emit('close', 0, null);
    child.emit('close', 0, null);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('observer failure does not block process startup', () => {
    mocks.spawn.mockReturnValue(makeChild());
    expect(() =>
      createProcess(() => {
        throw new Error('observer failed');
      }),
    ).not.toThrow();
  });
});

describe('PiRpcProcess startup failure diagnostics (#4625)', () => {
  it('preserves extension failure and native recovery hint when startup exits', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const proc = createProcess();
    const rejected = expect(proc.request({ type: 'get_state' })).rejects.toThrow(
      'Failed to load extension "placeholder"\nHint: Start without extensions using "pi -ne".',
    );
    child.stderr.emit('data', Buffer.from('Error: Failed to load extension "placeholder"\n'));
    child.stderr.emit('data', Buffer.from('Hint: Start without extensions using "pi -ne".\n'));
    child.emit('close', 1, null);
    await rejected;
    await expect(proc.request({ type: 'get_state' })).rejects.toThrow('Failed to load extension');
  });

  it('retains startup diagnostics if exit precedes the first request', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const proc = createProcess();
    child.stderr.emit('data', Buffer.from('Cannot find module placeholder\n'));
    child.emit('close', 1, null);
    await expect(proc.request({ type: 'get_state' })).rejects.toThrow(
      'pi process exited (code=1, signal=null)\nPi startup stderr:\nCannot find module placeholder',
    );
  });

  it('redacts complete stderr lines before bounding the diagnostic tail', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const proc = createProcess();
    const error = proc.request({ type: 'get_state' }).catch((err: Error) => err);
    child.stderr.emit('data', Buffer.from('obsolete warning\n'));
    child.stderr.emit('data', Buffer.from(`sessionToken=${'a'.repeat(4000)}\n`));
    child.stderr.emit('data', Buffer.from(`${'x'.repeat(4000)}\n`));
    // Split a synthetic credential across byte chunks, not logical stderr lines.
    child.stderr.emit('data', Buffer.from('Error: Failed to load extension; api_key=sk-ant-'));
    child.stderr.emit('data', Buffer.from('FAKEONLY0123456789\n'));
    child.emit('close', 1, null);
    const result = await error as Error;
    expect(result.message).toContain('Failed to load extension');
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('FAKEONLY');
    expect(result.message).not.toContain('aaaa');
    expect(result.message).not.toContain('obsolete warning');
    expect(result.message.length).toBeLessThan(2200);
  });

  it('does not attach old startup warnings or running stderr after a valid RPC response', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const proc = createProcess();
    child.stderr.emit('data', Buffer.from('startup warning\n'));
    const ready = proc.request({ type: 'get_state' });
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response', id: 'c1', command: 'get_state', success: true, data: {},
    }) + '\n'));
    await ready;
    const rejected = expect(proc.request({ type: 'get_state' })).rejects.toThrow(
      /^pi process exited \(code=1, signal=null\)$/,
    );
    child.stderr.emit('data', Buffer.from('running warning with unrelated content\n'));
    child.emit('close', 1, null);
    await rejected;
  });

  it('redacts raw transport diagnostics including headers and quoted secrets', async () => {
    let stderr!: (line: string) => void;
    let exit!: (info: { code: number | null; signal: NodeJS.Signals | null; reason: string }) => void;
    const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
      error: vi.fn(), fatal: vi.fn(), child: vi.fn() };
    const proc = new PiRpcProcess({
      transport: {
        pid: undefined, isClosed: () => false, close: async () => {},
        writeLine: async () => {}, onLine: () => () => {},
        onStderr: (handler) => { stderr = handler; return () => {}; },
        onClose: (handler) => { exit = handler; return () => {}; },
      }, logger, onEvent: vi.fn(), onExit: vi.fn(),
    });
    const error = proc.request({ type: 'get_state' }).catch((err: Error) => err);
    stderr('Error: Failed to load extension placeholder');
    stderr('Cannot find module "/Users/fake user/private-project/node_modules/placeholder"');
    stderr(String.raw`from 'C:\Users\fake user\private-project\pi.exe'`);
    stderr('from /Users/fake user/private-project/pi.exe');
    stderr('/Users/alice/acme,secret/[private](one)/node_modules/bad.js: no such file');
    stderr(String.raw`C:\Users\alice\acme,secret\[private](one)\bad.js: permission denied`);
    stderr('/config.json: no such file');
    stderr('    at internalLoader (/private/build/internal.ts:123:4)');
    stderr('Authorization: Basic FAKEBASE64VALUE');
    stderr('password="fake spaced password"');
    stderr('sessionToken=FAKECUSTOMOPAQUEVALUE');
    exit({ code: 1, signal: null, reason: 'unused raw transport reason' });
    const result = await error as Error;
    expect(result.message).toContain('Failed to load extension placeholder');
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('FAKE');
    expect(result.message).not.toContain('fake spaced password');
    expect(result.message).toContain('<path:placeholder>');
    expect(result.message).toContain('<path:pi.exe>');
    expect(result.message).not.toContain('fake user');
    expect(result.message).not.toContain('private-project');
    expect(result.message).not.toContain('internalLoader');
    expect(result.message).not.toContain('acme');
    expect(result.message).not.toContain('secret/');
    expect(result.message).not.toContain('[private]');
    expect(result.message).toContain('<path:bad.js>: no such file');
    expect(result.message).toContain('<path:bad.js>: permission denied');
    expect(result.message).toContain('<path:config.json>: no such file');
  });

  it('keeps the generic fallback for a fresh process with no stderr', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const proc = createProcess();
    const rejected = expect(proc.request({ type: 'get_state' })).rejects.toThrow(
      /^pi process exited \(code=1, signal=null\)$/,
    );
    child.emit('close', 1, null);
    await rejected;
  });
});
