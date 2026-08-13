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
    async (): Promise<{ messageId: string; threadId: string } | null> => ({
      messageId: 'om_opener',
      threadId: 'omt_new',
    }),
  ),
  pushReplyAnchor: vi.fn(),
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

    expect(mocks.openThread).toHaveBeenCalledWith('om_msg1', expect.any(String));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.senderId).toBe('g/oc_chat1/omt_new');
    expect(event.chatId).toBe('oc_chat1');
    expect(event.text).toBe('帮我看看');
    expect(event.speaker).toEqual({ id: OWNER, name: '', isOwner: true });
    // 锚点是开场白消息(话题内合法锚点), 不是触发消息。
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1/omt_new', 'om_opener');
    // 路由进新话题 lane, 但上下文取数 lane 仍是群主流(新话题是空的)。
    expect(event.groupContextLane).toEqual({ chatId: 'oc_chat1', threadId: '' });
  });

  it('falls back to the plain group lane when thread creation fails', async () => {
    mocks.openThread.mockResolvedValueOnce(null);
    await connect();
    const events = collectEvents();
    await mocks.eventHandlers['im.message.receive_v1']!(groupMessage({}));

    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe('g/oc_chat1');
    expect(events[0]!.groupContextLane).toBeUndefined();
    expect(mocks.pushReplyAnchor).toHaveBeenCalledWith('g/oc_chat1', 'om_msg1');
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
