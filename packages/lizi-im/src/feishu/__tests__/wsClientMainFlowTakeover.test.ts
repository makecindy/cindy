/**
 * 群主流消息的 /ctr 接管 lane 覆写钩子。
 *
 * 语义: host 注入的钩子返回接管 lane 时, 群主流消息不再 openThread 开新
 * 话题, 直接以接管 lane 路由(senderId = 接管 lane, 出站回复进接管话题);
 * 上下文取数 lane(groupContextLane)仍指向群主流。钩子返回 null / 未注入 /
 * 话题消息 = 默认行为。
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
  openThread: vi.fn(async () => ({ messageId: 'om_opener', threadId: 'omt_new' })),
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

function groupMainFlowMessage(text: string): unknown {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: 'om_msg1',
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
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('message');
  wsClient.setGroupMainFlowLaneOverride(null);
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

describe('feishu group main-flow takeover lane override', () => {
  it('钩子命中时不开新话题, 消息以接管 lane 路由, 回复锚点用话题内消息', async () => {
    wsClient.setGroupMainFlowLaneOverride((args) => {
      expect(args.chatId).toBe('oc_chat1');
      expect(args.botAppId).toBe('cli_takeover_test');
      return { laneUserId: 'g/oc_chat1/omt_ctr', replyAnchorMessageId: 'om_card_ctr' };
    });
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('接着聊'));

    expect(mocks.openThread).not.toHaveBeenCalled();
    // 锚点必须是话题内消息(/ctr 控制卡), 不能是群主流触发消息 — 否则
    // 回复会被打进群主流(outbound fail-closed 不变量)。
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_ctr', 'om_card_ctr');
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalledWith('g/oc_chat1/omt_ctr', 'om_msg1');
    expect(mocks.pushPatchableOpener).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_ctr');
    expect(events[0].groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
    expect(events[0].text).toBe('接着聊');
  });

  it('钩子未给锚点时也不 push 群主流触发消息(复用该 lane 持有的话题内锚点)', async () => {
    wsClient.setGroupMainFlowLaneOverride(() => ({ laneUserId: 'g/oc_chat1/omt_ctr' }));
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('接着聊'));

    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.pushReplyAnchor).not.toHaveBeenCalled();
    expect(events[0].senderId).toBe('g/oc_chat1/omt_ctr');
    expect(events[0].groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
  });

  it('钩子返回 null 时保持默认开话题行为', async () => {
    wsClient.setGroupMainFlowLaneOverride(() => null);
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('开个新话题'));

    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1');
    expect(events).toHaveLength(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_new');
    expect(events[0].groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
  });

  it('未注入钩子 = 默认开话题行为', async () => {
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('普通消息'));

    expect(mocks.openThread).toHaveBeenCalledTimes(1);
    expect(events[0].senderId).toBe('g/oc_chat1/omt_new');
  });

  it('话题内消息不咨询钩子', async () => {
    const hook = vi.fn(() => ({ laneUserId: 'g/oc_chat1/omt_ctr' }));
    wsClient.setGroupMainFlowLaneOverride(hook);
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](
      groupTopicMessage('话题里回复', 'omt_existing'),
    );

    expect(hook).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(events[0].senderId).toBe('g/oc_chat1/omt_existing');
  });

  it('钩子返回非法 lane(非 g/ 前缀)时原样透传, 路由裁决交给下游', async () => {
    // 钩子的返回值由 host 保证形状; transport 不做二次校验, 只透传。
    wsClient.setGroupMainFlowLaneOverride(() => ({ laneUserId: 'g/oc_chat1' }));
    const events = collectMessages();
    await connect();

    await mocks.eventHandlers['im.message.receive_v1'](groupMainFlowMessage('群 lane 接管'));

    expect(events[0].senderId).toBe('g/oc_chat1');
  });
});
