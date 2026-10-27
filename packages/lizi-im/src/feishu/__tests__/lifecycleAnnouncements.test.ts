/**
 * Regression: a secondary socket shutting down falsely reports the shared bot
 * offline. Exercises real FeishuIM init/dispose/inbound/reply with an SDK fake;
 * existing conflict tests use one scope and cannot observe two instances.
 * Minimal input: two scopes with the same bot credentials, then secondary exit.
 * Unit tier, no network or disk; standalone wall time: 407ms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMHost } from '../../types.js';
import { createFeishuIM, type FeishuIM } from '../index.js';
import { messages } from '../messages.js';
import { runInScope } from '../moduleScope.js';
import { stop } from '../wsClient.js';

type Handlers = Record<string, (data: unknown) => Promise<unknown>>;

const sdk = vi.hoisted(() => ({
  sockets: [] as Array<{ handlers: Handlers; close: ReturnType<typeof vi.fn> }>,
  create: vi.fn<(request: { data: { content: string } }) => Promise<{ data: { message_id: string } }>>(async () => ({
    data: { message_id: 'om_sent' },
  })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  LoggerLevel: { info: 'info' },
  Client: class {
    im = { v1: { message: { create: sdk.create } } };
  },
  EventDispatcher: class {
    handlers: Handlers = {};
    register(handlers: Handlers) {
      this.handlers = handlers;
      return this;
    }
  },
  WSClient: class {
    close = vi.fn();
    constructor(private options: { onReady(): void }) {}
    getConnectionStatus() {
      return { state: 'connected' };
    }
    async start({ eventDispatcher }: { eventDispatcher: { handlers: Handlers } }) {
      sdk.sockets.push({ handlers: eventDispatcher.handlers, close: this.close });
      this.options.onReady();
    }
  },
}));

const instances: FeishuIM[] = [];

function makeHost(prefix: string, enabled = true): IMHost {
  const values = new Map([
    [prefix + 'feishu_bot_app_id', 'cli_shared_bot'],
    [prefix + 'feishu_bot_app_secret', 'test-secret'],
    [prefix + 'feishu_bot_owner_open_id', 'ou_owner'],
    [prefix + 'feishu_bot_lifecycle_announcement', String(enabled)],
  ]);
  return {
    secrets: {
      read: (key) => values.get(key) ?? null,
      write: vi.fn((key, value) => {
        values.set(key, value);
        return true;
      }),
      remove: vi.fn(),
      isAvailable: () => true,
    },
    ipc: {
      handle: vi.fn(),
      broadcast: vi.fn(),
      throwIpcError: () => { throw new Error('invalid'); },
    },
    paths: { feishuMediaDir: '' },
    httpPostForm: vi.fn(async () => { throw new Error('Unexpected host HTTP request'); }),
    createLogger: () => ({
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    }),
  };
}

async function connect(host: IMHost, options: Parameters<typeof createFeishuIM>[1]) {
  const im = createFeishuIM(host, options);
  instances.push(im);
  await im.init();
  expect(im.getStatus().kind).toBe('connected');
  return im;
}

function sentTexts() {
  return sdk.create.mock.calls.map(([request]) => JSON.parse(request.data.content).text);
}

async function receive(socket: number, messageId: string) {
  await sdk.sockets[socket].handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_owner' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hihi' }),
    },
  });
}

afterEach(async () => {
  for (const im of instances.splice(0)) await im.dispose();
  sdk.sockets.length = 0;
  sdk.create.mockClear();
});

describe('Feishu lifecycle announcements across shared-profile instances', () => {
  it.each(['', 'companion:'])('secondary exit keeps primary online without a false notice (prefix=%s)', async (secretKeyPrefix) => {
    const host = makeHost(secretKeyPrefix);
    const options = { secretKeyPrefix, ipc: false };
    const primary = await connect(host, options);
    const secondary = await connect(host, { ...options, shouldAnnounceLifecycle: () => false });
    await secondary.dispose();
    expect(sdk.sockets[1].close).toHaveBeenCalledOnce();
    expect(primary.getStatus().kind).toBe('connected');
    expect(sentTexts()).toEqual([messages.lifecycle.online]);

    const onMessage = vi.fn();
    primary.onMessage(onMessage);
    await receive(0, 'om_after_secondary_exit');
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'hihi' }));
    await primary.sendText('ou_owner', 'reply');
    await primary.dispose();
    expect(sentTexts()).toEqual([messages.lifecycle.online, 'reply', messages.lifecycle.offline]);
    expect(host.secrets.write).not.toHaveBeenCalled();
  });

  it.each(['', 'companion:'])('secondary logical stop and reconnect do not leave an offline-history warning (prefix=%s)', async (secretKeyPrefix) => {
    const host = makeHost(secretKeyPrefix);
    const secondary = await connect(host, { secretKeyPrefix, ipc: false, shouldAnnounceLifecycle: () => false });
    const onMessage = vi.fn();
    secondary.onMessage(onMessage);
    await receive(0, 'om_secondary');
    await secondary.sendText('ou_owner', 'secondary reply');
    // A logical stop reaches announceLifecycle('offline'); reconnect alone does not.
    await runInScope(secondary.scope, () => stop({ reason: 'test-logical-stop' }));
    expect(sdk.sockets[0].close).toHaveBeenCalledOnce();
    expect(secondary.getStatus().kind).toBe('idle');
    await secondary.reconnect();
    await receive(1, 'om_secondary_reconnected');
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(sentTexts()).not.toContain(messages.lifecycle.offlineNotice);
    await secondary.dispose();
    expect(sentTexts()).toEqual(['secondary reply']);
    expect(host.secrets.write).not.toHaveBeenCalled();
  });

  // 关闭生命周期通知后，停止再重连不应在下一条私聊里补发「我之前离线过」提醒；
  // 停止时还开着、随后才关闭的情况也一样。
  it.each([
    ['disabled before stop', false],
    ['disabled after stop', true],
  ] as const)('does not send the offline-history notice once announcements are off (%s)', async (_case, enabledAtStop) => {
    const host = makeHost('', enabledAtStop);
    const primary = await connect(host, { ipc: false, shouldAnnounceLifecycle: () => true });
    await runInScope(primary.scope, () => stop({ reason: 'test-logical-stop' }));
    if (enabledAtStop) primary.setLifecycleAnnouncement(false);
    await primary.reconnect();
    await receive(1, 'om_after_disabled_reconnect');
    expect(sentTexts()).not.toContain(messages.lifecycle.offlineNotice);
  });

  it('primary still respects a saved disabled announcement preference', async () => {
    const host = makeHost('', false);
    const primary = await connect(host, { ipc: false, shouldAnnounceLifecycle: () => true });
    await primary.dispose();
    expect(sentTexts()).toEqual([]);
    expect(host.secrets.write).not.toHaveBeenCalled();
  });
});
