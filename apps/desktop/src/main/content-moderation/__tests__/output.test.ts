import type { AgentEvent } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamModerationClient, StreamModerationCallbacks } from '../streamClient.js';

const {
  getModerationIdentity,
  isModerationIdentityCurrent,
} = vi.hoisted(() => ({
  getModerationIdentity: vi.fn(),
  isModerationIdentityCurrent: vi.fn(),
}));

vi.mock('../identity.js', () => ({
  getModerationIdentity,
  isModerationIdentityCurrent,
}));

import { OutputModerationGate } from '../output.js';
import { CONTENT_MODERATION_BLOCKED_MESSAGE } from '../constants.js';

function text(value: string, isFinal = false): AgentEvent {
  return { type: 'text', data: { text: value, isFinal }, source: 'codex' };
}

function done(result: string): AgentEvent {
  return { type: 'done', data: { result }, source: 'codex' };
}

function status(isRunning: boolean): AgentEvent {
  return { type: 'status', data: { isRunning }, source: 'codex' };
}

function fakeStreamFactory() {
  let callbacks: StreamModerationCallbacks | null = null;
  let nextSequence = 0;
  const stream = {
    push: vi.fn(() => nextSequence++),
    finish: vi.fn(),
    cancel: vi.fn(),
  } as unknown as StreamModerationClient;
  const createStream = vi.fn(async (_input, cb: StreamModerationCallbacks) => {
    callbacks = cb;
    return stream;
  });
  return {
    createStream,
    stream,
    callbacks: () => {
      if (!callbacks) throw new Error('stream callbacks not installed');
      return callbacks;
    },
  };
}

