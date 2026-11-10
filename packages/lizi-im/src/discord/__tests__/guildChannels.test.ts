/**
 * 服务器频道 / thread 的传输层契约：白名单 + @ 召唤 + 主人 / 成员准入、lane 路由、
 * 出站寻址、卡片点击身份、配置换代。真实 Discord 端到端不在这里（需要验收 bot）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent } from '../../types.js';
import type { DiscordGateway, DiscordGatewayEvents } from '../gateway.js';
import { DiscordIM } from '../index.js';
import {
  decodeDiscordLaneUserId,
  encodeDiscordLaneUserId,
  isDiscordLaneAdmitted,
  isDiscordLaneEnabled,
  normalizeDiscordChannelAccess,
} from '../lane.js';
import type { DiscordChannelAccessConfig } from '../lane.js';

const OWNER = '100000000000000001';
const MEMBER = '100000000000000002';
const BOT = '100000000000000999';
const GUILD = '200000000000000001';
const CHANNEL = '300000000000000001';
const OTHER_CHANNEL = '300000000000000002';
const THREAD = '400000000000000001';
const LANE = `g/${GUILD}/${CHANNEL}`;
const THREAD_LANE = `g/${GUILD}/${CHANNEL}/${THREAD}`;

function makeHost(media?: IMHost['media']): IMHost {
  const secrets = new Map<string, string>([['discord-owner-user-id', OWNER]]);
  return {
    paths: { feishuMediaDir: '/unused' },
    secrets: {
      write: (k, v) => (secrets.set(k, v), true),
      read: (k) => secrets.get(k) ?? null,
      remove: (k) => void secrets.delete(k),
      isAvailable: () => true,
    },
    ipc: { throwIpcError: (_c, m) => { throw new Error(m); }, handle: vi.fn(), broadcast: vi.fn() },
    httpPostForm: async () => ({ status: 200, body: {} }),
    ...(media ? { media } : {}),
  };
}

interface Harness {
  im: DiscordIM;
  events: IMMessageEvent[];
  cardActions: Array<{ senderId: string; chatId: string; buttonId: string }>;
  emitGuild(m: unknown): Promise<void>;
  emitButton(i: unknown): Promise<void>;
  access: { config: DiscordChannelAccessConfig };
  setAppId(id: string): void;
  channels: Map<string, ReturnType<typeof makeTextChannel>>;
}

function makeTextChannel(id: string, guildId = GUILD) {
  let n = 0;
  const sent: Array<{ payload: unknown; message: ReturnType<typeof makeSentMessage> }> = [];
  return {
    id,
    guildId,
    sent,
    send: vi.fn(async (payload: unknown) => {
      const message = makeSentMessage(`${id}-m${++n}`);
      sent.push({ payload, message });
      return message;
    }),
    // 机器人没有「读取消息历史」权限：按 id 取消息必失败。
    messages: { fetch: vi.fn(async () => { throw new Error('Missing Access'); }) },
  };
}

function makeSentMessage(id: string) {
  return {
    id,
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
    reactions: { resolve: vi.fn(() => null) },
  };
}

async function harness(initial: DiscordChannelAccessConfig = { channels: [{ guildId: GUILD, channelId: CHANNEL }] }, host = makeHost()): Promise<Harness> {
  const access = { config: initial };
  const channels = new Map<string, ReturnType<typeof makeTextChannel>>([
    [CHANNEL, makeTextChannel(CHANNEL)],
    [THREAD, makeTextChannel(THREAD)],
    [OTHER_CHANNEL, makeTextChannel(OTHER_CHANNEL)],
  ]);
  let appId = 'app-1';
  let handlers!: DiscordGatewayEvents;
  const client = {
    user: { id: BOT },
    channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
  };
  const gateway: DiscordGateway = {
    connect: async () => undefined,
    destroy: async () => undefined,
    client: client as never,
    get appId() { return appId; },
    botTag: 'bot#1',
  };
  const im = new DiscordIM(host, {
    channelAccess: { read: () => access.config, write: (c) => (access.config = c) },
    gatewayFactory: (ev) => { handlers = ev; return gateway; },
  });
  await im.init();
  const events: IMMessageEvent[] = [];
  const cardActions: Harness['cardActions'] = [];
  im.onMessage((e) => events.push(e));
  im.onCardAction((e) => cardActions.push(e));
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    im, events, cardActions, access, channels,
    setAppId: (id) => { appId = id; },
    emitGuild: async (m) => { handlers.onGuildMessage(m as never); await tick(); await tick(); },
    emitButton: async (i) => { handlers.onButtonInteraction(i as never); await tick(); await tick(); },
  };
}

function guildMessage(over: {
  id?: string; authorId?: string; content?: string; channelId?: string; threadParent?: string;
  mentionsBot?: boolean; attachments?: unknown[];
} = {}) {
  const inThread = over.threadParent !== undefined;
  const channelId = over.channelId ?? (inThread ? THREAD : CHANNEL);
  return {
    id: over.id ?? 'msg-1',
    guildId: GUILD,
    guild: { name: 'Guild' },
    channelId,
    channel: {
      id: channelId,
      name: inThread ? 'a-thread' : 'general',
      type: inThread ? 11 : 0,
      parentId: inThread ? over.threadParent : null,
      parent: inThread ? { name: 'general' } : null,
    },
    author: { id: over.authorId ?? OWNER, username: 'owner', globalName: 'Owner' },
    member: { displayName: 'Owner D' },
    content: over.content ?? `<@${BOT}> hello`,
    attachments: over.attachments ?? [],
    mentions: { has: vi.fn(() => over.mentionsBot ?? true) },
  };
}

describe('discord lane codec & access', () => {
  it('round-trips channel and thread lanes and rejects junk', () => {
    const lane = { guildId: GUILD, channelId: CHANNEL, threadId: '' };
    expect(encodeDiscordLaneUserId(lane)).toBe(LANE);
    expect(decodeDiscordLaneUserId(LANE)).toEqual(lane);
    expect(decodeDiscordLaneUserId(THREAD_LANE)).toEqual({ ...lane, threadId: THREAD });
    expect(decodeDiscordLaneUserId(OWNER)).toBeNull();
    expect(decodeDiscordLaneUserId('g/abc/def')).toBeNull();
    expect(decodeDiscordLaneUserId(`g/${GUILD}`)).toBeNull();
    expect(() => encodeDiscordLaneUserId({ ...lane, channelId: 'x/y' })).toThrow();
  });

  it('normalizes access: drops junk ids, dedupes, keeps explicit member admission only', () => {
    const config = normalizeDiscordChannelAccess({
      channels: [
        { guildId: GUILD, channelId: CHANNEL, allowMembers: true },
        { guildId: GUILD, channelId: CHANNEL },
        { guildId: 'abc', channelId: CHANNEL },
        { guildId: GUILD, channelId: OTHER_CHANNEL, allowMembers: 'yes' },
        null,
      ],
    });
    expect(config.channels).toEqual([
      { guildId: GUILD, channelId: CHANNEL, allowMembers: true },
      { guildId: GUILD, channelId: OTHER_CHANNEL },
    ]);
    const lane = { guildId: GUILD, channelId: CHANNEL, threadId: THREAD };
    expect(isDiscordLaneAdmitted(config, lane, false)).toBe(true);
    expect(isDiscordLaneAdmitted(config, { ...lane, channelId: OTHER_CHANNEL }, false)).toBe(false);
    expect(isDiscordLaneAdmitted({ channels: [] }, lane, true)).toBe(false);
  });
});

describe('server-level access (all channels / selected channels / closed)', () => {
  const lane = (channelId: string, threadId = '') => ({ guildId: GUILD, channelId, threadId });
  const NEW_CHANNEL = '300000000000000099';

  it('keeps a legacy channels-only config as "enabled, selected channels" (no guild entry needed)', () => {
    const legacy = normalizeDiscordChannelAccess({ channels: [{ guildId: GUILD, channelId: CHANNEL }] });
    expect(legacy).toEqual({ channels: [{ guildId: GUILD, channelId: CHANNEL }] });
    expect(isDiscordLaneAdmitted(legacy, lane(CHANNEL), true)).toBe(true);
    expect(isDiscordLaneAdmitted(legacy, lane(OTHER_CHANNEL), true)).toBe(false);
  });

  it('all-channels mode covers channels created later and threads under them, without listing them', () => {
    const config = normalizeDiscordChannelAccess({ channels: [], guilds: [{ guildId: GUILD, enabled: true, mode: 'all' }] });
    expect(isDiscordLaneAdmitted(config, lane(NEW_CHANNEL), true)).toBe(true);
    expect(isDiscordLaneAdmitted(config, lane(NEW_CHANNEL, THREAD), true)).toBe(true);
    // 别的服务器不受影响。
    expect(isDiscordLaneAdmitted(config, { guildId: '200000000000000002', channelId: CHANNEL, threadId: '' }, true)).toBe(false);
    // 成员默认不放行；服务器级开关打开后才放行。
    expect(isDiscordLaneAdmitted(config, lane(NEW_CHANNEL), false)).toBe(false);
    const withMembers = normalizeDiscordChannelAccess({ guilds: [{ guildId: GUILD, enabled: true, mode: 'all', allowMembers: true }] });
    expect(isDiscordLaneAdmitted(withMembers, lane(NEW_CHANNEL), false)).toBe(true);
  });

  it('a closed server admits nothing and its selection moves to savedChannels so older readers cannot open it', () => {
    const closed = normalizeDiscordChannelAccess({
      channels: [{ guildId: GUILD, channelId: CHANNEL, allowMembers: true }, { guildId: '200000000000000002', channelId: OTHER_CHANNEL }],
      guilds: [{ guildId: GUILD, enabled: false, mode: 'selected' }],
    });
    expect(closed).toEqual({
      channels: [{ guildId: '200000000000000002', channelId: OTHER_CHANNEL }],
      guilds: [{ guildId: GUILD, enabled: false, mode: 'selected', savedChannels: [{ channelId: CHANNEL, allowMembers: true }] }],
    });
    expect(isDiscordLaneAdmitted(closed, lane(CHANNEL), true)).toBe(false);
    expect(isDiscordLaneEnabled(closed, lane(CHANNEL))).toBe(false);
    // 全部频道模式同样把显式选择收起来，`channels` 里只剩生效的。
    const all = normalizeDiscordChannelAccess({
      channels: [{ guildId: GUILD, channelId: CHANNEL }],
      guilds: [{ guildId: GUILD, enabled: true, mode: 'all' }],
    });
    expect(all.channels).toEqual([]);
    expect(all.guilds?.[0]?.savedChannels).toEqual([{ channelId: CHANNEL }]);
  });

  it('fails closed on malformed guild entries but keeps a deliberately configured empty selection', () => {
    const config = normalizeDiscordChannelAccess({
      guilds: [
        { guildId: GUILD },
        { guildId: 'junk', enabled: true, mode: 'all' },
        { guildId: '200000000000000002', enabled: false, mode: 'selected' },
        { guildId: '200000000000000003', enabled: true, mode: 'weird' },
      ],
    });
    expect(config).toEqual({
      channels: [],
      guilds: [
        // 缺 enabled → 关闭；显式的「关闭 + 仅指定 + 零选择」是用户设置过的状态，保留。
        { guildId: GUILD, enabled: false, mode: 'selected' },
        { guildId: '200000000000000002', enabled: false, mode: 'selected' },
        { guildId: '200000000000000003', enabled: true, mode: 'selected' },
      ],
    });
    expect(isDiscordLaneAdmitted(config, lane(CHANNEL), true)).toBe(false);
  });

  it('a lingering selection on an in-effect selected server keeps working and stray savedChannels are dropped', () => {
    const config = normalizeDiscordChannelAccess({
      channels: [{ guildId: GUILD, channelId: CHANNEL }],
      guilds: [{ guildId: GUILD, enabled: true, mode: 'selected', savedChannels: [{ channelId: OTHER_CHANNEL }] }],
    });
    expect(config.guilds?.[0]?.savedChannels).toBeUndefined();
    expect(isDiscordLaneAdmitted(config, lane(CHANNEL), true)).toBe(true);
    expect(isDiscordLaneAdmitted(config, lane(OTHER_CHANNEL), true)).toBe(false);
  });
});

describe('DiscordIM guild channel inbound', () => {
  it('ignores every guild message when no channel is whitelisted (default closed)', async () => {
    const h = await harness({ channels: [] });
    await h.emitGuild(guildMessage());
    expect(h.events).toEqual([]);
  });

  it('accepts an owner @mention in a whitelisted channel and routes it by lane', async () => {
    const h = await harness();
    await h.emitGuild(guildMessage({ id: 'm1', content: `<@${BOT}> what is up` }));

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      channelName: 'discord',
      senderId: LANE,
      chatId: CHANNEL,
      contextId: 'app-1',
      messageId: `${CHANNEL}|m1`,
      text: 'what is up',
      invoked: true,
      speaker: { id: OWNER, isOwner: true, name: 'Owner D' },
      interactionSource: { messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/m1` },
    });
  });

  it('ignores messages that do not @ the bot (no MessageContent is assumed)', async () => {
    const h = await harness();
    await h.emitGuild(guildMessage({ mentionsBot: false }));
    expect(h.events).toEqual([]);
  });

  it('uses the text channel name rather than its category in the interaction source', async () => {
    const h = await harness();
    const message = guildMessage();
    message.channel.parentId = '500000000000000001';
    message.channel.parent = { name: 'Engineering' };
    await h.emitGuild(message);

    expect(h.events).toHaveLength(1);
    expect(h.events[0].interactionSource?.chatName).toBe('Guild #general');
    expect(h.events[0].interactionSource?.threadName).toBeUndefined();
  });

  it('accepts a channel created after the server was set to all channels, and its threads, without any list update', async () => {
    const h = await harness({ channels: [], guilds: [{ guildId: GUILD, enabled: true, mode: 'all' }] });
    await h.emitGuild(guildMessage({ id: 'n1', channelId: '300000000000000099' }));
    await h.emitGuild(guildMessage({ id: 'n2', threadParent: '300000000000000099' }));

    expect(h.events.map((e) => e.senderId)).toEqual([
      `g/${GUILD}/300000000000000099`,
      `g/${GUILD}/300000000000000099/${THREAD}`,
    ]);
  });

  it('stops accepting once the server is closed, and keeps working for a legacy channel list', async () => {
    const h = await harness({ channels: [], guilds: [{ guildId: GUILD, enabled: true, mode: 'all' }] });
    h.access.config = { channels: [], guilds: [{ guildId: GUILD, enabled: false, mode: 'all' }] };
    await h.emitGuild(guildMessage({ id: 'x1' }));
    expect(h.events).toEqual([]);

    h.access.config = { channels: [{ guildId: GUILD, channelId: CHANNEL }] };
    await h.emitGuild(guildMessage({ id: 'x2' }));
    expect(h.events).toHaveLength(1);
  });

  it('ignores channels that are not whitelisted, even in a whitelisted guild', async () => {
    const h = await harness();
    await h.emitGuild(guildMessage({ channelId: OTHER_CHANNEL }));
    expect(h.events).toEqual([]);
  });

  it('drops non-owner @mentions unless the channel explicitly admits members', async () => {
    const h = await harness();
    await h.emitGuild(guildMessage({ authorId: MEMBER }));
    expect(h.events).toEqual([]);

    h.access.config = { channels: [{ guildId: GUILD, channelId: CHANNEL, allowMembers: true }] };
    await h.emitGuild(guildMessage({ id: 'm2', authorId: MEMBER }));
    expect(h.events).toHaveLength(1);
    expect(h.events[0].speaker).toMatchObject({ id: MEMBER, isOwner: false });
    expect(h.events[0].senderId).toBe(LANE);
  });

  it('keeps threads independent of the channel but gated by the parent whitelist', async () => {
    const h = await harness();
    await h.emitGuild(guildMessage({ id: 'c1' }));
    await h.emitGuild(guildMessage({ id: 't1', threadParent: CHANNEL }));
    await h.emitGuild(guildMessage({ id: 't2', threadParent: OTHER_CHANNEL }));
    await h.emitGuild(guildMessage({ id: 't3', threadParent: undefined, channelId: THREAD }));

    expect(h.events.map((e) => [e.messageId, e.senderId])).toEqual([
      [`${CHANNEL}|c1`, LANE],
      [`${THREAD}|t1`, THREAD_LANE],
    ]);
    expect(h.events[1].interactionSource).toMatchObject({
      chatName: 'Guild #general',
      threadName: 'a-thread',
    });
  });

  it('drops a message whose whitelist entry is revoked while attachments download', async () => {
    const download = deferredFetch();
    const discard = vi.fn(async () => undefined);
    const media = {
      cacheImage: vi.fn(async () => ({ absPath: '/b/x.png', url: 'cindy-media://x', discard })),
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const h = await harness(undefined, makeHost(media as never));
    try {
      await h.emitGuild(guildMessage({
        attachments: [{ id: 'a1', name: 'p.png', url: 'https://cdn/x.png', size: 10, contentType: 'image/png' }],
      }));
      h.access.config = { channels: [] };
      download.release();
      await new Promise((r) => setTimeout(r, 10));
      expect(h.events).toEqual([]);
      expect(discard).toHaveBeenCalled();
    } finally {
      download.restore();
    }
  });

  it('drops queued work from a previous bot identity after the gateway app id changes', async () => {
    const download = deferredFetch();
    const media = {
      cacheImage: vi.fn(async () => ({ absPath: '/b/x.png', url: 'cindy-media://x', discard: vi.fn(async () => undefined) })),
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const h = await harness(undefined, makeHost(media as never));
    try {
      await h.emitGuild(guildMessage({
        attachments: [{ id: 'a1', name: 'p.png', url: 'https://cdn/x.png', size: 10, contentType: 'image/png' }],
      }));
      h.setAppId('app-2');
      download.release();
      await new Promise((r) => setTimeout(r, 10));
      expect(h.events).toEqual([]);
    } finally {
      download.restore();
    }
  });
});

describe('DiscordIM guild channel outbound', () => {
  it('sends to the lane channel or thread, never to the DM resolver', async () => {
    const h = await harness();
    await h.im.sendText(LANE, 'hi channel');
    expect(h.channels.get(CHANNEL)!.send).toHaveBeenCalledWith('hi channel');

    await h.im.sendText(THREAD_LANE, 'hi thread');
    expect(h.channels.get(THREAD)!.send).toHaveBeenCalledWith('hi thread');
    expect(h.channels.get(OTHER_CHANNEL)!.send).not.toHaveBeenCalled();
  });

  it('refuses to send once the channel leaves the whitelist', async () => {
    const h = await harness();
    h.access.config = { channels: [] };
    await expect(h.im.sendText(LANE, 'late')).rejects.toThrow('not enabled');
    expect(h.channels.get(CHANNEL)!.send).not.toHaveBeenCalled();
  });

  it('refuses a channel that does not belong to the lane guild', async () => {
    const h = await harness();
    h.channels.set(CHANNEL, makeTextChannel(CHANNEL, 'another-guild'));
    await expect(h.im.sendText(LANE, 'x')).rejects.toThrow('unavailable');
  });

  it('streams and finalizes in the channel without Read Message History, and falls back to a new message when editing fails', async () => {
    const h = await harness();
    const handle = await h.im.startStreamingText(LANE, 'thinking');
    const channel = h.channels.get(CHANNEL)!;
    const placeholder = channel.sent[0].message;

    await handle.finalize('final answer');
    // 手里有发出的 Message 对象：不需要 fetch（fetch 在本测试里必失败）。
    expect(placeholder.edit).toHaveBeenCalledWith('final answer');
    expect(channel.messages.fetch).not.toHaveBeenCalled();

    // 编辑失败（例如重连后对象失效）→ 终稿改发新消息而不是丢失。
    const second = await h.im.startStreamingText(LANE, 'again');
    channel.sent[1].message.edit.mockRejectedValueOnce(new Error('Unknown Message'));
    await second.finalize('second answer');
    expect(channel.send).toHaveBeenLastCalledWith('second answer');
  });

  it('sends cards to the lane channel and reports them as the lane message id', async () => {
    const h = await harness();
    const { messageId } = await h.im.sendInteractiveCard(THREAD_LANE, {
      title: 'Allow?', body: 'rm', buttons: [{ id: 'permission:allow:once', label: 'Allow' }],
    });
    expect(messageId).toBe(`${THREAD}|${THREAD}-m1`);
    expect(h.channels.get(THREAD)!.send).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordIM guild channel outbound after the allowlist or bot identity changes', () => {
  it.each([
    ['bot', false], ['owner', false], ['bot', true], ['owner', true],
  ])('marks stream setup invalidated when %s changes during channel lookup (lookup rejects=%s)', async (identity, rejects) => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const client = (h.im as unknown as { gateway: { client: { channels: { fetch: ReturnType<typeof vi.fn> } } } }).gateway.client;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    client.channels.fetch.mockImplementationOnce(async () => {
      await gate;
      if (rejects) throw new Error('channel lookup failed');
      return channel;
    });

    const pending = h.im.startStreamingText(LANE, 'thinking');
    if (identity === 'bot') h.setAppId('app-2');
    else (h.im as unknown as { ownerUserId: string }).ownerUserId = '999999999999999999';
    release();

    await expect(pending).rejects.toMatchObject({
      code: 'IM_OUTPUT_INVALIDATED',
      message: expect.stringContaining(identity === 'bot' ? 'connection changed' : 'owner changed'),
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('stops a live stream when the channel is removed: no final edit and no fallback send', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const handle = await h.im.startStreamingText(LANE, 'thinking');
    const placeholder = channel.sent[0].message;

    h.access.config = { channels: [] };
    await expect(handle.finalize('secret final answer')).rejects.toThrow('not enabled');

    expect(placeholder.edit).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('stops a live stream when its server is closed or switched to a selection that excludes the channel', async () => {
    for (const next of [
      { channels: [], guilds: [{ guildId: GUILD, enabled: false, mode: 'all' as const }] },
      { channels: [{ guildId: GUILD, channelId: OTHER_CHANNEL }], guilds: [{ guildId: GUILD, enabled: true, mode: 'selected' as const }] },
    ]) {
      const h = await harness({ channels: [], guilds: [{ guildId: GUILD, enabled: true, mode: 'all' }] });
      const channel = h.channels.get(CHANNEL)!;
      const handle = await h.im.startStreamingText(LANE, 'thinking');

      h.access.config = next;
      await expect(handle.finalize('final answer')).rejects.toThrow('not enabled');

      expect(channel.sent[0].message.edit).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledTimes(1);
    }
  });

  it('stops a live stream when the bot identity changes', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const handle = await h.im.startStreamingText(LANE, 'thinking');

    h.setAppId('app-2');
    await expect(handle.finalize('final answer')).rejects.toThrow('connection changed');

    expect(channel.sent[0].message.edit).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('does not send later segments of a long reply after the channel is removed', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const send = channel.send.getMockImplementation()!;
    channel.send.mockImplementation(async (payload: unknown) => {
      const sent = await send(payload);
      h.access.config = { channels: [] };
      return sent;
    });

    await expect(h.im.sendText(LANE, 'x'.repeat(5000))).rejects.toThrow('not enabled');

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['channel removed', (h: Harness) => { h.access.config = { channels: [] }; }, 'not enabled'],
    ['bot replaced', (h: Harness) => h.setAppId('app-2'), 'connection changed'],
  ])('does not send when the %s while the channel fetch is in flight', async (_name, change, message) => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const target = await (h.im as unknown as { requireTargetChannel(id: string): Promise<{ send(p: unknown): Promise<unknown> }> })
      .requireTargetChannel(LANE);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetch = (h.im as unknown as { gateway: { client: { channels: { fetch: ReturnType<typeof vi.fn> } } } }).gateway.client.channels.fetch;
    fetch.mockImplementationOnce(async () => { await gate; return channel; });

    const pending = target.send('late');
    change(h);
    release();

    await expect(pending).rejects.toThrow(message);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('refuses to update an old card or upload images after the channel is removed, even without a cached message object', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const { messageId } = await h.im.sendInteractiveCard(LANE, {
      title: 'Allow?', body: 'rm', buttons: [{ id: 'permission:allow:once', label: 'Allow' }],
    });
    const card = channel.sent[0].message;
    h.access.config = { channels: [] };

    await expect(h.im.updateInteractiveCard(messageId, { title: 'Done', body: 'ok', buttons: [] })).rejects.toThrow('not enabled');
    expect(card.edit).not.toHaveBeenCalled();

    // 缓存没命中（例如重启 / 换连接后）：按 id 取到频道后同样按白名单判定。
    const uncached = makeSentMessage('old');
    channel.messages.fetch.mockResolvedValueOnce(uncached as never);
    await expect(h.im.updateInteractiveCard(`${CHANNEL}|old`, { title: 'Done', body: 'ok', buttons: [] })).rejects.toThrow('not enabled');
    expect(uncached.edit).not.toHaveBeenCalled();

    await expect(
      (h.im as unknown as { uploadImages(id: string, paths: string[]): Promise<void> }).uploadImages(messageId, ['/tmp/a.png']),
    ).rejects.toThrow('not enabled');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  // Public card edits must recheck after the cached lookup yields. Earlier tests
  // revoked before the call or during a network fetch, missing this microtask. Tier: unit.
  it.each(([
    ['channel revoked', (h: Harness) => { h.access.config = { channels: [] }; }, 'not enabled'],
    ['bot replaced', (h: Harness) => h.setAppId('app-2'), 'connection changed'],
    ['owner changed', (h: Harness) => {
      (h.im as unknown as { ownerUserId: string }).ownerUserId = '999999999999999999';
    }, 'owner changed'],
  ] as const).flatMap(([reason, change, error]) =>
    (['interactive', 'markdown'] as const).map(kind => ({ reason, change, error, kind })),
  ))('does not edit a cached $kind card when $reason before its continuation', async ({ kind, change, error }) => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const { messageId } = await h.im.sendInteractiveCard(LANE, { title: 'Allow?', body: 'rm', buttons: [] });

    const pending = kind === 'interactive'
      ? h.im.updateInteractiveCard(messageId, { title: 'Done', body: 'ok', buttons: [] })
      : h.im.patchMarkdownCard(messageId, 'Done');
    change(h);

    await expect(pending).rejects.toThrow(error);
    expect(channel.sent[0].message.edit).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it('stops uploading images when the bot is replaced while the channel fetch is in flight', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const client = (h.im as unknown as { gateway: { client: { channels: { fetch: ReturnType<typeof vi.fn> } } } }).gateway.client;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    client.channels.fetch.mockImplementationOnce(async () => { await gate; return channel; });

    const upload = (h.im as unknown as { uploadImages(id: string, paths: string[]): Promise<void> })
      .uploadImages(`${CHANNEL}|m1`, ['/tmp/a.png']);
    h.setAppId('app-2');
    release();

    await expect(upload).rejects.toThrow('connection changed');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('stops between upload batches when the bot is replaced after the first batch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-upload-'));
    try {
      const files = Array.from({ length: 11 }, (_, i) => {
        const file = path.join(dir, `p${i}.png`);
        fs.writeFileSync(file, 'x');
        return file;
      });
      const h = await harness();
      const channel = h.channels.get(CHANNEL)!;
      const send = channel.send.getMockImplementation()!;
      channel.send.mockImplementation(async (payload: unknown) => {
        const sent = await send(payload);
        h.setAppId('app-2');
        return sent;
      });

      await expect(
        (h.im as unknown as { uploadImages(id: string, paths: string[]): Promise<void> })
          .uploadImages(`${CHANNEL}|m1`, files),
      ).rejects.toThrow('connection changed');

      expect(channel.send).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['channel fetch', 'channels'],
    ['message fetch', 'messages'],
  ])('does not edit an uncached card when the bot is replaced while the %s is in flight', async (_name, stage) => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const old = makeSentMessage('old');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    if (stage === 'channels') {
      const client = (h.im as unknown as { gateway: { client: { channels: { fetch: ReturnType<typeof vi.fn> } } } }).gateway.client;
      client.channels.fetch.mockImplementationOnce(async () => { await gate; return channel; });
    } else {
      channel.messages.fetch.mockImplementationOnce(async () => { await gate; return old as never; });
    }

    const update = h.im.updateInteractiveCard(`${CHANNEL}|old`, { title: 'Done', body: 'ok', buttons: [] });
    h.setAppId('app-2');
    release();

    await expect(update).rejects.toThrow('connection changed');
    expect(old.edit).not.toHaveBeenCalled();
  });

  it('stops a live stream when the configured owner changes', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const handle = await h.im.startStreamingText(LANE, 'thinking');

    (h.im as unknown as { ownerUserId: string }).ownerUserId = '999999999999999999';
    await expect(handle.finalize('final answer')).rejects.toThrow('owner changed');

    expect(channel.sent[0].message.edit).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('still lets the bot delete its own placeholder after the channel is removed (cleanup only)', async () => {
    const h = await harness();
    const channel = h.channels.get(CHANNEL)!;
    const handle = await h.im.startStreamingText(LANE, 'thinking');
    h.access.config = { channels: [] };

    await expect(handle.finalize('')).resolves.toBeUndefined();

    expect(channel.sent[0].message.delete).toHaveBeenCalled();
    expect(channel.sent[0].message.edit).not.toHaveBeenCalled();
  });
});

describe('DiscordIM guild card clicks', () => {
  const click = (userId: string, over: Record<string, unknown> = {}) => ({
    customId: JSON.stringify({ i: 'permission:allow:once', p: { requestId: 'r1' } }),
    user: { id: userId },
    channelId: CHANNEL,
    guildId: GUILD,
    channel: { type: 0, parentId: null },
    message: { id: 'card-1' },
    followUp: vi.fn(async () => undefined),
    ...over,
  });

  it('forwards an owner click with the lane as the route key', async () => {
    const h = await harness();
    await h.emitButton(click(OWNER));
    expect(h.cardActions).toEqual([
      expect.objectContaining({ senderId: LANE, chatId: CHANNEL, buttonId: 'permission:allow:once' }),
    ]);
  });

  it('ignores non-owner clicks and tells them privately', async () => {
    const h = await harness();
    const i = click(MEMBER);
    await h.emitButton(i);
    expect(h.cardActions).toEqual([]);
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('expires cards from channels that were removed from the whitelist', async () => {
    const h = await harness();
    h.access.config = { channels: [] };
    const i = click(OWNER);
    await h.emitButton(i);
    expect(h.cardActions).toEqual([]);
    expect(i.followUp).toHaveBeenCalled();
  });

  it('maps a thread card click to the thread lane', async () => {
    const h = await harness();
    await h.emitButton(click(OWNER, { channelId: THREAD, channel: { type: 11, parentId: CHANNEL } }));
    expect(h.cardActions[0]).toMatchObject({ senderId: THREAD_LANE, chatId: THREAD });
  });
});

describe('DiscordIM guild directory & IPC', () => {
  it('lists whitelisted-capable channels with the bot permissions', async () => {
    const host = makeHost();
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    (host.ipc.handle as unknown) = (c: string, fn: (payload?: unknown) => unknown) => void handlers.set(c, fn);
    const access = { config: { channels: [] } as DiscordChannelAccessConfig };
    const perms = (granted: string[]) => ({ has: (flag: string) => granted.includes(flag) });
    const client = {
      user: { id: BOT },
      guilds: {
        cache: [{
          id: GUILD, name: 'Guild', members: { me: {} },
          channels: { cache: [
            { id: CHANNEL, name: 'general', type: 0, rawPosition: 1, permissionsFor: () => perms(['ViewChannel', 'SendMessages']) },
            { id: 'voice', name: 'voice', type: 2, permissionsFor: () => perms([]) },
          ] },
        }],
      },
    };
    const im = new DiscordIM(host, {
      channelAccess: { read: () => access.config, write: (c) => (access.config = c) },
      gatewayFactory: () => ({ connect: async () => undefined, destroy: async () => undefined, client: client as never, appId: 'a', botTag: 't' }),
    });
    im.registerIpc();

    const listing = (await handlers.get('discordBot:list-channels')!()) as { guilds: Array<{ channels: unknown[] }> };
    expect(listing.guilds[0].channels).toEqual([
      expect.objectContaining({
        id: CHANNEL,
        permissions: { view: true, send: true, readHistory: false, embed: false, attachFiles: false, sendInThreads: false },
      }),
    ]);

    const saved = await handlers.get('discordBot:set-channel-access')!({ channels: [{ guildId: GUILD, channelId: CHANNEL }, { guildId: 'bad' }] });
    expect(saved).toEqual({ channels: [{ guildId: GUILD, channelId: CHANNEL }] });
    expect(await handlers.get('discordBot:get-channel-access')!()).toEqual(saved);
  });
});

function deferredFetch() {
  const original = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = vi.fn(async () => {
    await gate;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as never;
  return { release, restore: () => { globalThis.fetch = original; } };
}
