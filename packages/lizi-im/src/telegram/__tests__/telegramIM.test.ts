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
      if (method === 'sendMessage' || method === 'sendRichMessage') {
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

  it('群里 owner 裸斜杠命令视为召唤(不带 @ 也进 slash); 成员裸命令仍静默', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '/project', fromId: 111, messageId: 55 }),
      groupMessage({ text: '/new', fromId: 222, messageId: 56 }),
      // 显式发给其它 bot 的命令: 本 bot 不抢答(多 bot 群, review P1)
      groupMessage({ text: '/new@another_bot', fromId: 111, messageId: 58 }),
      groupMessage({ text: '/nonsense extra args', fromId: 111, messageId: 57 }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    // owner 裸命令(55/57)按原文进事件流(slash 层消费);
    // 成员裸命令(56)与发给其它 bot 的命令(58)静默丢弃
    expect(events[0]).toMatchObject({ senderId: 'g/-100200', text: '/project' });
    expect(events[1]).toMatchObject({ senderId: 'g/-100200', text: '/nonsense extra args' });
  });

  it('名字召唤: 手打 "@显示名" 与句首裸名字都触发(非 username), 句中提到不触发', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      // 显示名 Cindy ≠ username my_cindy_bot: 手打 @Cindy 没有 mention entity
      groupMessage({ text: '@Cindy 你在?', fromId: 111, messageId: 30 }),
      groupMessage({ text: 'cindy 帮我看看这个', fromId: 222, messageId: 31 }),
      groupMessage({ text: '我问过 Cindy 了不用管', fromId: 111, messageId: 32 }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toMatchObject({ senderId: 'g/-100200', text: '你在?' });
    expect(events[1]).toMatchObject({ senderId: 'g/-100200', text: '帮我看看这个' });
  });

  it('群多人: 全员 @bot 可触发且共享同一条群 lane; 命令仍 owner 专属', async () => {
    const events: IMMessageEvent[] = [];
    const windowEntries: TelegramGroupWindowEntry[] = [];
    im.onMessage((e) => events.push(e));
    im.onGroupWindowMessage((e) => windowEntries.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: 'random chatter', fromId: 222, messageId: 10 }),
      groupMessage({ text: 'ping', fromId: 222, messageId: 11, mentionBot: true }),
      groupMessage({ text: '/new', fromId: 222, messageId: 13, mentionBot: true }),
      groupMessage({ text: '部署一下', fromId: 111, messageId: 12, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(windowEntries).toHaveLength(4));
    await vi.waitFor(() => expect(events).toHaveLength(2));
    // 一群一 lane(OpenClaw 模型): 成员与 owner 的触发进同一条会话,
    // speaker 标签区分发言人 — 群公共上下文连续。
    expect(events[0]).toMatchObject({
      senderId: 'g/-100200',
      text: 'ping',
      speaker: { id: '222', isOwner: false },
    });
    // 成员发命令(消息 13)被静默丢弃 — 只有两个事件
    expect(events[1]).toMatchObject({
      senderId: 'g/-100200',
      text: '部署一下',
      speaker: { id: '111', isOwner: true },
    });
    // 不再有陌生人礼貌回应(群成员全员可对话, D1)
    const notice = api.calls.find(
      (c) =>
        c.method === 'sendMessage' &&
        (c.params.reply_parameters as { message_id?: number })?.message_id === 11,
    );
    expect(notice).toBeUndefined();
  });

  it('群 lane 恒定: 成员/owner 回复 bot、反复裸 @ 都续同一条群会话(上下文连续)', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([groupMessage({ text: '这是啥项目', fromId: 222, messageId: 40, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].senderId).toBe('g/-100200');
    const sent = await im.sendText('g/-100200', '这是 Cindy 呀');
    const answerId = Number(sent.messageId.split('|')[1]);
    const replyTo = {
      message_id: answerId,
      from: { id: BOT.id, is_bot: true, first_name: 'Cindy' },
      chat: { id: -100200, type: 'supergroup' as const },
      date: 1_753_000_050,
      text: '这是 Cindy 呀',
    };
    // 成员回复 bot → 同一条群 lane
    api.pushUpdates([
      {
        update_id: 41,
        message: {
          message_id: 41,
          from: { id: 222, is_bot: false, first_name: 'F' },
          chat: { id: -100200, type: 'supergroup', title: 'Ops' },
          date: 1_753_000_100,
          text: '再多讲讲',
          reply_to_message: replyTo,
        },
      },
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1].senderId).toBe('g/-100200');
    // owner 回复同一条 bot 消息 → 也是同一条群 lane(接得上成员刚才的话头)
    api.pushUpdates([
      {
        update_id: 42,
        message: {
          message_id: 42,
          from: { id: 111, is_bot: false, first_name: 'U' },
          chat: { id: -100200, type: 'supergroup', title: 'Ops' },
          date: 1_753_000_200,
          text: '我来补充',
          reply_to_message: replyTo,
        },
      },
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events[2].senderId).toBe('g/-100200');
    // 换话题裸 @ → 仍是同一条 lane(群公共上下文不切碎; 要重开用 /new)
    api.pushUpdates([groupMessage({ text: '换个话题', fromId: 111, messageId: 80, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events[3].senderId).toBe('g/-100200');
  });

  it('陌生人私聊收到礼貌回应且 60s 内不重复', async () => {
    await connect();
    api.pushUpdates([privateMessage('hello?', 222, 90)]);
    await vi.waitFor(() => {
      expect(
        api.calls.some(
          (c) => c.method === 'sendMessage' && c.params.chat_id === '222',
        ),
      ).toBe(true);
    });
    const before = api.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === '222').length;
    api.pushUpdates([privateMessage('still there?', 222, 91)]);
    await new Promise((r) => setTimeout(r, 200));
    const after = api.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === '222').length;
    expect(after).toBe(before); // 冷却期内不再回
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

  it('群触发后的首条出站回挂触发消息(reply), 后续不重复回挂', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '帮我看看', fromId: 111, messageId: 60, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    await im.sendText(events[0].senderId, '第一条回复');
    await im.sendText(events[0].senderId, '第二条回复');
    const sends = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === '-100200',
    );
    expect(sends).toHaveLength(2);
    expect(sends[0].params.reply_parameters).toEqual({
      message_id: 60,
      allow_sending_without_reply: true,
    });
    expect(sends[1].params.reply_parameters).toBeUndefined();
  });

  it('连发两条触发排队时, 两轮输出各自挂回自己的提问(FIFO 配对, 不被后到覆盖)', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '第一问', fromId: 111, messageId: 60, mentionBot: true }),
      groupMessage({ text: '第二问', fromId: 222, messageId: 61, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    // 两轮输出按触发顺序先后开始(lane 内 turn 串行)
    await im.sendText(events[0].senderId, '答一');
    await im.sendText(events[0].senderId, '答二');
    const sends = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === '-100200',
    );
    expect(sends).toHaveLength(2);
    expect((sends[0].params.reply_parameters as { message_id: number }).message_id).toBe(60);
    expect((sends[1].params.reply_parameters as { message_id: number }).message_id).toBe(61);
  });

  it('私聊出站不回挂 reply', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([privateMessage('hi', 111, 61)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await im.sendText(events[0].senderId, '回复');
    const sent = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(sent.params.reply_parameters).toBeUndefined();
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

  it('相册 settle 期间同 chat 的后续消息保序: 先答相册再答追问', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    const member = (messageId: number, caption?: string): TgUpdate => ({
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: 111, is_bot: false, first_name: 'U' },
        chat: { id: 111, type: 'private' },
        date: 1_753_000_000,
        media_group_id: 'album-ord',
        ...(caption ? { caption } : {}),
        photo: [{ file_id: `f${messageId}`, file_unique_id: `u${messageId}`, width: 10, height: 10 }],
      },
    });
    // 同一批次: 相册两张 + 紧跟的追问文本 — 追问必须排在相册事件之后
    api.pushUpdates([member(35, '看这组图'), member(36), privateMessage('顺便再查个东西', 111, 37)]);
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 5000 });
    expect(events[0].text).toBe('看这组图');
    expect(events[1].text).toBe('顺便再查个东西');
  });

  it('相册处理(附件下载)未收口前, 持久化游标不越过相册首条 update', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    // 让 getFile 悬住 — 模拟 settle 已触发、附件仍在下载的处理窗口
    let releaseGetFile!: () => void;
    const gate = new Promise<void>((r) => (releaseGetFile = r));
    const origCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'getFile') {
        await gate;
      }
      return origCall(method, params, signal);
    }) as typeof api.call;
    const member = (messageId: number): TgUpdate => ({
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: 111, is_bot: false, first_name: 'U' },
        chat: { id: 111, type: 'private' },
        date: 1_753_000_000,
        media_group_id: 'album-cap',
        ...(messageId === 45 ? { caption: '慢速相册' } : {}),
        photo: [{ file_id: `f${messageId}`, file_unique_id: `u${messageId}`, width: 10, height: 10 }],
      },
    });
    api.pushUpdates([member(45), member(46)]);
    // 等 settle 触发进入下载(getFile 悬住), 此时游标不得越过 45
    await new Promise((r) => setTimeout(r, 1400));
    expect(events).toHaveLength(0);
    const persistedDuring = Number((ctx.secrets.get('telegram-updates-offset') ?? ':0').split(':')[1]);
    expect(persistedDuring).toBeLessThanOrEqual(45);
    // 放行下载 → 相册收口 → 游标补写越过整组
    releaseGetFile();
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 4000 });
    await vi.waitFor(() => {
      const persisted = Number((ctx.secrets.get('telegram-updates-offset') ?? ':0').split(':')[1]);
      expect(persisted).toBeGreaterThanOrEqual(47);
    });
  });

  it('相册(media_group)聚合为单个事件, 不各起一轮 turn', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    const albumMember = (messageId: number, caption?: string): TgUpdate => ({
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: 111, is_bot: false, first_name: 'U' },
        chat: { id: 111, type: 'private' },
        date: 1_753_000_000,
        media_group_id: 'album-1',
        ...(caption ? { caption } : {}),
        photo: [{ file_id: `f${messageId}`, file_unique_id: `u${messageId}`, width: 10, height: 10 }],
      },
    });
    api.pushUpdates([albumMember(31, '这三张图帮我看看'), albumMember(32), albumMember(33)]);
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 4000 });
    expect(events[0].text).toBe('这三张图帮我看看');
    // 假 API 的 getFile 不返回 file_path → 三张图都落 download 失败标注,
    // 关键断言是"三个成员合进同一个事件", 不是下载成功与否。
    expect(events[0].attachments.length + events[0].unsupported.length).toBe(3);
    // 静默窗后不再有第二个事件
    await new Promise((r) => setTimeout(r, 1300));
    expect(events).toHaveLength(1);
  });

  it('私聊回复消息携带 replyContext', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      {
        update_id: 51,
        message: {
          message_id: 51,
          from: { id: 111, is_bot: false, first_name: 'U' },
          chat: { id: 111, type: 'private' },
          date: 1_753_000_000,
          text: '按这个继续',
          reply_to_message: {
            message_id: 40,
            from: { id: BOT.id, is_bot: true, first_name: 'Cindy' },
            chat: { id: 111, type: 'private' },
            date: 1_752_999_000,
            text: '方案 A: 先改 transport',
          },
        },
      },
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].replyContext).toEqual({
      author: 'Cindy',
      text: '方案 A: 先改 transport',
      isBot: true,
    });
  });

  it('批次处理后持久化 offset, 重启从游标续读(不重放已处理消息)', async () => {
    await connect();
    api.pushUpdates([privateMessage('hi', 111, 41)]);
    await vi.waitFor(() => {
      expect(ctx.secrets.get('telegram-updates-offset')).toBe(`${BOT.id}:42`);
    });
    // 模拟重启: 同一 host secrets 上起新实例
    await im.dispose();
    const api2 = createFakeApi();
    const im2 = new TelegramIM(ctx.host, { apiFactory: () => api2 });
    await im2.init();
    await vi.waitFor(() => {
      const poll = api2.calls.find((c) => c.method === 'getUpdates');
      expect(poll?.params.offset).toBe(42);
    });
    await im2.dispose();
  });

  it('生命周期静默: dispose 与重启后的 init 不发任何 owner 播报(不刷屏)', async () => {
    await connect();
    // set-config 只发一次性 linked 确认; dispose 不追加任何播报。
    const afterLinked = api.calls.filter((c) => c.method === 'sendMessage').length;
    await im.dispose();
    expect(api.calls.filter((c) => c.method === 'sendMessage').length).toBe(afterLinked);
    // 模拟重启: 同一 host secrets 上起新实例, init 全程静默。
    const api2 = createFakeApi();
    const im2 = new TelegramIM(ctx.host, { apiFactory: () => api2 });
    await im2.init();
    expect(im2.getStatus().kind).toBe('connected');
    expect(api2.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    await im2.dispose();
    expect(api2.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it('DM 流式走 sendMessageDraft: 空占位→draft 更新→定稿真消息(不 edit)', async () => {
    await connect();
    const sendsBefore = api.calls.filter((c) => c.method === 'sendMessage').length;
    const handle = await im.startStreamingText(OWNER_ID);
    // 构造即推空 draft = 客户端原生 Thinking 占位
    await vi.waitFor(() => {
      expect(
        api.calls.some((c) => c.method === 'sendMessageDraft' && c.params.text === ''),
      ).toBe(true);
    });
    handle.replace('部分回答');
    await vi.waitFor(
      () => {
        expect(
          api.calls.some((c) => c.method === 'sendMessageDraft' && c.params.text === '部分回答'),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 50 },
    );
    // 同一 draft_id 连续更新(客户端动画的前提)
    const draftIds = new Set(
      api.calls.filter((c) => c.method === 'sendMessageDraft').map((c) => c.params.draft_id),
    );
    expect(draftIds.size).toBe(1);
    expect([...draftIds][0]).not.toBe(0);

    await handle.finalize('最终回答');
    // 定稿走 rich(markdown 直投 + 👍 特效), 不产生 sendMessage / edit
    const rich = api.calls.filter((c) => c.method === 'sendRichMessage');
    expect(rich.length).toBe(1);
    expect((rich[0].params.rich_message as { markdown?: string }).markdown).toBe('最终回答');
    expect(rich[0].params.message_effect_id).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'sendMessage').length).toBe(sendsBefore);
    expect(api.calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });

  it('rich 定稿 404(方法不可用)实例级 latch, 回落经典分段且后续不再尝试', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        api.calls.push({ method, params: params ?? {} });
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID);
    await handle.finalize('回答一');
    // rich 试了一次 → 404 latch → 回落 sendMessage
    expect(api.calls.filter((c) => c.method === 'sendRichMessage').length).toBe(1);
    expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);

    const handle2 = await im.startStreamingText(OWNER_ID);
    await handle2.finalize('回答二');
    expect(api.calls.filter((c) => c.method === 'sendRichMessage').length).toBe(1);
  });

  it('群 lane 流式仍走 send+edit 经典路径, 不用 draft; 定稿 rich 原地升级', async () => {
    await connect();
    const handle = await im.startStreamingText('g/-100200/r7');
    handle.replace('进行中');
    await handle.finalize('群里的最终回答');
    expect(api.calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);
    // 定稿是 editMessageText + rich_message(表格/LaTeX 原生渲染), 非 HTML edit
    const richEdits = api.calls.filter(
      (c) => c.method === 'editMessageText' && c.params.rich_message !== undefined,
    );
    expect(richEdits.length).toBe(1);
    expect((richEdits[0].params.rich_message as { markdown?: string }).markdown).toBe(
      '群里的最终回答',
    );
  });

  it('draft 400 失败: 本 turn 落回经典路径, 本实例后续 turn 不再尝试 draft', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessageDraft') {
        api.calls.push({ method, params: params ?? {} });
        throw new TelegramApiError('sendMessageDraft', 400, 'Bad Request: method not available');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID);
    // 首次 pushDraft 失败 → latch 到经典 handle(会先 send 一条占位消息)
    await vi.waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'sendMessageDraft').length).toBe(1);
    });
    handle.replace('落回后的内容');
    await handle.finalize('落回后的最终回答');
    expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);

    // 400 = 能力性失败, 实例级 latch: 新 turn 不再发 draft
    await im.startStreamingText(OWNER_ID);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.filter((c) => c.method === 'sendMessageDraft').length).toBe(1);
  });

  it('多图出站合成原生相册(sendMediaGroup), 单图仍走 sendPhoto', async () => {
    await connect();
    const img = (name: string) => {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, 'fake-png');
      return p;
    };
    // 多图: 相册一条
    const handle = await im.startStreamingText(OWNER_ID);
    handle.addExtraImageAbsPath?.(img('a.png'));
    handle.addExtraImageAbsPath?.(img('b.png'));
    handle.addExtraImageAbsPath?.(img('c.png'));
    await handle.finalize('三张图的回答');
    expect(api.calls.filter((c) => c.method === 'sendMediaGroup').length).toBe(1);
    expect(api.calls.filter((c) => c.method === 'sendPhoto').length).toBe(0);
    // 单图: 不动用相册
    const handle2 = await im.startStreamingText(OWNER_ID);
    handle2.addExtraImageAbsPath?.(img('d.png'));
    await handle2.finalize('一张图的回答');
    expect(api.calls.filter((c) => c.method === 'sendMediaGroup').length).toBe(1);
    expect(api.calls.filter((c) => c.method === 'sendPhoto').length).toBe(1);
  });

  it('connect 后把命令菜单注册到 owner scope; disconnect 清理', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      commandMenu: [{ command: 'help', description: '帮助' }],
    });
    im.registerIpc();
    await connect();
    const reg = api.calls.find((c) => c.method === 'setMyCommands');
    expect(reg).toBeTruthy();
    expect(reg!.params.scope).toEqual({ type: 'chat', chat_id: Number(OWNER_ID) });
    await ctx.handlers.get('telegramBot:disconnect')!();
    expect(api.calls.some((c) => c.method === 'deleteMyCommands')).toBe(true);
  });

  it('行为配置: emoji off 不放任何表情; DM replyQuote=first 首条回复挂回', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'first', replyQuoteDm: 'first' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    // emoji off: reactToMessage 直接返回 null, 不发 setMessageReaction
    expect(await im.reactToMessage('111|5', '👍')).toBeNull();
    expect(api.calls.some((c) => c.method === 'setMessageReaction')).toBe(false);
    // DM replyQuote=first: 首条回复挂回触发消息, 第二条不挂
    api.pushUpdates([privateMessage('问个事', 111, 95)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await im.sendText(OWNER_ID, '第一条');
    await im.sendText(OWNER_ID, '第二条');
    const dmSends = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID,
    );
    const withReply = dmSends.filter((c) => c.params.reply_parameters !== undefined);
    expect(withReply).toHaveLength(1);
    expect((withReply[0].params.reply_parameters as { message_id: number }).message_id).toBe(95);
  });

  it('全响应·自主判断: always 群未召唤消息进 ambient turn, 表情静默, NO_REPLY 删占位', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({
        emojiReactions: 'minimal',
        replyQuoteGroup: 'first',
        replyQuoteDm: 'off',
        groupActivation: { '-100200': 'always' },
      }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    // 未 @ 的普通消息也进 turn, 带 ambient 标记
    api.pushUpdates([groupMessage({ text: '今天天气不错', fromId: 222, messageId: 50 })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].ambient).toBe(true);
    expect(events[0].senderId).toBe('g/-100200');
    // ambient 触发的表情回应被抑制
    expect(await im.reactToMessage('-100200|50', '👀')).toBeNull();
    // ambient 路径不消费成员命令(owner 裸命令走显式召唤通道, 另有用例)
    api.pushUpdates([groupMessage({ text: '/new', fromId: 222, messageId: 51 })]);
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(1);
    // NO_REPLY 哨兵: 惰性占位下从头到尾零消息(不发送、无需删除 — 真零痕迹)
    const sendsBefore = api.calls.filter((c) => c.method === 'sendMessage').length;
    const handle = await im.startStreamingText('g/-100200');
    handle.replace('NO_REPLY');
    await handle.finalize('NO_REPLY');
    expect(api.calls.filter((c) => c.method === 'sendMessage').length).toBe(sendsBefore);
    expect(api.calls.some((c) => c.method === 'deleteMessage')).toBe(false);
    expect(
      api.calls.some(
        (c) => c.method === 'editMessageText' || c.method === 'sendRichMessage',
      ),
    ).toBe(false);
  });

  it('typing: DM 与群触发都持续 typing, 首条真实消息发出即停', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    // DM: 收到消息即 typing
    api.pushUpdates([privateMessage('查个东西', 111, 97)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await vi.waitFor(() => {
      expect(
        api.calls.some((c) => c.method === 'sendChatAction' && c.params.chat_id === '111'),
      ).toBe(true);
    });
    // 发出首条真实消息 → typing 循环停(不再有新的 sendChatAction)
    await im.sendText(OWNER_ID, '答复');
    const countAfterSend = api.calls.filter((c) => c.method === 'sendChatAction').length;
    await new Promise((r) => setTimeout(r, 120));
    expect(api.calls.filter((c) => c.method === 'sendChatAction').length).toBe(countAfterSend);
    // 群触发同样 typing
    api.pushUpdates([groupMessage({ text: '帮个忙', fromId: 111, messageId: 98, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await vi.waitFor(() => {
      expect(
        api.calls.some((c) => c.method === 'sendChatAction' && c.params.chat_id === '-100200'),
      ).toBe(true);
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
