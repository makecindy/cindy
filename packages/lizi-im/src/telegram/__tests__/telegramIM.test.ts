/**
 * TelegramIM 主类测试: 配置流转(保存/回滚)、轮询状态映射(401/409)、
 * owner 过滤、群窗口数据面、群触发 lane 路由与出站目标解码。
 * Bot API 用假客户端(apiFactory 注入), 不出网。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent } from '../../types.js';
import { TelegramApiError, type TelegramApiClient, type TgUpdate } from '../api.js';
import { TelegramIM, type TelegramGroupWindowEntry } from '../index.js';

const BOT = { id: 999, is_bot: true, first_name: 'Cindy', username: 'my_cindy_bot' };
const OWNER_ID = '111';

interface FakeApi extends TelegramApiClient {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  pushUpdates(updates: TgUpdate[]): void;
  failNextGetUpdates(err: Error): void;
}

function createFakeApi(opts: { getMeError?: Error } = {}): FakeApi {
  const pending: TgUpdate[][] = [];
  let waiter: ((u: TgUpdate[]) => void) | null = null;
  let nextFailure: Error | null = null;
  let sentSeq = 1000;

  const api: FakeApi = {
    calls: [],
    pushUpdates(updates) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(updates);
      } else {
        pending.push(updates);
      }
    },
    failNextGetUpdates(err) {
      nextFailure = err;
      if (waiter) {
        const w = waiter;
        waiter = null;
        // 让挂起的长轮询立刻以失败返回
        w([]);
      }
    },
    fileUrl: (p) => `https://files.local/${p}`,
    async callForm(method) {
      api.calls.push({ method, params: {} });
      sentSeq += 1;
      return { message_id: sentSeq, chat: { id: -100, type: 'supergroup' }, date: 1 } as never;
    },
    async call(method, params = {}, signal) {
      api.calls.push({ method, params });
      if (method === 'getMe') {
        if (opts.getMeError) throw opts.getMeError;
        return BOT as never;
      }
      if (method === 'getUpdates') {
        if (nextFailure) {
          const err = nextFailure;
          nextFailure = null;
          throw err;
        }
        const batch = pending.shift();
        if (batch) return batch as never;
        return new Promise((resolve, reject) => {
          waiter = (u) => {
            if (nextFailure) {
              const err = nextFailure;
              nextFailure = null;
              reject(err);
              return;
            }
            resolve(u as never);
          };
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (method === 'sendMessage') {
        sentSeq += 1;
        return {
          message_id: sentSeq,
          chat: { id: Number(params.chat_id), type: Number(params.chat_id) < 0 ? 'supergroup' : 'private' },
          date: 1,
        } as never;
      }
      return {} as never;
    },
  };
  return api;
}

function createHost(tmpDir: string): { host: IMHost; broadcasts: unknown[]; secrets: Map<string, string>; handlers: Map<string, (p?: unknown) => Promise<unknown> | unknown> } {
  const secrets = new Map<string, string>();
  const broadcasts: unknown[] = [];
  const handlers = new Map<string, (p?: unknown) => Promise<unknown> | unknown>();
  const host: IMHost = {
    secrets: {
      write: (name, value) => (secrets.set(name, value), true),
      read: (name) => secrets.get(name) ?? null,
      remove: (name) => void secrets.delete(name),
      isAvailable: () => true,
    },
    ipc: {
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: (_channel, payload) => void broadcasts.push(payload),
    },
    paths: { feishuMediaDir: tmpDir, telegramMediaDir: tmpDir },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, broadcasts, secrets, handlers };
}

function privateMessage(text: string, fromId: number, messageId = 1): TgUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: fromId, is_bot: false, first_name: 'U' },
      chat: { id: fromId, type: 'private' },
      date: 1_753_000_000,
      text,
    },
  };
}

function groupMessage(args: {
  text: string;
  fromId: number;
  messageId: number;
  mentionBot?: boolean;
  threadId?: number;
}): TgUpdate {
  const text = args.mentionBot ? `@${BOT.username} ${args.text}` : args.text;
  return {
    update_id: args.messageId,
    message: {
      message_id: args.messageId,
      from: { id: args.fromId, is_bot: false, first_name: 'U' },
      chat: { id: -100200, type: 'supergroup', title: 'Ops' },
      date: 1_753_000_000,
      text,
      ...(args.mentionBot
        ? { entities: [{ type: 'mention', offset: 0, length: BOT.username.length + 1 }] }
        : {}),
      ...(args.threadId !== undefined
        ? { message_thread_id: args.threadId, is_topic_message: true }
        : {}),
    },
  };
}

let tmpDir: string;
let api: FakeApi;
let im: TelegramIM;
let ctx: ReturnType<typeof createHost>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-im-test-'));
  api = createFakeApi();
  ctx = createHost(tmpDir);
  im = new TelegramIM(ctx.host, { apiFactory: () => api });
  im.registerIpc();
});

afterEach(async () => {
  await im.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function connect(): Promise<void> {
  const handler = ctx.handlers.get('telegramBot:set-config')!;
  await handler({ token: '999:secret-token-abcdefghijk', ownerUserId: OWNER_ID });
}

describe('TelegramIM', () => {
  it('无 token 时 init 保持 idle, 不发任何请求', async () => {
    await im.init();
    expect(im.getStatus()).toEqual({ kind: 'idle' });
    expect(api.calls).toHaveLength(0);
  });

  it('set-config 成功: 保存凭证、connected、getUpdates 拉起、owner 收到 linked 通知', async () => {
    await connect();
    expect(im.getStatus()).toEqual({ kind: 'connected', appId: String(BOT.id) });
    expect(ctx.secrets.get('telegram-bot-token')).toBe('999:secret-token-abcdefghijk');
    expect(ctx.secrets.get('telegram-owner-user-id')).toBe(OWNER_ID);
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
    const linked = api.calls.find((c) => c.method === 'sendMessage');
    expect(linked?.params.chat_id).toBe(OWNER_ID);
  });

  it('set-config 失败(401): 状态 error 且凭证回滚', async () => {
    api = createFakeApi({ getMeError: new TelegramApiError('getMe', 401, 'Unauthorized') });
    ctx = createHost(tmpDir);
    im = new TelegramIM(ctx.host, { apiFactory: () => api });
    im.registerIpc();
    const result = (await ctx.handlers.get('telegramBot:set-config')!({
      token: '999:bad-token-abcdefghijklmn',
      ownerUserId: OWNER_ID,
    })) as { saveErrorStatus?: { kind: string } };
    expect(result.saveErrorStatus?.kind).toBe('error');
    expect(ctx.secrets.has('telegram-bot-token')).toBe(false);
  });

  it('私聊: 非 owner 忽略, owner 消息进 onMessage', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([privateMessage('from stranger', 222, 1), privateMessage('hi', 111, 2)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      channelName: 'telegram',
      senderId: OWNER_ID,
      contextId: String(BOT.id),
      text: 'hi',
      messageId: '111|2',
    });
  });

  it('群消息全部进窗口; 仅 owner @bot 触发 lane 事件', async () => {
    const events: IMMessageEvent[] = [];
    const windowEntries: TelegramGroupWindowEntry[] = [];
    im.onMessage((e) => events.push(e));
    im.onGroupWindowMessage((e) => windowEntries.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: 'random chatter', fromId: 222, messageId: 10 }),
      groupMessage({ text: 'ping', fromId: 222, messageId: 11, mentionBot: true }),
      groupMessage({ text: '部署一下', fromId: 111, messageId: 12, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(windowEntries).toHaveLength(3));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ senderId: 'g/-100200', text: '部署一下' });
  });

  it('topic 消息的 lane 带 threadId, 出站解码回 message_thread_id', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: 'go', fromId: 111, messageId: 20, mentionBot: true, threadId: 77 }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].senderId).toBe('g/-100200/77');

    await im.sendText(events[0].senderId, 'reply');
    const sent = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(sent.params.chat_id).toBe('-100200');
    expect(sent.params.message_thread_id).toBe(77);
  });

  it('出站群回复回流进窗口(isBot 条目)', async () => {
    const windowEntries: TelegramGroupWindowEntry[] = [];
    im.onGroupWindowMessage((e) => windowEntries.push(e));
    await connect();
    await im.sendMarkdownText('g/-100200', '**done**');
    const echo = windowEntries.at(-1)!;
    expect(echo.author.isBot).toBe(true);
    expect(echo.chatId).toBe('-100200');
  });

  it('getUpdates 409 → conflict 状态', async () => {
    await connect();
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
    api.failNextGetUpdates(new TelegramApiError('getUpdates', 409, 'Conflict'));
    await vi.waitFor(() => {
      expect(im.getStatus()).toEqual({ kind: 'conflict', appId: String(BOT.id) });
    });
  });

  it('disconnect 清空凭证并回 idle', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:disconnect')!();
    expect(im.getStatus()).toEqual({ kind: 'idle' });
    expect(ctx.secrets.has('telegram-bot-token')).toBe(false);
    expect(ctx.secrets.has('telegram-owner-user-id')).toBe(false);
  });
});
