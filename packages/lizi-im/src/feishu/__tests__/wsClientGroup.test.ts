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
    async (
      _messageId?: string,
    ): Promise<
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
  wsClient.resetOrphanRetriesForTest();
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
  // 恢复 openThread / replyText 默认实现 — 个别用例会覆盖它们
  // (含持续的 mockRejectedValue), 不能泄漏到后续用例。
  mocks.openThread.mockImplementation(async () => ({
    kind: 'opened',
    messageId: 'om_opener',
    threadId: 'omt_new',
  }));
  mocks.replyText.mockImplementation(async () => ({ messageId: 'om_reply' }));
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
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener', 'om_msg1');
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

  it('stop 挂起超过 100 条孤儿收口链后同账号重连仍恢复最早一条', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockImplementation(async (messageId?: string) => ({
        kind: 'orphaned' as const,
        openerMessageId: `om_opener_${messageId ?? 'x'}`,
      }));
      mocks.replyText.mockRejectedValue(new Error('persistent outage'));
      await connect();

      for (let i = 0; i < 101; i += 1) {
        await mocks.eventHandlers['im.message.receive_v1']!(
          groupMessage({ messageId: `om_msg_${i}`, text: `@_user_1 孤儿${i}` }),
        );
      }

      await wsClient.stop({ announceOffline: false, reason: 'same-account-reconnect' });
      await connect();
      mocks.replyText.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledWith(
        'om_opener_om_msg_0',
        expect.any(String),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('redelivery while a retry is in-flight shares the same send (no concurrent duplicate)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      // 第一次定时重试(10s)的发送挂起中 — 重投此刻到达, 必须共享这次发送
      // 而不是并发发出第二条提示。
      let resolveRetry!: (v: { messageId: string }) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((resolve) => {
            resolveRetry = resolve;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 冷却(60s)过后的重投: in-flight 共享 — 重投自己不另发(replyText 不变)。
      // 重投 handler 会等共享发送的结果, 不能 await(否则测试自身挂起)。
      await vi.advanceTimersByTimeAsync(51_000);
      const redelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 执行中的发送成功 — 共享结果 'delivered': 两条路径都收尾, 无新发送。
      resolveRetry({ messageId: 'om_ok' });
      await redelivery;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redelivery shared with a failing in-flight retry continues one chain (no duplicate)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      // 第一次定时重试(10s)的发送挂起中 — 重投共享它, 之后该发送失败。
      let rejectRetry!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectRetry = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 冷却过后的重投共享该 in-flight 发送(不另发), 随后发送失败 —
      // 共享结果 'failed': 两条路径各自安排重试, 入口同一(替换计时器)。
      // 重投 handler 等共享结果, 不 await。
      await vi.advanceTimersByTimeAsync(51_000);
      const redelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      rejectRetry(new Error('outage'));
      await redelivery;
      await Promise.resolve();
      await Promise.resolve();

      // 重试链继续(单链): 下一次尝试成功送达, 之后不再有发送。
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry scheduled after a same-account reconnect proceeds on the new connection', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首次发送挂起中 — 期间断开 + 同一 bot 重连, 挂起的发送之后才失败。
      let rejectFirst!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 断开 + 同一 bot 重连; stop 已释放 in-flight 认领 — 重投到达时不再被
      // 认领压掉, 而是正常处理并共享在途发送(不另发第二条)。
      await wsClient.stop({ announceOffline: false, reason: 'test-same-account-reconnect' });
      await connect();
      const redelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 旧发送此刻失败 — 共享结果 'failed': 两条路径各自安排重试, 入口同一;
      // 同账号重连后在新连接上继续执行(stale generation 不拦同 bot 的重试)。
      rejectFirst(new Error('client closed'));
      await firstDelivery;
      await redelivery;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry is skipped when the account changed (old account opener never hits the new client)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      let rejectFirst!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 断开并换成**别的** bot 账号。
      await wsClient.stop({ announceOffline: false, reason: 'test-account-swap' });
      const otherCreds = { appId: 'cli_other_account', appSecret: 'secret', service: 'feishu' as const };
      const connecting = wsClient.start(otherCreds, { announceLifecycle: false });
      mocks.options.at(-1)?.onReady?.();
      await connecting;
      wsClient.setBotOpenIdForTest(BOT_OPEN_ID);

      // 旧发送失败 → 安排重试; 重试触发时账号已换 — 必须跳过, 旧账号的
      // 开场白不得经新账号的 client 发出。
      rejectFirst(new Error('client closed'));
      await firstDelivery;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queued retry survives a same-bot reconnect (re-armed on start)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      // 10s 重试已排队。

      // 定时器触发前断开 + 同一 bot 重连: stop() 挂起重试, start() 恢复入队。
      await wsClient.stop({ announceOffline: false, reason: 'test-reconnect-before-retry' });
      await connect();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry that fires while disconnected is suspended and resumed on same-bot reconnect', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      // 第一次定时重试(10s)的发送挂起中 — 断开, 该发送之后才失败。
      let rejectRetry!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectRetry = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 断开(in-flight 无法挂起); 旧发送失败 → 在停止状态安排下一次重试。
      await wsClient.stop({ announceOffline: false, reason: 'test-disconnect-mid-retry' });
      rejectRetry(new Error('client closed'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // 该重试在重连前触发: 无连接 → 挂起(不终止)。
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 同一 bot 重连 → 挂起重试恢复入队 → 下一次尝试成功送达。
      await connect();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('failure after stop suspends immediately instead of creating a live timer', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首次发送挂起中 — 断开, 该发送之后才失败(失败路径运行在停止状态)。
      let rejectFirst!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      await wsClient.stop({ announceOffline: false, reason: 'test-stop-mid-first-send' });
      rejectFirst(new Error('client closed'));
      await firstDelivery;

      // 停止状态: 失败路径不创建定时器(直接挂起)— 推进时间无任何发送。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 同一 bot 重连 → 挂起恢复入队 → 送达。
      await connect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清凭证期间在途首发失败后,同账号再登录不会恢复登出前的 opener 重试', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      let rejectFirst!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 生产顺序: stop 再清凭证。在途 REST 此时仍未落定; 只清 map 挡不住
      // 失败续段 suspend, 同账号再登录就会把登出前的 opener 重试复活。
      await wsClient.stop({ announceOffline: false, reason: 'credentials-cleared' });
      wsClient.clearOrphanRetriesForCredentialClear();
      rejectFirst(new Error('client closed'));
      await firstDelivery;

      await connect();
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清凭证期间在途重试失败后,同账号再登录不会恢复登出前的 opener 重试', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      let rejectRetry!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectRetry = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      await wsClient.stop({ announceOffline: false, reason: 'credentials-cleared' });
      wsClient.clearOrphanRetriesForCredentialClear();
      rejectRetry(new Error('client closed'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await connect();
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('in-flight dedupe survives a same-bot reconnect (redelivery shares the old send)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      // 10s 定时重试的发送挂起中 — 断开重连后, 重投必须共享这次在途发送。
      let resolveRetry!: (v: { messageId: string }) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((resolve) => {
            resolveRetry = resolve;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 断开 + 同一 bot 重连(in-flight 记账保留), 冷却(60s)过后重投。
      await wsClient.stop({ announceOffline: false, reason: 'test-reconnect-mid-inflight' });
      await connect();
      await vi.advanceTimersByTimeAsync(61_000);
      const redelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 在途发送成功 — 共享结果 'delivered', 无第三条发送。
      resolveRetry({ messageId: 'om_ok' });
      await redelivery;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspended retries are not re-armed across service boundary (same appId, feishu → lark)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      // 10s 重试已排队。

      // 断开, 用同一 appId 但 service=lark 的凭证重连 — 旧 feishu 的挂起
      // 重试不得恢复(账号边界含 service)。
      await wsClient.stop({ announceOffline: false, reason: 'test-service-swap' });
      const larkCreds = { appId: 'cli_group_test', appSecret: 'secret', service: 'lark' as const };
      const connecting = wsClient.start(larkCreds, { announceLifecycle: false });
      mocks.options.at(-1)?.onReady?.();
      await connecting;
      wsClient.setBotOpenIdForTest(BOT_OPEN_ID);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redelivery joining a failed in-flight retry does not reset the attempt budget', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首发 + attempt0(10s) + attempt1(40s) 都失败; 下一次重投的发送挂起。
      mocks.replyText
        .mockRejectedValueOnce(new Error('outage'))
        .mockRejectedValueOnce(new Error('outage'))
        .mockRejectedValueOnce(new Error('outage'));
      let rejectShared!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectShared = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(3); // 首发 + attempt0 + attempt1
      // attempt2 已排队(130s 触发)。

      // 冷却过后的重投创建 in-flight 发送(第 4 次调用, 挂起)。
      const redelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(4);

      // attempt2 定时器触发 → 加入那次 in-flight(不另发)。
      await vi.advanceTimersByTimeAsync(69_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(4);

      // 共享发送失败: attempt2 链进撤回兜底; 重投失败路径的 attempt 0 不得
      // 重置预算(预算天花板) — 之后不应再有新发送。
      rejectShared(new Error('outage'));
      await redelivery;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.recallOwnMessage).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(4);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('换账号启动时丢弃旧账号的挂起重试(不再等待旧账号回归)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 断开(重试挂起)→ 换成别的 bot 启动: 挂起项被丢弃。
      await wsClient.stop({ announceOffline: false, reason: 'test-account-swap-drop' });
      const otherCreds = { appId: 'cli_other_account', appSecret: 'secret', service: 'feishu' as const };
      const connecting = wsClient.start(otherCreds, { announceLifecycle: false });
      mocks.options.at(-1)?.onReady?.();
      await connecting;
      wsClient.setBotOpenIdForTest(BOT_OPEN_ID);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 之后再换回旧账号: 丢弃过的重试不得复活(向早已过时的 opener 补发)。
      await wsClient.stop({ announceOffline: false, reason: 'test-back-to-old-account' });
      const back = wsClient.start(credentials, { announceLifecycle: false });
      mocks.options.at(-1)?.onReady?.();
      await back;
      wsClient.setBotOpenIdForTest(BOT_OPEN_ID);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清凭证取消在途孤儿发送的续段(不再 schedule/suspend 新状态)', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      let rejectFirst!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 在途发送期间清凭证: 续段按代次放弃 — 不 schedule、不 suspend。
      wsClient.clearOrphanRetriesForCredentialClear();
      rejectFirst(new Error('client closed'));
      await firstDelivery;
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);

      // 清凭证后同凭证重连: 也不应有任何重试复活。
      await wsClient.stop({ announceOffline: false, reason: 'test-relogin' });
      await connect();
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale in-flight 不丢本代收口链: 安排本代重试, 旧请求落定后送达', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首次发送挂起(代次 N)。
      let rejectOld!: (err: Error) => void;
      mocks.replyText.mockImplementationOnce(
        () =>
          new Promise<{ messageId: string }>((_, reject) => {
            rejectOld = reject;
          }),
      );
      await connect();
      const events = collectEvents();
      const firstDelivery = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 清凭证(代次 N+1)后同凭证重登录, 平台重投: 新 handler 加入 stale
      // in-flight → 安排本代重试(不丢收口链)。
      wsClient.clearOrphanRetriesForCredentialClear();
      await wsClient.stop({ announceOffline: false, reason: 'test-relogin-stale' });
      await connect();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await Promise.resolve();
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 旧请求失败 → 旧 handler 的续段被代次拦截; 本代重试在 10s 后触发,
      // 以当前代次重新发送并送达。
      rejectOld(new Error('client closed'));
      await firstDelivery;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queued retry is not re-armed when a different bot starts', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 定时器触发前断开, 换成别的 bot — 旧 bot 的挂起重试不得恢复。
      await wsClient.stop({ announceOffline: false, reason: 'test-account-swap-before-retry' });
      const otherCreds = { appId: 'cli_other_account', appSecret: 'secret', service: 'feishu' as const };
      const connecting = wsClient.start(otherCreds, { announceLifecycle: false });
      mocks.options.at(-1)?.onReady?.();
      await connecting;
      wsClient.setBotOpenIdForTest(BOT_OPEN_ID);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(1);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivered terminal marker blocks a late send path even beyond the 60s cooldown', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

      // 10s 定时重试成功送达 — 终态标记写入。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 远超 60s 冷却窗口后的重投: 送达是终态 + 入站认领已重新认领 —
      // 任何路径都不再发送第三条提示。
      await vi.advanceTimersByTimeAsync(300_000);
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('successful retry reclaims the message so later redeliveries are suppressed', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      mocks.replyText.mockRejectedValueOnce(new Error('transient network error'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 10s 定时重试成功 — 重新认领触发消息。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(2);

      // 冷却(60s)过后的重投: 入站去重拦下(已重新认领), 不再进入提示流程。
      await vi.advanceTimersByTimeAsync(61_000);
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('successful redelivery cancels the stale retry scheduled by the failed first attempt', async () => {
    vi.useFakeTimers();
    try {
      mocks.openThread.mockResolvedValue({ kind: 'orphaned', openerMessageId: 'om_opener' });
      // 首发 + 前两轮定时重试都失败(90s 重试挂起中) — 重投在此时成功送达。
      mocks.replyText
        .mockRejectedValueOnce(new Error('transient network error'))
        .mockRejectedValueOnce(new Error('still down'))
        .mockRejectedValueOnce(new Error('still down'));
      await connect();
      const events = collectEvents();
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(1);

      // 冷却过后的重投成功发送提示 — 之前失败轮次安排的定时重试应被清掉,
      // 否则它会绕过冷却在稍后重复提示, 甚至耗尽后误撤回开场白卡。
      await vi.advanceTimersByTimeAsync(61_000);
      // 61s 内 10s + 30s 两轮定时重试都跑过且失败(共 3 次调用)。
      expect(mocks.replyText).toHaveBeenCalledTimes(3);
      await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
      expect(mocks.replyText).toHaveBeenCalledTimes(4);

      // 再推进远超 90s 的重试窗口: 被清掉的重试链不应再有任何发送。
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mocks.replyText).toHaveBeenCalledTimes(4);
      expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
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

  it('stop releases the in-flight claim so a redelivery on the reconnected bot is processed', async () => {
    // 旧连接的 openThread 挂起中; stop(同账号重连)释放认领; 新连接的重投
    // 到达 → 正常处理(不被仍持有的认领压掉)。
    let resolveOldOpen!: (o: { kind: 'opened'; messageId: string; threadId: string }) => void;
    mocks.openThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldOpen = resolve;
      }),
    );
    await connect();
    const events = collectEvents();
    const oldHandling = mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    await Promise.resolve();
    expect(mocks.openThread).toHaveBeenCalledTimes(1);

    await wsClient.stop({ announceOffline: false, reason: 'test-reconnect-while-opening' });
    await connect();
    // 重投(旧请求恢复前到达): stop 已释放认领 → 新连接正常处理并 emit。
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    await vi.waitFor(() => expect(mocks.openThread).toHaveBeenCalledTimes(2));
    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe('g/oc_chat1/omt_new');

    // 旧 handler 此刻才恢复: gate-drop, 且不得再释放新连接的认领。
    resolveOldOpen({ kind: 'opened', messageId: 'om_opener', threadId: 'omt_new' });
    await oldHandling;
    expect(events).toHaveLength(1);

    // 第三次投递: 新连接的认领仍在 → 重推被压掉, 不会重复起 turn。
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));
    expect(events).toHaveLength(1);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
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
