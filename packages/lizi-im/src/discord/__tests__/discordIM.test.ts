/**
 * DiscordIM 的多实例契约: 伙伴自有连接带凭证键名前缀、不注册设置卡 IPC、不广播状态;
 * setConfig / disconnect 作为公开方法可被宿主按实例调用。
 */
import { describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent, IMStatus } from '../../types.js';
import { DiscordIM } from '../index.js';
import type { DiscordGateway, DiscordGatewayEvents } from '../gateway.js';
import type { DiscordFinalTextStorage } from '../finalTextOutbox.js';

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
  it('manual reconnect uses the saved token and cancels the pending automatic retry', async () => {
    vi.useFakeTimers();
    const { host, secrets, handlers } = makeHost();
    secrets.set('discord-bot-token', 'saved-token');
    const gateway = fakeGateway();
    gateway.connect.mockRejectedValueOnce(new Error('offline'));
    const im = new DiscordIM(host, { gatewayFactory: gateway.factory });
    im.registerIpc();
    try {
      await im.init();
      await handlers.get('discordBot:reconnect')!();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gateway.connect).toHaveBeenCalledTimes(2);
      expect(gateway.connect).toHaveBeenLastCalledWith('saved-token');
      expect(secrets.get('discord-bot-token')).toBe('saved-token');
      expect(im.getStatus().kind).toBe('connected');
    } finally { await im.dispose(); vi.useRealTimers(); }
  });

  it.each(['recover', 'dispose', 'invalid-token'])('handles startup failure: %s', async (outcome) => {
    vi.useFakeTimers();
    const { host, secrets } = makeHost();
    secrets.set('discord-bot-token', 'saved-token');
    const gateway = fakeGateway();
    gateway.connect.mockRejectedValueOnce(Object.assign(new Error('network down'), {
      code: outcome === 'invalid-token' ? 'TokenInvalid' : 'ECONNRESET',
    }));
    const im = new DiscordIM(host, { gatewayFactory: gateway.factory });
    try {
      await im.init();
      if (outcome === 'dispose') await im.dispose();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(gateway.connect).toHaveBeenCalledTimes(outcome === 'recover' ? 2 : 1);
      if (outcome === 'recover') expect(im.getStatus().kind).toBe('connected');
    } finally {
      await im.dispose();
      vi.useRealTimers();
    }
  });

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