async function flushStartup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('OutputModerationGate', () => {
  beforeEach(() => {
    getModerationIdentity.mockReturnValue({
      membershipId: 'member-1',
      accessToken: 'token',
      identityEpoch: 1,
      signBaseUrl: 'https://sign.example.invalid',
      environment: 'test',
    });
    isModerationIdentityCurrent.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('只向下游释放连续安全正文，并把终态挡到 task.completed', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('raw'));
    gate.handle(text('raw', true));
    gate.handle(status(false));
    gate.handle(done('raw-unreviewed-result'));
    await flushStartup();

    expect(factory.stream.push).toHaveBeenCalledTimes(1);
    expect(factory.stream.finish).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);

    factory.callbacks().onRelease({ sequence: 0, text: 'safe' });
    expect(delivered.map((event) => event.type)).toEqual(['text', 'text']);
    expect(delivered.map((event) => (event.data as { text?: string }).text)).toEqual([
      'safe',
      'safe',
    ]);

    factory.callbacks().onCompleted();
    expect(delivered.map((event) => event.type)).toEqual([
      'text',
      'text',
      'status',
      'done',
    ]);
    expect((delivered.at(-1)?.data as { result?: string }).result).toBe('safe');
  });

  it('content.block 丢弃未 release 正文，发临时信号并用安全结果收尾', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const abortTurn = vi.fn(async () => undefined);
    const onBlocked = vi.fn();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn,
      onBlocked,
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('first'));
    gate.handle(text('blocked'));
    await flushStartup();
    factory.callbacks().onRelease({ sequence: 0, text: 'first-safe' });
    factory.callbacks().onBlock();

    expect(delivered.map((event) => event.type)).toEqual(['text', 'done']);
    expect((delivered[1]?.data as { result?: string }).result).toBe(
      `first-safe\n\n${CONTENT_MODERATION_BLOCKED_MESSAGE}`,
    );
    expect(JSON.stringify(delivered)).not.toContain('blocked');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(abortTurn).toHaveBeenCalledTimes(1);

    gate.handle(text('late-abort-text'));
    gate.handle(done('late-raw-result'));
    expect(JSON.stringify(delivered)).not.toContain('late');
  });

  it('content.block 在零安全输出时持久化阻断说明', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('blocked-before-release'));
    await flushStartup();
    factory.callbacks().onBlock();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('done');
    expect(delivered[0]?.data).toMatchObject({
      result: CONTENT_MODERATION_BLOCKED_MESSAGE,
      contentModerationBlocked: true,
    });
    expect(JSON.stringify(delivered)).not.toContain('blocked-before-release');
  });

  it('task.failed 是明确失败终态，不走 fail-open', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const onFailed = vi.fn();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed,
      createStream: factory.createStream,
    });

    gate.handle(text('raw'));
    await flushStartup();
    factory.callbacks().onFailed();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('error');
    expect(delivered[0]?.data).toMatchObject({
      reason: 'turn-failed',
      contentModerationFailed: true,
      isTerminal: true,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('用户停止时保留已 release 文本、丢弃缓冲，并用安全 done 收口', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('safe-raw'));
    gate.handle(text('pending-raw'));
    await flushStartup();
    factory.callbacks().onRelease({ sequence: 0, text: 'safe' });
    gate.cancel();
    gate.handle({
      type: 'error',
      data: { message: 'aborted', isTerminal: true },
      source: 'codex',
    });

    expect(delivered.map((event) => event.type)).toEqual(['text', 'done']);
    expect((delivered[1]?.data as { result?: string }).result).toBe('safe');
    expect(JSON.stringify(delivered)).not.toContain('pending-raw');
  });

  it('创建链路超过 5 秒时 fail-open，且 done.result 使用已直出的正文', async () => {
    vi.useFakeTimers();
    const delivered: AgentEvent[] = [];
    let resolveCreate: (value: StreamModerationClient | null) => void = () => undefined;
    const createStream = vi.fn(() => new Promise<StreamModerationClient | null>((resolve) => {
      resolveCreate = resolve;
    }));
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream,
    });

    gate.handle(text('raw'));
    gate.handle(done('unreviewed-result'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(delivered.map((event) => event.type)).toEqual(['text', 'done']);
    expect((delivered[1]?.data as { result?: string }).result).toBe('raw');
    resolveCreate(null);
    await flushStartup();
  });

  it('无审核资格时完全透传，不创建流任务', () => {
    getModerationIdentity.mockReturnValue(null);
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('plain'));
    gate.handle(done('plain'));
    expect(delivered.map((event) => event.type)).toEqual(['text', 'done']);
    expect(factory.createStream).not.toHaveBeenCalled();
  });

  it('取消后的 status:false 不会吞掉随后用于持久化收口的 done', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('raw'));
    await flushStartup();
    factory.callbacks().onRelease({ sequence: 0, text: 'safe' });
    gate.cancel();
    gate.handle(status(false));
    gate.handle(done('raw'));

    expect(delivered.map((event) => event.type)).toEqual(['text', 'status', 'done']);
    expect((delivered.at(-1)?.data as { result?: string }).result).toBe('safe');
  });

  it('已在终态事件上完成 fail-open 后会 reset，下一 turn 重新审核', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('raw'));
    gate.handle(done('raw'));
    await flushStartup();
    factory.callbacks().onRelease({ sequence: 0, text: 'raw' });
    factory.callbacks().onFailOpen();

    gate.handle(status(true));
    await flushStartup();
    expect(factory.createStream).toHaveBeenCalledTimes(2);
  });

  it('turn 启动状态即绑定审核身份，尚无正文时也可被账号切换取消', async () => {
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: vi.fn(),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(status(true));
    await flushStartup();
    expect(gate.cancel()).toBe(true);
    expect(factory.stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('空的 final text 不创建无意义审核任务', () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('', true));
    expect(delivered).toHaveLength(1);
    expect(factory.createStream).not.toHaveBeenCalled();
  });

  it('interaction boundary waits only for output queued before it', async () => {
    const delivered: AgentEvent[] = [];
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('before'));
    await flushStartup();
    let boundaryReleased = false;
    const boundary = gate.waitForReleaseBoundary().then(() => {
      boundaryReleased = true;
    });
    gate.handle(text('after'));

    factory.callbacks().onRelease({ sequence: 0, text: 'safe-before' });
    await boundary;

    expect(boundaryReleased).toBe(true);
    expect(delivered).toHaveLength(1);
    expect((delivered[0]?.data as { text?: string }).text).toBe('safe-before');
    expect(JSON.stringify(delivered)).not.toContain('after');
  });

  it('interaction boundary queued during startup preserves event order', async () => {
    const delivered: AgentEvent[] = [];
    let callbacks: StreamModerationCallbacks | null = null;
    let resolveCreate: (stream: StreamModerationClient) => void = () => undefined;
    const stream = {
      push: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      finish: vi.fn(),
      cancel: vi.fn(),
    } as unknown as StreamModerationClient;
    const createStream = vi.fn((_input, cb: StreamModerationCallbacks) => {
      callbacks = cb;
      return new Promise<StreamModerationClient>((resolve) => {
        resolveCreate = resolve;
      });
    });
    const installedCallbacks = (): StreamModerationCallbacks => {
      if (!callbacks) throw new Error('stream callbacks not installed');
      return callbacks;
    };
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: (event) => delivered.push(event),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream,
    });

    gate.handle(text('before'));
    let boundaryReleased = false;
    const boundary = gate.waitForReleaseBoundary().then(() => {
      boundaryReleased = true;
    });
    gate.handle(text('after'));
    resolveCreate(stream);
    await flushStartup();

    expect(boundaryReleased).toBe(false);
    installedCallbacks().onRelease({ sequence: 0, text: 'safe-before' });
    await boundary;

    expect(boundaryReleased).toBe(true);
    expect(delivered).toHaveLength(1);
    expect((delivered[0]?.data as { text?: string }).text).toBe('safe-before');
  });

  it('terminal moderation outcomes release pending interaction boundaries', async () => {
    const factory = fakeStreamFactory();
    const gate = new OutputModerationGate({
      sessionId: 'session-1',
      deliver: vi.fn(),
      abortTurn: vi.fn(async () => undefined),
      onBlocked: vi.fn(),
      onFailed: vi.fn(),
      createStream: factory.createStream,
    });

    gate.handle(text('pending'));
    await flushStartup();
    const boundary = gate.waitForReleaseBoundary();
    factory.callbacks().onBlock();

    await expect(boundary).resolves.toBeUndefined();
  });
});
