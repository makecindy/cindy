/**
 * Main-timeline questions stay in the group lane; topic questions stay in their
 * own topic lane. Duplicate deliveries elect a single route before queueing an
 * anchor. Account changes discard pending leases, same-account reconnects keep them.
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
  // Guard against accidentally creating topics for incoming messages.
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

vi.doMock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
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
  it('群主流 @bot 留在群主流, 锚点 = 触发消息', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开个新话题'));

    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1', 'om_msg1');
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1');
    // Context follows the original main-timeline lane.
    expect(events[0].groupContextLane).toBeUndefined();
    expect(events[0].text).toBe('开个新话题');
    // Events have stable IDs but no display names; the host uses chatId fallback.
    expect(events[0].interactionSource).toBeUndefined();
    expect(events[0].chatId).toBe('oc_chat1');
  });

  it('successive main-timeline mentions share the group lane without entering a topic', async () => {
    const events = collectMessages();
    await connect();
    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('第一句', 'om_first'));
    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('第二句', 'om_second'));
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(events.map((e) => e.senderId)).toEqual(['g/oc_chat1', 'g/oc_chat1']);
    expect(mocks.pushReplyAnchor.mock.calls).toEqual([
      ['g/oc_chat1', 'om_first'], ['g/oc_chat1', 'om_second'],
    ]);
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

  it('releases the topic lease when a topic delivery has nothing to relay', async () => {
    const events = collectMessages();
    await connect();
    // image 消息缺 image_key → 解析为空; @bot 的 mention 仍在, 能走到话题租约。
    const empty = groupTopicImageMessage('omt_existing', 'om_empty_image') as {
      message: Record<string, unknown>;
    };
    empty.message.content = JSON.stringify({});
    empty.message.create_time = '1788000000000';

    await mocks.eventHandlers['im.message.receive_v1'](empty);

    expect(events).toHaveLength(0);
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('纯 @bot 的话题消息仍召唤一轮，正文与召唤事实分开', async () => {
    const events = collectMessages();
    await connect();
    const bare = groupTopicMessage('@_user_1', 'omt_existing') as {
      message: Record<string, unknown>;
    };
    bare.message.create_time = '1788000000000';
    bare.message.message_id = 'om_bare_mention';

    await mocks.eventHandlers['im.message.receive_v1'](bare);

    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
    expect(events[0]).toMatchObject({ text: '', invoked: true });
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(pendingTopicLeaseCountForTest()).toBe(0);
  });

  it('群主流纯 @bot 在群主流起一轮; @ 在句尾时只剥掉 @bot', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](
      groupMainFlowMessage('@_user_1', 'om_bare_main'),
    );
    await mocks.eventHandlers['im.message.receive_v1'](
      groupMainFlowMessage('重新想一想 @_user_1', 'om_tail_main'),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ text: '', invoked: true });
    expect(events[1].text).toBe('重新想一想');
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(events[0].senderId).toBe('g/oc_chat1');
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

});
