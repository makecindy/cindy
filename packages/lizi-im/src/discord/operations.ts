/** Narrow operations over the already connected bot. Never exposes REST or credentials. */
import { ChannelType, type Channel, type Client } from 'discord.js';
import { decodeDiscordLaneUserId, discordLaneOfChannel, discordLaneTargetChannelId, encodeDiscordLaneUserId, type DiscordLane } from './lane.js';

export interface DiscordHistoryMessage {
  id: string;
  channelId: string;
  author: { id: string; name: string; bot: boolean };
  text: string;
  timestamp: number;
  contentUnavailable: boolean;
  attachments: Array<{ id: string; name: string; url: string; size: number; contentType?: string }>;
}

export class DiscordOperationError extends Error {
  constructor(readonly code: string, readonly retryAfter?: number) { super(code); }
}

export function discordOperationFailure(error: unknown): { ok: false; errorCode: string; retryAfter?: number } {
  if (error instanceof DiscordOperationError) return { ok: false, errorCode: error.code, ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) };
  const e = error as { status?: number; code?: number; retry_after?: number; retryAfter?: number } | null;
  const code = e?.status === 403 || e?.code === 50001 || e?.code === 50013 ? 'DISCORD_PERMISSION_DENIED'
    : e?.status === 404 ? 'DISCORD_NOT_FOUND' : e?.status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_OPERATION_UNCONFIRMED';
  const retryAfter = e?.retry_after ?? e?.retryAfter;
  return { ok: false, errorCode: code, ...(typeof retryAfter === 'number' ? { retryAfter } : {}) };
}

export function discordHistoryMessage(raw: unknown): DiscordHistoryMessage {
  const m = raw as { id: string; channel_id: string; author?: { id: string; username?: string; global_name?: string; bot?: boolean }; content?: string; timestamp?: string; attachments?: Array<{ id: string; filename: string; url: string; size: number; content_type?: string }> };
  const attachments = (m.attachments ?? []).map(a => ({ id: a.id, name: a.filename, url: a.url, size: a.size, ...(a.content_type ? { contentType: a.content_type } : {}) }));
  return { id: m.id, channelId: m.channel_id, author: { id: m.author?.id ?? '', name: m.author?.global_name ?? m.author?.username ?? 'unknown', bot: m.author?.bot === true }, text: m.content ?? '', timestamp: Date.parse(m.timestamp ?? '') || 0, contentUnavailable: !m.content && !attachments.length, attachments };
}

/** Threads inherit only a GuildText parent, matching the gateway's supported lanes. */
function guildTextLane(client: Client, channel: Channel): DiscordLane | null {
  if (!('guildId' in channel)) return null;
  const lane = discordLaneOfChannel(channel.guildId, channel.id, channel);
  if (!lane) return null;
  if (!lane.threadId) return channel.type === ChannelType.GuildText ? lane : null;
  // Use the fetched thread object / connected cache; never fetch another channel for discovery.
  const parent = ('parent' in channel ? channel.parent : null) ?? client.channels.cache.get(lane.channelId);
  return parent?.type === ChannelType.GuildText && parent.id === lane.channelId && parent.guildId === lane.guildId
    ? lane : null;
}

