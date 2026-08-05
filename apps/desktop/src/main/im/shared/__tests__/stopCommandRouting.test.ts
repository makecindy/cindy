/**
 * `!stop` 控制指令路由回归(issue #867)。
 *
 * 断言 messageHandler 把 `!stop` 从普通消息流里分流出来:
 *   - 命中 → turnRunner.stopActiveTurn(不进 runAgentTurn / slash / 不入队)
 *   - 回复 stopDone / stopIdle
 *   - 带附件 / 非精确匹配的文本不受影响, 照常走 agent turn
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelIM, IMAttachment, IMMessageEvent } from '@cindy/im';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
}));

// slashCommands 模块运行时依赖 maker-host / localDb 等重模块 — messageHandler
// 只用到 looksLikeSlashCommand 这个纯函数, 整模块 mock 掉避免拖进 electron 依赖。
vi.mock('../slashCommands', () => ({
  looksLikeSlashCommand: (text: string) => text.startsWith('/'),
}));

import { createMessageHandler, isStopCommand } from '../messageHandler';
import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  waitForImAccountGenerationIdle,
} from '../../accountBoundary';
import type { ImSlashHandlers } from '../slashCommands';
import type { ImTurnRunner } from '../turnRunner';
import type { ImChannelAdapter } from '../types';
import { ui as slackUi } from './threadUiFixture';

function makeEvent(overrides: Partial<IMMessageEvent> = {}): IMMessageEvent {
  return {
    channelName: 'slack',
    senderId: 'U123456789',
    chatId: 'D123456789',
    contextId: 'bot-ctx',
    messageId: 'msg-1',
    text: '!stop',
    attachments: [],
    unsupported: [],
    scopeKey: '1234.5678',
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('isStopCommand', () => {
  it('matches half/full-width exclamation and any letter case, ignoring surrounding spaces', () => {
    expect(isStopCommand('!stop')).toBe(true);
    expect(isStopCommand('!STOP')).toBe(true);
    expect(isStopCommand('  !Stop  ')).toBe(true);
    expect(isStopCommand('！stop')).toBe(true);
    expect(isStopCommand('！STOP')).toBe(true);
  });

  it('rejects anything that is not exactly the stop command', () => {
    expect(isStopCommand('stop')).toBe(false);
    expect(isStopCommand('!stops')).toBe(false);
    expect(isStopCommand('!stop now')).toBe(false);
    expect(isStopCommand('please !stop')).toBe(false);
    expect(isStopCommand('')).toBe(false);
  });
});

describe('messageHandler !stop routing', () => {
  let stopActiveTurn: ReturnType<typeof vi.fn>;
  let runAgentTurn: ReturnType<typeof vi.fn>;
  let handleSlashCommand: ReturnType<typeof vi.fn>;
  let sendMarkdownText: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let deliver: (event: IMMessageEvent) => void;

  function wire(threadScoped: boolean): void {
    stopActiveTurn = vi.fn(async () => ({ stopped: true, droppedQueued: 0 }));
    runAgentTurn = vi.fn(async () => undefined);
    handleSlashCommand = vi.fn(async () => true);
    sendMarkdownText = vi.fn(async () => undefined);
    sendText = vi.fn(async () => undefined);

    const im = {
      onMessage(handler: (event: IMMessageEvent) => void) {
        deliver = handler;
        return () => undefined;
      },
      sendMarkdownText,
      sendText,
    } as unknown as ChannelIM;

    const adapter = {
      channel: 'slack',
      im,
      ui: slackUi,
      threadScoped,
    } as unknown as ImChannelAdapter;

    const attach = createMessageHandler(
      adapter,
      { handleSlashCommand } as unknown as ImSlashHandlers,
      { stopActiveTurn, runAgentTurn } as unknown as ImTurnRunner,
    );
    attach(im);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activateImAccountBoundary();
    wire(true);
  });

  it('silently drops messages delivered after logout closes the account boundary', async () => {
    deactivateImAccountBoundary();
    deliver(makeEvent({ text: 'after logout' }));
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(sendMarkdownText).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('drops an old-account message that was queued before logout and relogin', async () => {
    const firstTurn = deferred();
    runAgentTurn.mockImplementationOnce(async () => firstTurn.promise);

    deliver(makeEvent({ messageId: 'old-1', text: 'first old message' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deliver(makeEvent({ messageId: 'old-2', text: 'queued old message' }));

    deactivateImAccountBoundary();
    activateImAccountBoundary();
    firstTurn.resolve();
    await vi.waitFor(() =>
      expect(mocks.logger.info).toHaveBeenCalledWith(
        'drop inbound message from stale account generation channel=slack',
      ),
    );

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps an already-started message turn inside the closing account scope', async () => {
    const turn = deferred();
    runAgentTurn.mockImplementationOnce(async () => turn.promise);
    const accountGeneration = captureImAccountGeneration();
    expect(accountGeneration).not.toBeNull();

    deliver(makeEvent({ messageId: 'old-running', text: 'in-flight old message' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deactivateImAccountBoundary();

    let drained = false;
    const draining = waitForImAccountGenerationIdle(accountGeneration!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    turn.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('keeps detached turn background work inside the closing account scope', async () => {
    const background = deferred();
    runAgentTurn.mockImplementationOnce(
      async (args: Parameters<ImTurnRunner['runAgentTurn']>[0]) => {
        args.trackBackgroundTask?.(() => background.promise);
      },
    );
    const accountGeneration = captureImAccountGeneration();
    expect(accountGeneration).not.toBeNull();

    deliver(makeEvent({ messageId: 'old-title', text: 'generate a title' }));
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    deactivateImAccountBoundary();

    let drained = false;
    const draining = waitForImAccountGenerationIdle(accountGeneration!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    background.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('routes !stop to stopActiveTurn with the thread scopeKey and replies stopDone', async () => {
    deliver(makeEvent());
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledTimes(1);
    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-ctx',
      userId: 'U123456789',
      scopeKey: '1234.5678',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(0), {
      threadTs: '1234.5678',
    });
  });

  it('mentions dropped queued messages in the stopDone reply', async () => {
    stopActiveTurn.mockResolvedValue({ stopped: true, droppedQueued: 2 });
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopDone(2), {
      threadTs: '1234.5678',
    });
  });

  it('replies stopIdle when nothing is running', async () => {
    stopActiveTurn.mockResolvedValue({ stopped: false, droppedQueued: 0 });
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith('U123456789', slackUi.agent.stopIdle, {
      threadTs: '1234.5678',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('omits scopeKey for non-threadScoped channels', async () => {
    wire(false);
    deliver(makeEvent({ channelName: 'feishu', scopeKey: undefined }));
    await flushMicrotasks();

    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-ctx',
      userId: 'U123456789',
      scopeKey: undefined,
    });
  });

  it('treats !stop with attachments as a normal agent message', async () => {
    deliver(
      makeEvent({
        attachments: [{ kind: 'image' }] as unknown as IMAttachment[],
      }),
    );
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('leaves near-miss texts to the normal agent path', async () => {
    deliver(makeEvent({ text: '!stop 那个任务' }));
    await flushMicrotasks();

    expect(stopActiveTurn).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('replies an internal error (and does not crash) when stopActiveTurn throws', async () => {
    stopActiveTurn.mockRejectedValue(new Error('abort exploded'));
    deliver(makeEvent());
    await flushMicrotasks();

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'U123456789',
      slackUi.agent.sendInternalError('abort exploded'),
      { threadTs: '1234.5678' },
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
