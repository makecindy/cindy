/**
 * 卡片回调入站: 白名单门 + 群卡片 senderId 归一成发卡 lane(消息侧同键,
 * /ctr 锁与接管 binding 才能对齐);私聊卡保持 operator.open_id。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { feishuEvents } from '../events.js';
import type { IMCardActionEvent } from '../../types.js';

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
  getAccountEpoch: () => 1,
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
  appId: 'cli_card_test',
  appSecret: 'secret',
  service: 'feishu' as const,
};

const OWNER = 'ou_owner';

function cardActionPayload(overrides: {
  operatorOpenId?: string;
  messageId?: string;
  chatId?: string;
  buttonId?: string;
} = {}) {
  return {
    operator: { open_id: overrides.operatorOpenId ?? OWNER },
    context: {
      open_message_id: overrides.messageId ?? 'om_card1',
      open_chat_id: overrides.chatId ?? 'oc_chat1',
    },
    action: {
      value: { id: overrides.buttonId ?? 'control:exit', botAppId: 'cli_card_test' },
    },
  };
}

async function connect(): Promise<void> {
  const connecting = wsClient.start(credentials, { announceLifecycle: false });
  mocks.options.at(-1)?.onReady?.();
  await connecting;
}

function collectCardActions(): IMCardActionEvent[] {
  const events: IMCardActionEvent[] = [];
  feishuEvents.on('cardAction', (e) => events.push(e));
  return events;
}

/** handleCardAction 用 setImmediate 延迟一 tick 再 emit, 等它落地。 */
async function settleImmediate(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-reset' });
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  feishuEvents.removeAllListeners('cardAction');
  mocks.firstAllowed.mockReturnValue(OWNER);
  mocks.checkOwner.mockImplementation((id: string) => id === OWNER);
  mocks.resolveCardLane.mockReturnValue(null);
});

afterEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-cleanup' });
  feishuEvents.removeAllListeners('cardAction');
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

describe('feishu card action inbound', () => {
  it('normalizes group card senderId to the registered lane', async () => {
    mocks.resolveCardLane.mockReturnValue('g/oc_chat1/omt_t1');
    await connect();
    const events = collectCardActions();
    await mocks.eventHandlers['card.action.trigger']!(cardActionPayload());
    await settleImmediate();

    expect(mocks.resolveCardLane).toHaveBeenCalledWith('om_card1', 'oc_chat1');
    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe('g/oc_chat1/omt_t1');
    expect(events[0]!.buttonId).toBe('control:exit');
    expect(events[0]!.payload).toEqual({ botAppId: 'cli_card_test' });
  });

  it('keeps operator open_id when no lane is registered (p2p / owner DM cards)', async () => {
    await connect();
    const events = collectCardActions();
    await mocks.eventHandlers['card.action.trigger']!(cardActionPayload());
    await settleImmediate();

    expect(events).toHaveLength(1);
    expect(events[0]!.senderId).toBe(OWNER);
  });

  it('drops card actions from non-whitelisted operators', async () => {
    mocks.resolveCardLane.mockReturnValue('g/oc_chat1/omt_t1');
    await connect();
    const events = collectCardActions();
    await mocks.eventHandlers['card.action.trigger']!(
      cardActionPayload({ operatorOpenId: 'ou_stranger' }),
    );
    await settleImmediate();

    expect(events).toHaveLength(0);
  });
});
