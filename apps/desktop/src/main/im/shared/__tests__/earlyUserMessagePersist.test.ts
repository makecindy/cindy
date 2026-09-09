/**
 * 入站用户消息「提前落库」的路由契约。
 *
 * 背景: 渠道用户消息平时是在 provider 受理那一刻才写进 messages 表, 于是桌面端
 * 那条会话里要等 turn 真正派发才看得到这句话。带 prepareAgentTurnText 的渠道
 * (飞书/钉钉/telegram 群) 在派发之前还要拼群上下文 —— 回翻群历史 + 轻量模型扫描,
 * 2026-08-14 实测新话题首句 61.7s、话题内消息 15.3s(小模型超时后再换备选)。
 * 那段时间桌面端一片空白, 看着像消息丢了。
 *
 * 因此 messageHandler 在拼装**之前**先落一条, 并把结果透传给 runAgentTurn。
 * 这里锁住四条:
 *   1. 顺序: 提前落库排在 prepareAgentTurnText 之前(否则等于没提前);
 *   2. 落库用渠道原文, 不是拼了群上下文前缀的 agentText;
 *   3. 落不成(忙 / 新会话 / 抛错) ⇒ 照常跑 turn, 不带该字段, 完全退回原行为;
 *   4. 没有 prepareAgentTurnText 的渠道根本不走这条路(它们本就立刻派发)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelIM, IMMessageEvent } from '@cindy/im';

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

vi.mock('../slashCommands', () => ({
  looksLikeSlashCommand: (text: string) => text.startsWith('/'),
}));

import { createMessageHandler } from '../messageHandler';
import { activateImAccountBoundary } from '../../accountBoundary';
import type { ImSlashHandlers } from '../slashCommands';
import type { ImRunAgentTurnArgs, ImTurnRunner } from '../turnRunner';
import type { ImChannelAdapter } from '../types';
import { ui as slackUi } from './threadUiFixture';

function makeEvent(overrides: Partial<IMMessageEvent> = {}): IMMessageEvent {
  return {
    channelName: 'feishu',
    senderId: 'g/oc_chat/omt_topic',
    chatId: 'oc_chat',
    contextId: 'cli_bot',
    messageId: 'om_msg',
    text: '出行要注意什么吗',
    attachments: [],
    unsupported: [],
    ...overrides,
  };
}

interface Harness {
  deliver: (event: IMMessageEvent) => void;
  runAgentTurn: ReturnType<typeof vi.fn>;
  persistEarly: ReturnType<typeof vi.fn>;
  prepareAgentTurnText: ReturnType<typeof vi.fn> | undefined;
  calls: string[];
  reactToMessage: ReturnType<typeof vi.fn>;
}

function wire(opts: { withPrepare: boolean } = { withPrepare: true }): Harness {
  const calls: string[] = [];
  const runAgentTurn = vi.fn(async () => undefined);
  const reactToMessage = vi.fn(async () => 'reaction-1');
  const persistEarly = vi.fn(async () => {
    calls.push('persistEarly');
    return { sessionId: 'feishu-session', clientId: 'early-client' };
  });
  const prepareAgentTurnText = opts.withPrepare
    ? vi.fn(async (event: IMMessageEvent) => {
        calls.push('prepare');
        return { agentText: `<group_chat_context>…</group_chat_context>${event.text}` };
      })
    : undefined;

  let deliver!: (event: IMMessageEvent) => void;
  const im = {
    onMessage(handler: (event: IMMessageEvent) => void) {
      deliver = handler;
      return () => undefined;
    },
    sendMarkdownText: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    reactToMessage,
  } as unknown as ChannelIM;

  const adapter = {
    channel: 'feishu',
    im,
    ui: slackUi,
    threadScoped: false,
    processingEmoji: 'Eyes',
    ...(prepareAgentTurnText ? { prepareAgentTurnText } : {}),
  } as unknown as ImChannelAdapter;

  const attach = createMessageHandler(
    adapter,
    { handleSlashCommand: vi.fn(async () => true) } as unknown as ImSlashHandlers,
    {
      runAgentTurn,
      persistInboundUserMessageEarly: persistEarly,
      stopActiveTurn: vi.fn(async () => ({ stopped: false, droppedQueued: 0 })),
    } as unknown as ImTurnRunner,
  );
  attach(im);

  return { deliver, runAgentTurn, persistEarly, prepareAgentTurnText, calls, reactToMessage };
}

function turnArgs(runAgentTurn: ReturnType<typeof vi.fn>): ImRunAgentTurnArgs {
  return runAgentTurn.mock.calls[0]![0] as ImRunAgentTurnArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  activateImAccountBoundary();
});

describe('messageHandler early user-message persist', () => {
  it('先落库再拼群上下文, 并把落库结果透传给 turn', async () => {
    const h = wire();
    h.deliver(makeEvent());

    await vi.waitFor(() => expect(h.runAgentTurn).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual(['persistEarly', 'prepare']);
    expect(turnArgs(h.runAgentTurn).prePersistedUserMessage).toEqual({
      sessionId: 'feishu-session',
      clientId: 'early-client',
    });
  });

  it('落库用渠道原文, 不用拼了群上下文前缀的 agentText', async () => {
    const h = wire();
    h.deliver(makeEvent({ text: '总结上面' }));

    await vi.waitFor(() => expect(h.persistEarly).toHaveBeenCalledTimes(1));
    expect(h.persistEarly.mock.calls[0]![0]).toMatchObject({
      botContextId: 'cli_bot',
      userId: 'g/oc_chat/omt_topic',
      text: '总结上面',
    });
    // 前缀只进模型消息。
    expect(turnArgs(h.runAgentTurn).agentText).toContain('group_chat_context');
    expect(turnArgs(h.runAgentTurn).text).toBe('总结上面');
  });

  it('会话忙 / 还没建行时 runner 返回 null ⇒ turn 不带该字段, 退回原行为', async () => {
    const h = wire();
    h.persistEarly.mockResolvedValueOnce(null);
    h.deliver(makeEvent());

    await vi.waitFor(() => expect(h.runAgentTurn).toHaveBeenCalledTimes(1));
    expect(turnArgs(h.runAgentTurn).prePersistedUserMessage).toBeUndefined();
  });

  it('提前落库抛错不阻断消息 —— turn 照常跑', async () => {
    const h = wire();
    h.persistEarly.mockRejectedValueOnce(new Error('db locked'));
    h.deliver(makeEvent());

    await vi.waitFor(() => expect(h.runAgentTurn).toHaveBeenCalledTimes(1));
    expect(turnArgs(h.runAgentTurn).prePersistedUserMessage).toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('early user-message persist failed'),
    );
  });

  it('受保护群的触发消息把 protectedContent 一起交给 runner(由它决定不落)', async () => {
    const h = wire();
    h.deliver(makeEvent({ protectedContent: true }));

    await vi.waitFor(() => expect(h.persistEarly).toHaveBeenCalledTimes(1));
    expect(h.persistEarly.mock.calls[0]![0]).toMatchObject({ protectedContent: true });
  });

  it('没有群上下文拼装的渠道不走提前落库(本来就立刻派发)', async () => {
    const h = wire({ withPrepare: false });
    h.deliver(makeEvent());

    await vi.waitFor(() => expect(h.runAgentTurn).toHaveBeenCalledTimes(1));
    expect(h.persistEarly).not.toHaveBeenCalled();
    expect(turnArgs(h.runAgentTurn).prePersistedUserMessage).toBeUndefined();
  });
});