export function createDiscordOperations(deps: {
  client(): Client | null;
  assertCurrent(): void;
  laneEnabled(lane: DiscordLane): boolean;
  ownerId: string;
  boundLane?: string;
  authorizationStamp?(lane: string): string;
}) {
  const grants = new Map<string, string>();
  const assertGrant = (lane: string) => {
    const current = deps.authorizationStamp?.(lane);
    if (current === undefined) return;
    const previous = grants.get(lane);
    if (previous !== undefined && previous !== current) throw new DiscordOperationError('DISCORD_AUTHORIZATION_CHANGED');
    grants.set(lane, current);
  };
  if (deps.boundLane) assertGrant(deps.boundLane);
  const check = () => {
    deps.assertCurrent();
    const client = deps.client();
    if (!client?.user) throw new DiscordOperationError('DISCORD_NOT_CONNECTED');
    return client;
  };
  const assertLane = (laneId: string) => {
    const client = check();
    if (deps.boundLane && deps.boundLane !== laneId) throw new DiscordOperationError('DISCORD_LANE_DENIED');
    const lane = decodeDiscordLaneUserId(laneId);
    if (laneId.startsWith('g/') && !lane) throw new DiscordOperationError('DISCORD_INVALID_LANE');
    if (lane ? !deps.laneEnabled(lane) : laneId !== deps.ownerId) throw new DiscordOperationError('DISCORD_LANE_DENIED');
    assertGrant(laneId);
    return { client, lane };
  };
  const target = async (laneId: string, permission: 'read' | 'send' | 'view' = 'read') => {
    const { client, lane } = assertLane(laneId);
    const channel = lane
      ? await client.channels.fetch(discordLaneTargetChannelId(lane))
      : await client.users.createDM(deps.ownerId);
    assertLane(laneId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) throw new DiscordOperationError('DISCORD_CHANNEL_UNAVAILABLE');
    if (lane) {
      const actual = guildTextLane(client, channel);
      if (!actual || encodeDiscordLaneUserId(actual) !== laneId) throw new DiscordOperationError('DISCORD_LANE_DENIED');
      if (!('permissionsFor' in channel)) throw new DiscordOperationError('DISCORD_PERMISSION_DENIED');
      const permissions = channel.permissionsFor(client.user!);
      if (!permissions?.has('ViewChannel') || (permission === 'read' && !permissions.has('ReadMessageHistory')) ||
          (permission === 'send' && !permissions.has(lane.threadId ? 'SendMessagesInThreads' : 'SendMessages'))) throw new DiscordOperationError('DISCORD_PERMISSION_DENIED');
    } else if (!('recipientId' in channel) || channel.recipientId !== deps.ownerId) throw new DiscordOperationError('DISCORD_LANE_DENIED');
    return { channel, client, lane };
  };
  const readMessage = async (laneId: string, messageId: string) => {
    if (!/^\d{1,25}$/.test(messageId)) throw new DiscordOperationError('DISCORD_INVALID_MESSAGE_ID');
    const { client, channel } = await target(laneId);
    assertLane(laneId);
    const raw = await client.rest.get(`/channels/${channel.id}/messages/${messageId}`);
    assertLane(laneId);
    const message = discordHistoryMessage(raw);
    if (message.channelId !== channel.id) throw new DiscordOperationError('DISCORD_LANE_DENIED');
    return message;
  };
  return {
    assertCurrent: () => {
      deps.assertCurrent();
      for (const lane of grants.keys()) assertGrant(lane);
      if (!deps.boundLane) return;
      const lane = decodeDiscordLaneUserId(deps.boundLane);
      if (lane ? !deps.laneEnabled(lane) : deps.boundLane !== deps.ownerId) throw new DiscordOperationError('DISCORD_LANE_DENIED');
    },
    async listChannels() {
      const client = check();
      if (deps.boundLane) {
        const { channel } = await target(deps.boundLane, 'view');
        return { lanes: [{ laneId: deps.boundLane, name: 'name' in channel ? channel.name : channel.id }], incomplete: false };
      }
      const lanes: Array<{ laneId: string; name: string; thread: boolean }> = [];
      for (const channel of client.channels.cache.values()) {
        const lane = guildTextLane(client, channel);
        if (!lane || !deps.laneEnabled(lane) || !('permissionsFor' in channel) || !channel.permissionsFor(client.user!)?.has('ViewChannel')) continue;
        lanes.push({ laneId: encodeDiscordLaneUserId(lane), name: channel.name ?? channel.id, thread: !!lane.threadId });
      }
      return { lanes, incomplete: true, note: 'Connected cache only; use list_threads for archived public threads. Private threads require bot membership.' };
    },
    async listThreads(laneId: string, before?: string) {
      const { client, lane, channel } = await target(laneId);
      if (!lane || lane.threadId || deps.boundLane) throw new DiscordOperationError('DISCORD_LANE_DENIED');
      const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) });
      const page = await client.rest.get(`/channels/${channel.id}/threads/archived/public`, { query }) as { threads: Array<{ id: string; parent_id: string; guild_id: string; name: string }>; has_more: boolean };
      assertLane(laneId);
      return { threads: page.threads.filter(t => t.guild_id === lane.guildId && t.parent_id === lane.channelId).map(t => ({ laneId: encodeDiscordLaneUserId({ ...lane, threadId: t.id }), name: t.name })), hasMore: page.has_more, incomplete: true, note: 'Archived public threads; active/joined threads also appear in list_channels.' };
    },
    async history(laneId: string, options: { before?: string; after?: string; limit?: number } = {}) {
      const { client, channel } = await target(laneId);
      assertLane(laneId);
      const limit = Math.min(50, Math.max(1, options.limit ?? 50));
      const query = new URLSearchParams({ limit: String(limit), ...(options.before ? { before: options.before } : {}), ...(options.after ? { after: options.after } : {}) });
      const raw = await client.rest.get(`/channels/${channel.id}/messages`, { query }) as unknown[];
      assertLane(laneId);
      return { messages: raw.map(discordHistoryMessage).filter(m => m.channelId === channel.id).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1), incomplete: raw.length >= limit };
    },
    getMessage: readMessage,
    async prepareSend(laneId: string) {
      const { channel, client } = await target(laneId, 'send');
      assertLane(laneId);
      return {
        assertCurrent: () => { assertLane(laneId); },
        send: async (text: string, nonce: string) => {
          assertLane(laneId);
          const sent = await client.rest.post(`/channels/${channel.id}/messages`, { body: { content: text, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } } }) as { id: string };
          assertLane(laneId);
          return sent.id;
        },
      };
    },
    async search(laneId: string, content: string, offset = 0) {
      const { client, lane, channel } = await target(laneId);
      if (!lane) throw new DiscordOperationError('DISCORD_GUILD_SEARCH_ONLY');
      const query = new URLSearchParams({ content, channel_id: channel.id, limit: '25', offset: String(offset), include_nsfw: 'true' });
      assertLane(laneId);
      // discord.js 14.27 has no search helper; use its authenticated, rate-limited REST client.
      const page = await client.rest.get(`/guilds/${lane.guildId}/messages/search`, { query }) as { code?: number; retry_after?: number; messages?: unknown[][]; total_results?: number };
      assertLane(laneId);
      if (page.code === 110000) throw new DiscordOperationError('DISCORD_SEARCH_INDEXING', Math.max(1, page.retry_after ?? 1));
      if (!Array.isArray(page.messages)) throw new DiscordOperationError('DISCORD_SEARCH_UNAVAILABLE');
      // Search bundles neighboring messages. Never return a neighboring lane or parent channel.
      const seen = new Set<string>();
      const messages = page.messages.flat().map(discordHistoryMessage).filter(m => m.channelId === channel.id && !seen.has(m.id) && !!seen.add(m.id));
      return { messages, totalResults: page.total_results, nextOffset: offset + page.messages.length, incomplete: true };
    },
    async send(laneId: string, text: string, replyTo?: string, nonce?: string) {
      const { channel, client } = await target(laneId, 'send');
      assertLane(laneId);
      const sent = await client.rest.post(`/channels/${channel.id}/messages`, { body: { content: text, allowed_mentions: { parse: [] }, ...(replyTo ? { message_reference: { message_id: replyTo, channel_id: channel.id, fail_if_not_exists: true } } : {}), ...(nonce ? { nonce, enforce_nonce: true } : {}) } }) as { id: string };
      assertLane(laneId);
      return { messageId: sent.id, channelId: channel.id };
    },
    async sendFile(laneId: string, file: string, name?: string) {
      const { channel } = await target(laneId, 'send');
      if (!channel.isSendable()) throw new DiscordOperationError('DISCORD_CHANNEL_UNAVAILABLE');
      assertLane(laneId);
      const sent = await channel.send({ files: [{ attachment: file, name }], allowedMentions: { parse: [] } });
      assertLane(laneId);
      return { messageId: sent.id, channelId: channel.id };
    },
    async changeOwnMessage(laneId: string, messageId: string, text?: string) {
      const message = await readMessage(laneId, messageId);
      const { client, channel } = await target(laneId, 'send');
      if (message.author.id !== client.user!.id) throw new DiscordOperationError('DISCORD_NOT_OWN_MESSAGE');
      assertLane(laneId);
      if (text === undefined) await client.rest.delete(`/channels/${channel.id}/messages/${messageId}`);
      else await client.rest.patch(`/channels/${channel.id}/messages/${messageId}`, { body: { content: text, allowed_mentions: { parse: [] } } });
      assertLane(laneId);
      return { messageId };
    },
    async reaction(laneId: string, messageId: string, emoji: string, remove = false) {
      const { client, channel } = await target(laneId);
      assertLane(laneId);
      const route = `/channels/${channel.id}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me` as const;
      if (remove) await client.rest.delete(route); else await client.rest.put(route);
      assertLane(laneId);
      return { messageId };
    },
  };
}

export type DiscordOperations = ReturnType<typeof createDiscordOperations>;
