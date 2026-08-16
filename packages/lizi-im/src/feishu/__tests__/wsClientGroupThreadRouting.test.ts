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
  // 返回 null = 开话题失败(降级回群 lane), 单测按用例覆盖。
  openThread: vi.fn<
    () => Promise<{ messageId: string; threadId: string } | null>
  >(async () => ({ messageId: 'om_opener', threadId: 'omt_new' })),
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

describe('feishu group thread routing', () => {
  it('群主流 @bot 恒开新话题, 以新话题 lane 路由, 锚点 = 开场白消息', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开个新话题'));

    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1');
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
    expect(mocks.pushPatchableOpener).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
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
      .mockResolvedValueOnce({ messageId: 'om_opener1', threadId: 'omt_a' })
      .mockResolvedValueOnce({ messageId: 'om_opener2', threadId: 'omt_b' });
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
    mocks.openThread.mockResolvedValueOnce(null);
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开话题失败'));

    expect(events[0].senderId).toBe('g/oc_chat1');
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1', 'om_msg1');
    expect(events[0].groupContextLane).toBeUndefined();
  });
});
