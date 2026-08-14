/**
 * 群消息入站门禁: @ 检测、owner 门、非 owner 礼貌回应(冷却)、lane senderId、
 * mention 占位符剥离、thread_id → 话题 lane、群主流 @ 入站开话题。
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
  openThread: vi.fn(
    async (): Promise<
      | { kind: 'opened'; messageId: string; threadId: string }
      | { kind: 'degraded' }
      | { kind: 'orphaned'; openerMessageId: string }
    > => ({
      kind: 'opened',
      messageId: 'om_opener',
      threadId: 'omt_new',
    }),
  ),
  pushReplyAnchor: vi.fn(),
  pushPatchableOpener: vi.fn(),
  evictOpenThreadOutcome: vi.fn(),
  recallOwnMessage: vi.fn(async () => true),
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
  pushReplyAnchor: mocks.pushReplyAnchor,
  pushPatchableOpener: mocks.pushPatchableOpener,
  evictOpenThreadOutcome: mocks.evictOpenThreadOutcome,
  recallOwnMessage: mocks.recallOwnMessage,
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
  appId: 'cli_group_test',
  appSecret: 'secret',
  service: 'feishu' as const,
};

const BOT_OPEN_ID = 'ou_bot_self';
const OWNER = 'ou_owner';
const STRANGER = 'ou_stranger';

function groupMessage(overrides: {
  sender?: string;
  text?: string;
  mentions?: Array<{ key: string; id?: { open_id?: string }; name?: string }>;
  threadId?: string;
  messageId?: string;
  chatId?: string;
}) {
  return {
    sender: { sender_id: { open_id: overrides.sender ?? OWNER } },
    message: {
      message_id: overrides.messageId ?? 'om_msg1',
      chat_id: overrides.chatId ?? 'oc_chat1',
      ...(overrides.threadId ? { thread_id: overrides.threadId } : {}),
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: overrides.text ?? '@_user_1 帮我看看' }),
      mentions: overrides.mentions ?? [
        { key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Cindy' },
      ],
    },
  };
}

async function connect(): Promise<void> {
  const connecting = wsClient.start(credentials, { announceLifecycle: false });
  mocks.options.at(-1)?.onReady?.();
  await connecting;
  wsClient.setBotOpenIdForTest(BOT_OPEN_ID);
}

function collectEvents(): IMMessageEvent[] {
  const events: IMMessageEvent[] = [];
  feishuEvents.on('message', (e) => events.push(e));
  return events;
}

beforeEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-reset' });
  // 入站去重账本按设计跨 stop/start 保留(重推高发在重连前后), 所以用例之间
  // 想复用同一个 message_id 必须显式清账。
  wsClient.resetInboundDedupeForTest();
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
  // 恢复 openThread 默认实现 — 个别用例会覆盖它, 不能泄漏到后续用例。
  mocks.openThread.mockImplementation(async () => ({
    kind: 'opened',
    messageId: 'om_opener',
    threadId: 'omt_new',
  }));
});

afterEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-cleanup' });
  feishuEvents.removeAllListeners('message');
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

describe('feishu group inbound gate', () => {
  it('drops group messages that do not mention the bot', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(
      groupMessage({ mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'X' }] }),
    );
    expect(events).toHaveLength(0);
  });

  it('drops all group messages while bot open_id is unknown', async () => {
    await connect();
    wsClient.setBotOpenIdForTest(null);
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    expect(events).toHaveLength(0);
  });

  it('never TOFU-claims owner from a group mention', async () => {
    mocks.firstAllowed.mockReturnValue(null);
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    expect(mocks.tryClaimOwner).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('replies politely to a non-owner mention with per-user cooldown, no turn', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({ sender: STRANGER }));
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({ sender: STRANGER }));
    expect(mocks.replyText).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it('owner mention in main stream opens a thread and emits into the new topic lane', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.senderId).toBe('g/oc_chat1/omt_new');
    expect(event.chatId).toBe('oc_chat1');
    expect(event.text).toBe('帮我看看');
    expect(event.speaker).toEqual({ id: OWNER, name: '', isOwner: true });
    // 锚点是开场白消息(话题内合法锚点), 不是触发消息。
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
    // 开场白卡登记为可补丁锚点 — 本轮流式卡直接 patch 它, 不发占位消息。
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
    // 路由进新话题 lane, 但上下文取数 lane 仍是群主流(新话题是空的)。
    expect(event.groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
  });

  it('falls back to the plain group lane when thread creation fails', async () => {
    mocks.openThread.mockResolvedValueOnce({ kind: 'degraded' });
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe('g/oc_chat1');
    expect(events[0]!.groupContextLane).toBeUndefined();
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1', 'om_msg1');
  });

  it('orphaned opener: replies an in-topic notice and drops the turn instead of degrading', async () => {
    mocks.openThread.mockResolvedValueOnce({ kind: 'orphaned', openerMessageId: 'om_opener' });
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

    expect(events).toHaveLength(0);
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
    // 提示挂在开场白下(自动落回话题) — 不把回答刷进群主流。
    expect(mocks.replyText).toHaveBeenCalledWith('om_opener', expect.any(String));
  });

  it('drops the turn when the connection is replaced while openThread is awaiting', async () => {
    let resolveOpenThread!: (outcome: {
      kind: 'opened';
      messageId: string;
      threadId: string;
    }) => void;
    mocks.openThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOpenThread = resolve;
      }),
    );
    await connect();
    const events = collectEvents();
    const handling = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    // openThread 仍在等待 API 时用户断开/换账号 — 旧连接的轮次不得漏进新连接。
    await wsClient.stop({ announceOffline: false, reason: 'test-disconnect-mid-open' });
    resolveOpenThread({ kind: 'opened', messageId: 'om_opener', threadId: 'omt_new' });
    await handling;

    expect(events).toHaveLength(0);
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
    // 放弃路径释放了入站认领并 evict 了开话题缓存 — 新连接上的重投消息应
    // 重新走 openThread API(而不是复用旧连接上的结果), 且正常处理。
    expect(mocks.evictOpenThreadOutcome).toHaveBeenCalledWith('om_msg1');
    await connect();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe('g/oc_chat1/omt_new');
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
  });

  it('orphan notice failure schedules escalating active retries instead of relying on redelivery', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValueOnce({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首发失败 + 前两次重试失败, 第三次重试成功。
      mocks.replyText
        .mockRejectedValueOnce(new Error('transient network error'))
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockRejectedValueOnce(new Error('still down'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

      // 首轮: 不起 turn, 提示发送失败。
      expect(events).toHaveLength(0);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 飞书对 3s 内完成处理的事件直接 ACK 不再重推 — 主动重试不依赖重投,
      // 递增间隔(10s / 30s / 90s), 用户不会永远看着「思考中」的开场白卡。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(4);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('orphan notice retries are gated to the triggering connection', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValueOnce({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 首发失败后、重试触发前用户断开/换账号 — 旧账号的开场白不该发进
      // 新账号的会话, 重试应被跳过。
      await wsClient.stop({ announceOffline: false, reason: 'test-disconnect-before-retry' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry exhaustion recalls the orphaned opener card as last resort', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValueOnce({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首发 + 3 次重试全部失败(持续故障)。
      mocks.replyText.mockRejectedValue(new Error('persistent outage'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(90_000);

      expect(mocks.replyText).toHaveBeenCalledTimes(4);
      // 重试耗尽: 撤回开场白卡, 用户看到干净群主流而不是永久「思考中」卡。
      expect(mocks.recallOwnMessage).toHaveBeenCalledWith('om_opener');
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhaustion recall is gated to the triggering connection', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValueOnce({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText
        .mockRejectedValueOnce(new Error('outage'))
        .mockRejectedValueOnce(new Error('outage'))
        .mockRejectedValueOnce(new Error('outage'));
      // 最后一次重试(retry2)的 replyText 挂起 — 期间用户换代, 之后才失败。
      let rejectLast!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectLast = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(4);

      // 最后一次重试挂起期间换代, 然后失败 → 耗尽分支应 gate 拦截撤回:
      // 旧账号的开场白卡不得经新 client 发出删除请求。
      await wsClient.stop({ announceOffline: false, reason: 'test-disconnect-mid-retry' });
      rejectLast(new Error('outage'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cooldown-hit redelivery releases its claim so a later redelivery can retry', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首发 + 前两次定时重试都失败; 第三次重试(90s)不触发。
      mocks.replyText
        .mockRejectedValueOnce(new Error('transient network error'))
        .mockRejectedValueOnce(new Error('still down'))
        .mockRejectedValueOnce(new Error('still down'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 冷却期内的重投: 冷却命中不发送 — 必须释放本次认领, 否则冷却期间
      // 的 claim 卡满 10 分钟, 之后换代会丢消息。
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 推进 61s: 定时重试(10s/30s)跑两轮都失败; 冷却已过期。
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);

      // 冷却过期后的重投: 认领未被卡住 → 正常处理 → 提示发送成功(第 4 次)。
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(4);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops duplicate delivery of the same message (one turn per message)', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    // 飞书重投同一条 @ 事件: 入站去重直接丢弃, 第二次 turn 不会启动
    // (重复锚点 + 两份回答)。
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

    expect(events).toHaveLength(1);
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(mocks.pushReplyAnchor).toHaveBeenCalledTimes(1);
  });

  it('routes topic messages into a topic lane without opening a new thread', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(
      groupMessage({ threadId: 'omt_topic7' }),
    );
    expect(events[0]!.senderId).toBe('g/oc_chat1/omt_topic7');
    expect(events[0]!.groupContextLane).toBeUndefined();
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_topic7', 'om_msg1');
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it('replaces other-user mention placeholders with sanitized display names', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(
      groupMessage({
        text: '@_user_1 问下 @_user_2 的进度',
        mentions: [
          { key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Cindy' },
          { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Al\u0007ice' },
        ],
      }),
    );
    expect(events[0]!.text).toBe('问下 @Al ice 的进度');
  });

  it('keeps p2p flow unchanged (owner gate + plain senderId, no speaker)', async () => {
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!({
      sender: { sender_id: { open_id: OWNER } },
      message: {
        message_id: 'om_dm',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '私聊消息' }),
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe(OWNER);
    expect(events[0]!.speaker).toBeUndefined();
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
  });
});
