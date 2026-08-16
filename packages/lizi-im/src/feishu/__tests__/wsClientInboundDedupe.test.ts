/**
 * 入站消息去重不变量 —— 飞书事件「至少送达一次」，同一条消息可能被推两遍。
 *
 * 背景(2026-08-14 14:37 实测): 本机网络抖动 + relay 断线重连期间，飞书没等到
 * 我们的 ACK，把同一条群话题消息原样重推了一次。当时入站层没有任何去重，重推
 * 被当成新消息跑了完整一轮 turn —— 话题里只有一条用户提问，却出现两条 bot 回复，
 * 还多花了一次模型调用。
 *
 * 因此这里锁三条:
 *   1. 同一个 message_id 第二次到达 ⇒ 不 emit、不产生任何副作用(不开话题);
 *   2. 用户真的重复发一遍(不同 message_id、正文相同) ⇒ 照常处理，不能误杀;
 *   3. 去重账本跨 stop/start 保留 —— 重推恰恰发生在断连重连前后，那时清空账本
 *      等于闸门在最需要它的时刻失效。
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
  openThread: vi.fn<() => Promise<{ messageId: string; threadId: string } | null>>(async () => ({
    messageId: 'om_opener',
    threadId: 'omt_new',
  })),
  pushReplyAnchor: vi.fn(),
  pushPatchableOpener: vi.fn(),
  resolveCardLane: vi.fn<(messageId: string, chatId: string) => string | null>(() => null),
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
  appId: 'cli_dedupe_test',
  appSecret: 'secret',
  service: 'feishu' as const,
};

const OWNER = 'ou_owner';
const BOT = 'ou_bot';

/** 话题内消息 —— 走最短路径(不开话题), 便于单独观察去重行为。 */
function topicMessage(text: string, messageId: string): unknown {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      thread_id: 'omt_existing',
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }],
    },
  };
}

function p2pMessage(text: string, messageId: string): unknown {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: messageId,
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
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
  wsClient.resetInboundDedupeForTest();
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
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

describe('feishu inbound message dedupe', () => {
  it('同一个 message_id 重推 ⇒ 只处理一次', async () => {
    const events = collectMessages();
    await connect();

    const raw = topicMessage('出行要注意什么吗', 'om_dup');
    await mocks.eventHandlers['im.message.receive_v1'](raw);
    await mocks.eventHandlers['im.message.receive_v1'](raw);

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('出行要注意什么吗');
  });

  it('重推不留任何副作用: 群主流的重推不会再开一次话题', async () => {
    const events = collectMessages();
    await connect();

    const mainFlow = {
      sender: { sender_id: { open_id: OWNER } },
      message: {
        message_id: 'om_mainflow_dup',
        chat_id: 'oc_chat1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '开个话题' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }],
      },
    };
    await mocks.eventHandlers['im.message.receive_v1'](mainFlow);
    await mocks.eventHandlers['im.message.receive_v1'](mainFlow);

    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('用户真的重复发一遍(不同 message_id、正文相同) ⇒ 两条都处理', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](topicMessage('同一句话', 'om_a'));
    await mocks.eventHandlers['im.message.receive_v1'](topicMessage('同一句话', 'om_b'));

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.text)).toEqual(['同一句话', '同一句话']);
  });

  it('私聊同样去重', async () => {
    const events = collectMessages();
    await connect();

    const raw = p2pMessage('在吗', 'om_dm_dup');
    await mocks.eventHandlers['im.message.receive_v1'](raw);
    await mocks.eventHandlers['im.message.receive_v1'](raw);

    expect(events).toHaveLength(1);
  });

  /**
   * 关键回归: 重推的高发时刻就是断连重连前后(ACK 丢在断链里)。若账本随
   * stop/start 清空, 闸门恰好在最需要它的时候失效。
   */
  it('账本跨 stop/start 保留 —— 重连后的重推照样被挡', async () => {
    const events = collectMessages();
    await connect();

    const raw = topicMessage('断线前发的', 'om_across_restart');
    await mocks.eventHandlers['im.message.receive_v1'](raw);
    expect(events).toHaveLength(1);

    await wsClient.stop({ announceOffline: false, reason: 'test-reconnect' });
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](raw);
    expect(events).toHaveLength(1);
  });

  it('并发到达的两个同 id 帧只有一个能认领(认领是同步的)', async () => {
    const events = collectMessages();
    await connect();

    const raw = topicMessage('并发重推', 'om_concurrent');
    await Promise.all([
      mocks.eventHandlers['im.message.receive_v1'](raw),
      mocks.eventHandlers['im.message.receive_v1'](raw),
    ]);

    expect(events).toHaveLength(1);
  });
});
