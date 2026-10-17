/**
 * DiscordIM 的多实例契约: 伙伴自有连接带凭证键名前缀、不注册设置卡 IPC、不广播状态;
 * setConfig / disconnect 作为公开方法可被宿主按实例调用。
 */
import { describe, expect, it, vi } from 'vitest';

import type { IMHost, IMStatus } from '../../types.js';
import { DiscordIM } from '../index.js';
import type { DiscordGateway, DiscordGatewayEvents } from '../gateway.js';

function makeHost() {
  const secrets = new Map<string, string>();
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const host: IMHost = {
    secrets: {
      write: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      read: (key) => secrets.get(key) ?? null,
      remove: (key) => void secrets.delete(key),
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: (channel, payload) => void broadcasts.push({ channel, payload }),
    },
    paths: { feishuMediaDir: '/unused' },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, handlers, broadcasts };
}

function fakeGateway(): { factory: (ev: DiscordGatewayEvents) => DiscordGateway; connect: ReturnType<typeof vi.fn> } {
  const connect = vi.fn<(token: string) => Promise<void>>(async () => undefined);
  const factory = (ev: DiscordGatewayEvents): DiscordGateway => {
    let connected = false;
    return {
      async connect(token: string) {
        await connect(token);
        connected = true;
        ev.onStatus({ kind: 'connected', appId: 'Mia#1234' } satisfies IMStatus);
      },
      async destroy() {
        connected = false;
      },
      client: null,
      get appId() {
        return connected ? '9001' : '';
      },
      get botTag() {
        return connected ? 'Mia#1234' : '';
      },
    };
  };
  return { factory, connect };
}

describe('DiscordIM teammate instance', () => {
  it('reads and writes credentials under its prefix, skips settings IPC and broadcasts', async () => {
    const { host, secrets, handlers, broadcasts } = makeHost();
    const gateway = fakeGateway();
    const im = new DiscordIM(host, { gatewayFactory: gateway.factory, secretKeyPrefix: 'bot-im-abc-', ipc: false });
    im.registerIpc();
    expect(handlers.size).toBe(0);
    await im.init();
    expect(im.getStatus()).toEqual({ kind: 'idle' });

    const state = await im.setConfig({ token: 'MTAw.token', ownerUserId: '123456789012345678' });
    expect(gateway.connect).toHaveBeenCalledWith('MTAw.token');
    expect(state.status).toEqual({ kind: 'connected', appId: 'Mia#1234' });
    expect(state.saveErrorStatus).toBeUndefined();
    expect(im.botContextId).toBe('9001');
    expect(im.getOwnerUserId()).toBe('123456789012345678');
    expect(secrets.get('bot-im-abc-discord-bot-token')).toBe('MTAw.token');
    expect(secrets.get('bot-im-abc-discord-owner-user-id')).toBe('123456789012345678');
    expect([...secrets.keys()].every((key) => key.startsWith('bot-im-abc-'))).toBe(true);
    expect(broadcasts).toEqual([]);

    await im.disconnect();
    expect(im.getStatus()).toEqual({ kind: 'idle' });
    expect([...secrets.keys()].filter((key) => key.includes('token') || key.includes('owner'))).toEqual([]);
    expect(broadcasts).toEqual([]);
  });
});
