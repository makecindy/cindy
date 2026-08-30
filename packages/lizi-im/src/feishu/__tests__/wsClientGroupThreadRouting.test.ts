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

import { pendingTopicLeaseCountForTest, resetDualDeliveryForTest } from '../dualDelivery.js';
import { feishuEvents } from '../events.js';
import type { IMMessageEvent } from '../../types.js';

type EventHandler = (data: unknown) => Promise<unknown> | unknown;
type DownloadResult = {
  attachments: IMMessageEvent['attachments'];
  unsupported: IMMessageEvent['unsupported'];
};

const mocks = {
  options: [] as Array<{ onReady?: () => void }>,
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  bindClient: vi.fn(),
  unbindClient: vi.fn(),
  getBoundClient: vi.fn<() => unknown>(() => null),
  downloadAttachments: vi.fn<(...args: unknown[]) => Promise<DownloadResult>>(async () => ({
    attachments: [],
    unsupported: [],
  })),
  getAccountEpoch: vi.fn(() => 1),
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
  recallOwnMessage: vi.fn(async () => true),
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

vi.doMock('../attachmentDownloader.js', () => ({
  downloadAttachments: mocks.downloadAttachments,
}));

vi.doMock('../outbound.js', () => ({
  bindClient: mocks.bindClient,
  unbindClient: mocks.unbindClient,
  getBoundClient: mocks.getBoundClient,
  getAccountEpoch: mocks.getAccountEpoch,
  sendText: mocks.sendText,
  replyText: mocks.replyText,
  openThread: mocks.openThread,
  recallOwnMessage: mocks.recallOwnMessage,
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

function groupTopicImageMessage(threadId: string, messageId: string): unknown {
  const raw = groupTopicMessage('unused', threadId) as { message: Record<string, unknown> };
  raw.message.message_id = messageId;
  raw.message.message_type = 'image';
  raw.message.content = JSON.stringify({ image_key: 'img_topic_1' });
  raw.message.create_time = '1788000000001';
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
  resetDualDeliveryForTest();
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
  mocks.getBoundClient.mockImplementation(() => null);
  mocks.downloadAttachments.mockImplementation(async () => ({
    attachments: [],
    unsupported: [],
  }));
});

afterEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-cleanup' });
  wsClient.resetOrphanRetriesForTest();
  resetDualDeliveryForTest();
  feishuEvents.removeAllListeners('message');
  vi.useRealTimers();
});

beforeAll(async () => {
  wsClient = await import('../wsClient.js');
});

afterAll(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  vi.doUnmock('../attachmentDownloader.js');
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

  it('勾选同时发送到群聊: 不同 message_id 的话题/群副本只派一个话题 turn', async () => {
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('同步回答', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000000000';
    topic.message.message_id = 'om_topic_copy';
    const flat = groupMainFlowMessage('同步回答', 'om_flat_copy') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000000000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0].finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
      confirmed: true,
    });
    expect(mocks.openThread).not.toHaveBeenCalled();
  });

  it('does not register a reply anchor for a topic delivery that loses the route lease', async () => {
    const events = collectMessages();
    await connect();
    const topicA = groupTopicMessage('同步回答', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topicA.message.create_time = '1788000000000';
    topicA.message.message_id = 'om_topic_a';
    const topicB = groupTopicMessage('同步回答', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topicB.message.create_time = '1788000000000';
    topicB.message.message_id = 'om_topic_b';

    await Promise.all([
      mocks.eventHandlers['im.message.receive_v1'](topicA),
      mocks.eventHandlers['im.message.receive_v1'](topicB),
    ]);

    expect(events).toHaveLength(1);
    expect(mocks.pushReplyAnchor).toHaveBeenCalledTimes(1);
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith(
      'g/oc_chat1/omt_existing',
      events[0].messageId,
    );
  });

  it('releases the topic lease when a mention-only topic has nothing to relay', async () => {
    const events = collectMessages();
    await connect();
    const empty = groupTopicMessage('@_user_1', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    empty.message.create_time = '1788000000000';
    empty.message.message_id = 'om_empty_mention';

    await mocks.eventHandlers['im.message.receive_v1'](empty);

    expect(events).toHaveLength(0);
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('abandons the topic lease when the account is replaced during attachment download', async () => {
    const events = collectMessages();
    let releaseDownload: ((value: {
      attachments: IMMessageEvent['attachments'];
      unsupported: IMMessageEvent['unsupported'];
    }) => void) | undefined;
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    mocks.getBoundClient.mockReturnValue({});
    mocks.downloadAttachments.mockImplementationOnce(() => {
      downloadStarted();
      return new Promise((resolve) => {
        releaseDownload = resolve;
      });
    });
    await connect();
    const handling = mocks.eventHandlers['im.message.receive_v1'](
      groupTopicImageMessage('omt_existing', 'om_topic_img_switch'),
    );
    await started;
    mocks.unbindClient.mockImplementationOnce(() => {
      releaseDownload?.({
        attachments: [
          {
            kind: 'image',
            absPath: '/tmp/cindy-feishu-topic.png',
            originalName: 'topic.png',
            mimeType: 'image/png',
          },
        ],
        unsupported: [],
      });
    });
    await wsClient.stop({
      announceOffline: false,
      reason: 'test-switch-account',
      nextAccount: { appId: 'cli_other_bot', service: 'feishu' },
    });
    await handling;
    wsClient.setBotOpenIdForTest(BOT);
    const connecting = wsClient.start(
      { appId: 'cli_other_bot', appSecret: 'secret', service: 'feishu' },
      { announceLifecycle: false },
    );
    mocks.options.at(-1)?.onReady?.();
    await connecting;

    expect(events).toHaveLength(0);
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('abandons the topic lease in the stop/start gap during account replacement', async () => {
    const events = collectMessages();
    let releaseDownload: ((value: {
      attachments: IMMessageEvent['attachments'];
      unsupported: IMMessageEvent['unsupported'];
    }) => void) | undefined;
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    mocks.getBoundClient.mockReturnValue({});
    mocks.downloadAttachments.mockImplementationOnce(() => {
      downloadStarted();
      return new Promise((resolve) => {
        releaseDownload = resolve;
      });
    });
    await connect();
    const handling = mocks.eventHandlers['im.message.receive_v1'](
      groupTopicImageMessage('omt_existing', 'om_topic_img_switch_gap'),
    );
    await started;
    // unbindClient 位于 stop() 尾部；这里同步放行下载，让旧 handler 恰好在
    // currentBotAppId 已清空、新账号尚未装入的微任务空窗恢复。
    mocks.unbindClient.mockImplementationOnce(() => {
      releaseDownload?.({
        attachments: [
          {
            kind: 'image',
            absPath: '/tmp/cindy-feishu-topic.png',
            originalName: 'topic.png',
            mimeType: 'image/png',
          },
        ],
        unsupported: [],
      });
    });
    wsClient.setBotOpenIdForTest(BOT);
    const connecting = wsClient.start(
      { appId: 'cli_other_bot', appSecret: 'secret', service: 'feishu' },
      { announceLifecycle: false },
    );
    await vi.waitFor(() => expect(mocks.options).toHaveLength(2));
    mocks.options.at(-1)?.onReady?.();
    await connecting;
    await handling;

    expect(events).toHaveLength(0);
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('keeps the topic lease across same-account reconnect during attachment download', async () => {
    const events = collectMessages();
    let releaseDownload: ((value: {
      attachments: IMMessageEvent['attachments'];
      unsupported: IMMessageEvent['unsupported'];
    }) => void) | undefined;
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    mocks.getBoundClient.mockReturnValue({});
    mocks.downloadAttachments.mockImplementationOnce(() => {
      downloadStarted();
      return new Promise((resolve) => {
        releaseDownload = resolve;
      });
    });
    await connect();
    const handling = mocks.eventHandlers['im.message.receive_v1'](
      groupTopicImageMessage('omt_existing', 'om_topic_img_reconnect'),
    );
    await started;
    mocks.unbindClient.mockImplementationOnce(() => {
      releaseDownload?.({
        attachments: [
          {
            kind: 'image',
            absPath: '/tmp/cindy-feishu-topic.png',
            originalName: 'topic.png',
            mimeType: 'image/png',
          },
        ],
        unsupported: [],
      });
    });
    await wsClient.stop({
      announceOffline: false,
      reason: 'test-reconnect',
      nextAccount: credentials,
    });
    await handling;
    await connect();

    expect(events).toHaveLength(0);
    expect(pendingTopicLeaseCountForTest()).toBe(1);
  });

  it('abandons the topic lease when credentials are cleared during attachment download', async () => {
    const events = collectMessages();
    let releaseDownload: ((value: {
      attachments: IMMessageEvent['attachments'];
      unsupported: IMMessageEvent['unsupported'];
    }) => void) | undefined;
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    mocks.getBoundClient.mockReturnValue({});
    mocks.downloadAttachments.mockImplementationOnce(() => {
      downloadStarted();
      return new Promise((resolve) => {
        releaseDownload = resolve;
      });
    });
    await connect();
    const handling = mocks.eventHandlers['im.message.receive_v1'](
      groupTopicImageMessage('omt_existing', 'om_topic_img_logout'),
    );
    await started;
    mocks.unbindClient.mockImplementationOnce(() => {
      releaseDownload?.({
        attachments: [
          {
            kind: 'image',
            absPath: '/tmp/cindy-feishu-topic.png',
            originalName: 'topic.png',
            mimeType: 'image/png',
          },
        ],
        unsupported: [],
      });
    });
    await wsClient.stop({
      announceOffline: false,
      reason: 'test-credentials-cleared',
      discardPendingTopicLeases: true,
    });
    await handling;

    expect(events).toHaveLength(0);
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('late topic after the cache TTL still takes over while the flat route is uncommitted', async () => {
    vi.useFakeTimers();
    let releaseOpenThread: ((value: { kind: 'opened'; messageId: string; threadId: string }) => void) | undefined;
    mocks.openThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOpenThread = resolve;
        }),
    );
    mocks.recallOwnMessage.mockResolvedValue(true);
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('迟到话题', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000000000';
    topic.message.message_id = 'om_topic_late';
    const flat = groupMainFlowMessage('迟到话题', 'om_flat_late') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000000000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(25_001);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    expect(releaseOpenThread).toBeDefined();
    releaseOpenThread?.({ kind: 'opened', messageId: 'om_bot_opener', threadId: 'omt_bot' });
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0].finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
      confirmed: true,
    });
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(mocks.recallOwnMessage).toHaveBeenCalledWith('om_bot_opener');
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
  });

  it('retries a late-takeover opener recall when Feishu returns a business rejection', async () => {
    vi.useFakeTimers();
    let releaseOpenThread:
      | ((value: { kind: 'opened'; messageId: string; threadId: string }) => void)
      | undefined;
    mocks.openThread
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOpenThread = resolve;
          }),
      )
      .mockResolvedValueOnce({
        kind: 'opened',
        messageId: 'om_bot_opener_retry',
        threadId: 'omt_bot_retry',
      });
    mocks.recallOwnMessage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('迟到话题撤回重试', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000009000';
    topic.message.message_id = 'om_topic_recall_retry';
    const flat = groupMainFlowMessage('迟到话题撤回重试', 'om_flat_recall_retry') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000009000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    expect(releaseOpenThread).toBeDefined();
    releaseOpenThread?.({
      kind: 'opened',
      messageId: 'om_bot_opener_retry',
      threadId: 'omt_bot_retry',
    });
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_existing');
    expect(mocks.recallOwnMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recallOwnMessage).toHaveBeenLastCalledWith('om_bot_opener_retry');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(mocks.openThread).toHaveBeenLastCalledWith('om_flat_recall_retry');
    expect(mocks.recallOwnMessage).toHaveBeenCalledTimes(2);
    expect(mocks.recallOwnMessage).toHaveBeenLastCalledWith('om_bot_opener_retry');
    expect(events).toHaveLength(1);
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
  });

  it('does not revive a pending takeover recall after credentials are cleared', async () => {
    vi.useFakeTimers();
    let releaseOpenThread:
      | ((value: { kind: 'opened'; messageId: string; threadId: string }) => void)
      | undefined;
    let releaseRecall: ((value: boolean) => void) | undefined;
    mocks.openThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOpenThread = resolve;
        }),
    );
    mocks.recallOwnMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRecall = resolve;
        }),
    );
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('撤回在途时清凭证', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000010000';
    topic.message.message_id = 'om_topic_clear_during_recall';
    const flat = groupMainFlowMessage('撤回在途时清凭证', 'om_flat_clear_during_recall') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000010000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    expect(releaseOpenThread).toBeDefined();
    releaseOpenThread?.({
      kind: 'opened',
      messageId: 'om_bot_clear_during_recall',
      threadId: 'omt_bot_clear_during_recall',
    });
    await Promise.resolve();
    expect(releaseRecall).toBeDefined();

    await wsClient.stop({ announceOffline: false, reason: 'clear-credentials' });
    wsClient.clearOrphanRetriesForCredentialClear();
    releaseRecall?.(false);
    await flatHandling;

    await connect();
    await vi.advanceTimersByTimeAsync(10_000 + 30_000 + 90_000 + 1_000);

    expect(events).toHaveLength(1);
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(mocks.recallOwnMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
  });

  it('committed unpaired flat still mirrors parent chat when a late topic is suppressed', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockResolvedValueOnce({
      kind: 'opened',
      messageId: 'om_bot_committed',
      threadId: 'omt_bot_committed',
    });
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('已提交后迟到话题', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000007000';
    topic.message.message_id = 'om_topic_after_commit';
    const flat = groupMainFlowMessage('已提交后迟到话题', 'om_flat_committed') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000007000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_bot_committed');
    expect(events[0]?.finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
    });
    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith(
      'g/oc_chat1/omt_bot_committed',
      'om_bot_committed',
      'om_flat_committed',
    );

    await mocks.eventHandlers['im.message.receive_v1'](topic);

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_bot_committed');
    expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('recovered unconfirmed flat keeps its mirror when the native topic arrives afterward', async () => {
    vi.useFakeTimers();
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockResolvedValueOnce({
        kind: 'opened',
        messageId: 'om_bot_recovered_committed',
        threadId: 'omt_bot_recovered_committed',
      });
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('恢复提交后迟到话题', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000008000';
    topic.message.message_id = 'om_topic_after_recovered_commit';
    const flat = groupMainFlowMessage(
      '恢复提交后迟到话题',
      'om_flat_recovered_committed',
    ) as { message: Record<string, unknown> };
    flat.message.create_time = '1788000008000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await flatHandling;
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_bot_recovered_committed');
    expect(events[0]?.finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
    });

    await mocks.eventHandlers['im.message.receive_v1'](topic);

    expect(events).toHaveLength(1);
    expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('orphaned unpaired flat stays takeable so a late topic still dispatches', async () => {
    vi.useFakeTimers();
    mocks.openThread.mockResolvedValueOnce({
      kind: 'orphaned',
      openerMessageId: 'om_orphan_opener',
    });
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('孤儿后迟到话题', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000003000';
    topic.message.message_id = 'om_topic_after_orphan';
    const flat = groupMainFlowMessage('孤儿后迟到话题', 'om_flat_after_orphan') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000003000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await flatHandling;

    expect(events).toHaveLength(0);
    expect(mocks.replyText).toHaveBeenCalledWith('om_orphan_opener', expect.any(String));

    await mocks.eventHandlers['im.message.receive_v1'](topic);

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0]?.messageId).toBe('om_topic_after_orphan');
    expect(events[0]?.finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
      confirmed: true,
    });
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
  });

  it('unconfirmed unpaired flat stays takeable so a late topic still dispatches', async () => {
    vi.useFakeTimers();
    mocks.openThread
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockResolvedValueOnce({
        kind: 'opened',
        messageId: 'om_recovered_after_unconfirmed',
        threadId: 'omt_bot_unconfirmed',
      });
    mocks.recallOwnMessage.mockResolvedValue(true);
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('未确认后迟到话题', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000005000';
    topic.message.message_id = 'om_topic_after_unconfirmed';
    const flat = groupMainFlowMessage('未确认后迟到话题', 'om_flat_after_unconfirmed') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000005000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await flatHandling;

    expect(events).toHaveLength(0);

    await mocks.eventHandlers['im.message.receive_v1'](topic);

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0]?.messageId).toBe('om_topic_after_unconfirmed');
    expect(events[0]?.finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
      confirmed: true,
    });
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(mocks.recallOwnMessage).toHaveBeenCalledWith('om_recovered_after_unconfirmed');
    expect(events).toHaveLength(1);
  });

  it('late topic takeover during orphaned openThread recalls the opener without a second turn', async () => {
    vi.useFakeTimers();
    let releaseOpenThread: ((value: { kind: 'orphaned'; openerMessageId: string }) => void) | undefined;
    mocks.openThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOpenThread = resolve;
        }),
    );
    mocks.recallOwnMessage.mockResolvedValue(true);
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('孤儿途中接管', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000004000';
    topic.message.message_id = 'om_topic_during_orphan';
    const flat = groupMainFlowMessage('孤儿途中接管', 'om_flat_during_orphan') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000004000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    expect(releaseOpenThread).toBeDefined();
    releaseOpenThread?.({ kind: 'orphaned', openerMessageId: 'om_orphan_during' });
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_existing');
    expect(mocks.recallOwnMessage).toHaveBeenCalledWith('om_orphan_during');
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
  });

  it('late topic takeover recovers unconfirmed opener uuid and recalls it without a second turn', async () => {
    vi.useFakeTimers();
    let releaseOpenThread: ((value: { kind: 'unconfirmed' }) => void) | undefined;
    mocks.openThread
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOpenThread = resolve;
          }),
      )
      .mockResolvedValueOnce({
        kind: 'opened',
        messageId: 'om_recovered_opener',
        threadId: 'omt_bot',
      });
    mocks.recallOwnMessage.mockResolvedValue(true);
    const events = collectMessages();
    await connect();
    const topic = groupTopicMessage('迟到话题未确认', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000001000';
    topic.message.message_id = 'om_topic_late_unconfirmed';
    const flat = groupMainFlowMessage('迟到话题未确认', 'om_flat_late_unconfirmed') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000001000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    await mocks.eventHandlers['im.message.receive_v1'](topic);
    expect(releaseOpenThread).toBeDefined();
    releaseOpenThread?.({ kind: 'unconfirmed' });
    await flatHandling;

    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
    expect(mocks.recallOwnMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
    expect(mocks.recallOwnMessage).toHaveBeenCalledWith('om_recovered_opener');
    expect(events).toHaveLength(1);
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
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

  it('openThread 在途换代后不提交双投路由、不用新连接撤回旧开场白', async () => {
    vi.useFakeTimers();
    let resolveOpen!: (value: {
      kind: 'opened';
      messageId: string;
      threadId: string;
    }) => void;
    mocks.openThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const events = collectMessages();
    await connect();
    const flat = groupMainFlowMessage('换代中的副本', 'om_flat_stale') as {
      message: Record<string, unknown>;
    };
    flat.message.create_time = '1788000000000';

    const flatHandling = mocks.eventHandlers['im.message.receive_v1'](flat);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveOpen).toBeDefined();

    await wsClient.stop({ announceOffline: false, reason: 'same-account-reconnect' });
    await connect();

    resolveOpen({ kind: 'opened', messageId: 'om_stale_opener', threadId: 'omt_stale' });
    await flatHandling;

    expect(events).toHaveLength(0);
    expect(mocks.recallOwnMessage).not.toHaveBeenCalled();
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();

    const topic = groupTopicMessage('换代中的副本', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    topic.message.create_time = '1788000000000';
    topic.message.message_id = 'om_topic_after_reconnect';
    await mocks.eventHandlers['im.message.receive_v1'](topic);

    expect(events).toHaveLength(1);
    expect(events[0]?.senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0]?.finalReplyMirror).toEqual({
      kind: 'parent-chat',
      chatId: 'oc_chat1',
      idempotencyKey: expect.any(String),
      accountEpoch: 1,
      confirmed: true,
    });
    vi.useRealTimers();
  });
});
