/**
 * 群消息的话题路由不变量 —— 每条话题一条 lane, 谁也别想截流。
 *
 * 语义:
 *   - 群主流 @bot: **恒** openThread 开新话题, 以新话题 lane 路由(senderId =
 *     新话题 lane, 回复锚点 = 开场白消息), 上下文取数 lane 仍指向群主流;
 *     开话题失败才降级回群 lane(锚点 = 触发消息)。
 *   - 话题内消息: 直接进该话题自己的 lane, 锚点 = 触发消息。
 *
 * 这条不变量是 `/ctr` 接管「只跟话题走」的地基: 接管 binding 的 key 就是话题
 * lane, transport 这边不给任何「把群主流消息改道进某条接管话题」的口子 ——
 * 有过一版这样的覆写钩子, 结果群里随便 @ 一句都掉进被接管的会话里
 * (用户感知: 不管在哪问, 工作目录都是绑定那个项目), 已移除。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { feishuEvents } from '../events.js';
import type { IMMessageEvent } from '../../types.js';

type EventHandler = (data: unknown) => Promise<unknown> | unknown;

const mocks = {
  options: [] as Array<{ onReady?: () => void }>,
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  bindClient: vi.fn(),
  unbindClient: vi.fn(),
  getBoundClient: vi.fn(() => null),
  sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
  replyText: vi.fn(async () => ({ messageId: 'om_reply' })),
  // 返回 degraded = 开话题失败(降级回群 lane), 单测按用例覆盖。
  openThread: vi.fn<
    (messageId?: string) => Promise<
      | { kind: 'opened'; messageId: string; threadId: string }
      | { kind: 'degraded' }
      | { kind: 'orphaned'; openerMessageId: string }
      | { kind: 'unconfirmed' }
    >
  >(async () => ({ kind: 'opened', messageId: 'om_opener', threadId: 'omt_new' })),
  evictOpenThreadOutcome: vi.fn(),
  pushReplyAnchor: vi.fn(),
  pushPatchableOpener: vi.fn(),
  resolveCardLane: vi.fn<(messageId: string, chatId: string) => string | null>(
    () => null,
  ),
  firstAllowed: vi.fn<() => string | null>(() => null),
  readOwnerOpenId: vi.fn<() => string | null>(() => null),
  clearOwner: vi.fn(),
  checkOwner: vi.fn((senderOpenId: string) => {
    void senderOpenId;
    return false;
  }),
  tryClaimOwner: vi.fn(() => false),
  eventHandlers: {} as Record<string, EventHandler>,
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
};

vi.doMock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    readonly start = mocks.start;
    readonly close = mocks.close;

    constructor(options: { onReady?: () => void }) {
      mocks.options.push(options);
    }
  },
  EventDispatcher: class {
    register(handlers: Record<string, EventHandler>): this {
      mocks.eventHandlers = handlers;
      return this;
    }
  },
  LoggerLevel: { info: 'info' },
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
}));

vi.doMock('../outbound.js', () => ({
  bindClient: mocks.bindClient,
  unbindClient: mocks.unbindClient,
  getBoundClient: mocks.getBoundClient,
  sendText: mocks.sendText,
  replyText: mocks.replyText,
  openThread: mocks.openThread,
  evictOpenThreadOutcome: mocks.evictOpenThreadOutcome,
  pushReplyAnchor: mocks.pushReplyAnchor,
  pushPatchableOpener: mocks.pushPatchableOpener,
  resolveCardLane: mocks.resolveCardLane,
}));

vi.doMock('../ownerGuard.js', () => ({
  firstAllowed: mocks.firstAllowed,
  clear: mocks.clearOwner,
  check: mocks.checkOwner,
  tryClaimOwner: mocks.tryClaimOwner,
}));

vi.doMock('../storage.js', () => ({
  readOwnerOpenId: mocks.readOwnerOpenId,
}));

vi.doMock('../moduleScope.js', () => ({
  getLog: () => mocks.log,
}));

let wsClient: typeof import('../wsClient.js');

const credentials = {
  appId: 'cli_takeover_test',
  appSecret: 'secret',
  service: 'feishu' as const,
};

const OWNER = 'ou_owner';
const BOT = 'ou_bot';

// message_id 可覆写 —— 入站层按 message_id 去重(飞书重推闸门), 用例里模拟
// "两条不同的消息" 必须给不同 id, 否则第二条会被当成重推丢掉。
function groupMainFlowMessage(text: string, messageId = 'om_msg1'): unknown {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }],
    },
  };
}

function groupTopicMessage(text: string, threadId: string): unknown {
  const raw = groupMainFlowMessage(text) as { message: Record<string, unknown> };
  raw.message.thread_id = threadId;
  return raw;
}

async function connect(): Promise<void> {
  wsClient.setBotOpenIdForTest(BOT);
  const connecting = wsClient.start(credentials, { announceLifecycle: false });
  mocks.options.at(-1)?.onReady?.();
  await connecting;
}

function collectMessages(): IMMessageEvent[] {
  const events: IMMessageEvent[] = [];
  feishuEvents.on('message', (e) => events.push(e));
  return events;
}

beforeEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-reset' });
  // 去重账本按设计跨 stop/start 保留, 用例之间必须显式清掉才能复用同一个
  // message_id。
  wsClient.resetInboundDedupeForTest();
  wsClient.resetOrphanRetriesForTest();
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
});

afterEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-cleanup' });
  wsClient.resetOrphanRetriesForTest();
  feishuEvents.removeAllListeners('message');
  vi.useRealTimers();
});

beforeAll(async () => {
  wsClient = await import('../wsClient.js');
});

afterAll(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  vi.doUnmock('../outbound.js');
  vi.doUnmock('../ownerGuard.js');
  vi.doUnmock('../storage.js');
  vi.doUnmock('../moduleScope.js');
});

describe('feishu group thread routing', () => {
  it('群主流 @bot 恒开新话题, 以新话题 lane 路由, 锚点 = 开场白消息', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开个新话题'));

    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1');
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener', 'om_msg1');
    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_new');
    // 新话题是空的, 群历史前缀仍按触发时所在的群主流拉取。
    expect(events[0].groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
    expect(events[0].text).toBe('开个新话题');
  });

  /**
   * 回归守卫: 曾有一版「群里存在 /ctr 接管时把群主流消息改道进接管话题」的
   * transport 钩子, 结果群里随便 @ 一句都进那条被接管的会话。接管只跟话题走,
   * 群主流永远只会开出新话题 —— transport 这层不认识任何接管状态。
   */
  it('每次群主流 @bot 都开自己的新话题(没有任何"截流进接管话题"的通道)', async () => {
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'opened', messageId: 'om_opener1', threadId: 'omt_a' })
      .mockResolvedValueOnce({ kind: 'opened', messageId: 'om_opener2', threadId: 'omt_b' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](
      groupMainFlowMessage('第一句', 'om_first'),
    );
    await mocks.eventHandlers['im.message.receive_v1'](
      groupMainFlowMessage('第二句', 'om_second'),
    );

    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.senderId)).toEqual(['g/oc_chat1/omt_a', 'g/oc_chat1/omt_b']);
  });

  it('话题内消息进该话题自己的 lane, 不开新话题, 锚点 = 触发消息', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](
      groupTopicMessage('话题里回复', 'omt_existing'),
    );

    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_existing', 'om_msg1');
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
    // 话题内触发: 取数 lane 就是话题自己(不带 groupContextLane 覆写)。
    expect(events[0].groupContextLane).toBeUndefined();
  });

  it('开话题失败时降级回群 lane(锚点 = 触发消息)', async () => {
    mocks.openThread.mockResolvedValueOnce({ kind: 'degraded' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开话题失败'));

    expect(events[0].senderId).toBe('g/oc_chat1');
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1', 'om_msg1');
    expect(events[0].groupContextLane).toBeUndefined();
  });

  it('开话题回执不确定时立刻不起 turn、不降级, 也不释放认领', async () => {
    mocks.openThread.mockResolvedValueOnce({ kind: 'unconfirmed' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('回执不确定'));

    expect(events).toHaveLength(0);
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    expect(mocks.evictOpenThreadOutcome).not.toHaveBeenCalled();
  });

  it('回执不确定后定时用同一 uuid 取回 opened, 再发出话题 turn', async () => {
    vi.useFakeTimers();
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockResolvedValueOnce({ kind: 'opened', messageId: 'om_recovered', threadId: 'omt_rec' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('回执不确定后恢复'));
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(mocks.openThread).toHaveBeenLastCalledWith('om_msg1');
    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_rec');
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith(
      'g/oc_chat1/omt_rec',
      'om_recovered',
      'om_msg1',
    );
    vi.useRealTimers();
  });

  it('回执不确定耗尽后同账号重连仍能恢复, 不丢弃恢复链', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockReset();
    mocks.openThread.mockResolvedValue({ kind: 'unconfirmed' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('耗尽后重连'));
    await vi.advanceTimersByTimeAsync(10_000 + 30_000 + 90_000 + 1_000);
    expect(events).toHaveLength(0);
    expect(mocks.openThread).toHaveBeenCalledTimes(4);

    await wsClient.stop({ announceOffline: false, reason: 'same-account-reconnect' });
    await connect();
    mocks.openThread.mockClear();
    mocks.openThread.mockResolvedValueOnce({
      kind: 'opened',
      messageId: 'om_late',
      threadId: 'omt_late',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1');
    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_late');
    vi.useRealTimers();
  });

  it('回执不确定后恢复为 degraded 不视为确认无卡, 不降级派发', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockReset();
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockResolvedValueOnce({ kind: 'degraded' })
      .mockResolvedValueOnce({
        kind: 'opened',
        messageId: 'om_late',
        threadId: 'omt_late',
      });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('先不确定后失败'));
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(0);
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_late');
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith(
      'g/oc_chat1/omt_late',
      'om_late',
      'om_msg1',
    );
    vi.useRealTimers();
  });

  it('回执不确定耗尽定时重试后仍不降级群主流', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockResolvedValue({ kind: 'unconfirmed' });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('一直不确定'));
    await vi.advanceTimersByTimeAsync(10_000 + 30_000 + 90_000 + 1_000);

    expect(events).toHaveLength(0);
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    // 首次 + 三档延迟重试
    expect(mocks.openThread).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('stop 挂起超过 100 条 unconfirmed 后同账号重连仍恢复最早一条', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockResolvedValue({ kind: 'unconfirmed' });
    const events = collectMessages();
    await connect();

    for (let i = 0; i < 101; i += 1) {
      await mocks.eventHandlers['im.message.receive_v1'](
        groupMainFlowMessage(`回执不确定${i}`, `om_unconfirmed_${i}`),
      );
    }
    expect(events).toHaveLength(0);

    await wsClient.stop({ announceOffline: false, reason: 'same-account-reconnect' });
    await connect();
    mocks.openThread.mockClear();
    mocks.openThread.mockImplementation(async (messageId?: string) => {
      if (messageId === 'om_unconfirmed_0') {
        return { kind: 'opened' as const, messageId: 'om_first', threadId: 'omt_first' };
      }
      return { kind: 'unconfirmed' as const };
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledWith('om_unconfirmed_0');
    expect(events.some((event) => event.messageId === 'om_unconfirmed_0')).toBe(true);
    vi.useRealTimers();
  });

  it('延迟恢复 await openThread 期间换账号后不再登记锚点或派发 turn', async () => {
    vi.useFakeTimers();
    let resolveOpen!: (value: {
      kind: 'opened';
      messageId: string;
      threadId: string;
    }) => void;
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOpen = resolve;
          }),
      );
    const events = collectMessages();
    await connect();
    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('换账号'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);

    await wsClient.stop({ announceOffline: false, reason: 'switch-account' });
    const connecting = wsClient.start(
      { appId: 'cli_other_bot', appSecret: 'secret', service: 'feishu' },
      { announceLifecycle: false },
    );
    mocks.options.at(-1)?.onReady?.();
    await connecting;

    resolveOpen({ kind: 'opened', messageId: 'om_stale', threadId: 'omt_stale' });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(0);
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
