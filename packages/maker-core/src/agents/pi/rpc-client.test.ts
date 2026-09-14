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