// unit: true ingress -> terminal persistence -> restart. Streaming and pure ledger tests cannot verify
// that the original inbound identity is retained or that completed gateway messages never re-enter the model.
describe('Discord completed-input delivery identity', () => {
  // #10002: the event must carry its original grant to the host, rather than capture a new one after an await.
  it('keeps the original ingress grant on emitted channel messages', async () => {
    const h = terminalHarness(); const im = h.create(); await im.init();
    try {
      const received = new Promise<IMMessageEvent>(resolve => im.onMessage(resolve));
      h.trigger();
      const event = await received;
      expect(event.assertCurrent).toBeTypeOf('function');
      event.assertCurrent?.();
      h.revoke();
      expect(() => event.assertCurrent!()).toThrow('DISCORD_AUTHORIZATION_CHANGED');
    } finally { await im.dispose(); }
  });

  it('drops a revoked-then-regranted input that was still normalizing its attachments', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = terminalHarness({
      getCachedImage: async () => null,
      cacheImage: async () => { entered.resolve(); await release.promise; return { absPath: '/unused/fixture.png', url: 'cindy-media://fixture.png' }; },
      resolveMediaUrl: () => null,
    });
    const im = h.create(); const events: IMMessageEvent[] = [];
    im.onMessage(event => { events.push(event); });
    await im.init();
    try {
      h.trigger(true, '8', [{ id: 'file', name: 'fixture.png', url: 'https://offline.invalid/unused.png', size: 10, contentType: 'image/png' }]);
      await entered.promise;
      h.revoke();
      const next = new Promise<void>(resolve => im.onMessage(() => resolve()));
      h.trigger(true, '9');
      release.resolve();
      await next; // Same-lane queue: the second event is the completion barrier for normalization of the first.
      expect(events.map(event => event.messageId)).toEqual(['30|9']);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { release.resolve(); await im.dispose(); fetch.mockRestore(); }
  });

  function terminalHarness(media?: IMHost['media']) {
    const { host, secrets } = makeHost();
    if (media) host.media = media;
    secrets.set('discord-bot-token', 'invalid-test-token'); secrets.set('discord-owner-user-id', '1'); secrets.set('discord-bot-lifecycle-announcement', 'false');
    let credentialRevision = 1;
    let failure: 'token-save' | 'owner-save' | 'login' | null = null;
    let grant = 'grant-1';
    host.secrets.write = (key, value) => {
      if ((failure === 'token-save' && key === 'discord-bot-token' && value === 'replacement-invalid-token') ||
          (failure === 'owner-save' && key === 'discord-owner-user-id' && value === '3')) return false;
      secrets.set(key, value); credentialRevision++; return true;
    };
    let contents: string | null = null;
    const storage: DiscordFinalTextStorage = { key: 'owner-test', read: () => contents, write: value => { contents = value; }, assertCurrent() {}, credentialStamp: () => `credentials-${credentialRevision}`, authorizationStamp: () => `credentials-${credentialRevision}:${grant}` };
    const post = vi.fn<(route: string, options: unknown) => Promise<{ id: string }>>(async () => ({ id: '90' }));
    const channel = { id: '30', type: 11, guildId: '10', parentId: '20', parent: { id: '20', guildId: '10', type: 0 }, isTextBased: () => true, messages: {}, permissionsFor: () => ({ has: () => true }) };
    const sdk = { user: { id: '2' }, channels: { fetch: async () => channel }, rest: { post } };
    let events: DiscordGatewayEvents;
    const create = () => new DiscordIM(host, { finalTextStorage: () => storage, channelAccess: { read: () => ({ channels: [{ guildId: '10', channelId: '20' }] }) }, gatewayFactory: ev => {
      events = ev;
      return { appId: '2', botTag: 'fake', client: sdk, connect: async (token: string) => {
        if (failure === 'login' && token === 'replacement-invalid-token') throw Object.assign(new Error('invalid test replacement'), { code: 'TokenInvalid' });
        ev.onStatus({ kind: 'connected', appId: 'fake' });
      }, destroy: async () => {} } as unknown as DiscordGateway;
    } });
    const trigger = (mention = true, id = '8', attachments: unknown[] = []) => events.onGuildMessage({ id, guildId: '10', channelId: '30', channel, author: { id: '1', username: 'Owner' }, content: '<@2> question', mentions: { has: () => mention }, attachments } as never);
    return { create, trigger, post, secrets, fail: (value: typeof failure) => { failure = value; }, revoke: () => { grant = 'grant-2'; }, offline: () => events.onStatus({ kind: 'connecting' }), get json() { return contents ? JSON.parse(contents) : null; } };
  }
  // #10002: real ingress/terminal/config rollback must retain pending text and an in-flight final,
  // including metadata revisions from partial credential writes. Unit; fake gateway, no credentials/network.
  it.each(['token-save', 'owner-save', 'login'] as const)('preserves pending and in-flight finals after failed %s', async failure => {
    const h = terminalHarness(); const im = h.create(); await im.init();
    try {
      let received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(); await received;
      received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(true, '9'); await received;
      h.offline(); await im.commitFinalText('30|8', 'g/10/20/30', 'pending answer');
      h.fail(failure);
      const update = im.setConfig({ token: 'replacement-invalid-token', ownerUserId: '3' });
      const final = im.commitFinalText('30|9', 'g/10/20/30', 'in-flight answer');
      await update; await final;
      expect(h.secrets.get('discord-bot-token')).toBe('invalid-test-token');
      expect(h.secrets.get('discord-owner-user-id')).toBe('1');
      await im.reconnect();
      await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
      expect(h.post.mock.calls.map(c => (c[1] as { body: { content: string } }).body.content)).toEqual(['pending answer', 'in-flight answer']);
      expect(h.json.entries.map((e: { state: string }) => e.state)).toEqual(['delivered', 'delivered']);
    } finally { await im.dispose(); }
  });
  it('records completion before POST and suppresses a completed input on gateway redelivery', async () => {
    const h = terminalHarness(); const im = h.create(); const inbound = vi.fn(); im.onMessage(inbound); await im.init();
    try {
      h.trigger(false); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(inbound).not.toHaveBeenCalled();
      const received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(); await received;
      h.post.mockImplementationOnce(async () => { expect(h.json.entries[0].segments[0].state).toBe('sending'); return { id: '90' }; });
      expect((await im.commitFinalText('30|8', 'g/10/20/30', 'answer')).state).toBe('delivered');
      h.trigger(); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(inbound).toHaveBeenCalledTimes(1); expect(h.post).toHaveBeenCalledTimes(1);
    } finally { await im.dispose(); }
  });
  it('retains an already-started POST receipt while a configuration replacement fails', async () => {
    const h = terminalHarness(); const im = h.create(); await im.init();
    const posted = Promise.withResolvers<void>(); const response = Promise.withResolvers<{ id: string }>();
    try {
      const received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(); await received;
      h.post.mockImplementationOnce(() => { posted.resolve(); return response.promise; });
      const final = im.commitFinalText('30|8', 'g/10/20/30', 'already sending');
      await posted.promise;
      h.fail('login');
      const update = im.setConfig({ token: 'replacement-invalid-token', ownerUserId: '3' });
      response.resolve({ id: '90' });
      await update;
      expect((await final).state).toBe('delivered');
      expect(h.json.entries[0]).toMatchObject({ state: 'delivered', receipts: ['90'] });
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.secrets.get('discord-bot-token')).toBe('invalid-test-token');
    } finally { response.resolve({ id: '90' }); await im.dispose(); }
  });
  it.each(['answer', '❌ 错误：terminal failure'])('recovers offline terminal text on a new process without replaying the input or model: %s', async text => {
    const h = terminalHarness(); const im = h.create(); await im.init();
    const received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(); await received; h.offline();
    expect((await im.commitFinalText('30|8', 'g/10/20/30', text)).state).toBe('pending'); await im.dispose();
    const restarted = h.create(); const inbound = vi.fn(); restarted.onMessage(inbound);
    try {
      await restarted.init(); await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
      expect(h.post.mock.calls[0]?.[1]).toMatchObject({ body: { content: text } });
      h.trigger(); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(inbound).not.toHaveBeenCalled();
    } finally { await restarted.dispose(); }
  });
  it('rejects the old model final after a binding is replaced, even with the same bot and owner IDs', async () => {
    const h = terminalHarness(); const im = h.create(); await im.init();
    try {
      const received = new Promise<void>(resolve => im.onMessage(() => resolve())); h.trigger(); await received;
      await im.setConfig({ token: 'another-invalid-test-token', ownerUserId: '1' });
      await expect(im.commitFinalText('30|8', 'g/10/20/30', 'old answer')).rejects.toMatchObject({ code: 'DISCORD_REPLY_ANCHOR_CHANGED' });
      expect(h.post).not.toHaveBeenCalled();
    } finally { await im.dispose(); }
  });
});
