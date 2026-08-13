/**
 * TelegramIM 主类测试: 配置流转(保存/回滚)、轮询状态映射(401/409)、
 * owner 过滤、群窗口数据面、群触发 lane 路由与出站目标解码。
 * Bot API 用假客户端(apiFactory 注入), 不出网。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMCardActionEvent, IMHost, IMMessageEvent } from '../../types.js';
import { TelegramApiError, type TelegramApiClient, type TgUpdate } from '../api.js';
import { encodeCallbackData, encodeMessageId } from '../codec.js';
import { TelegramIM, type TelegramGroupWindowEntry } from '../index.js';

const BOT = { id: 999, is_bot: true, first_name: 'Cindy', username: 'my_cindy_bot' };
const OWNER_ID = '111';

interface FakeApi extends TelegramApiClient {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  pushUpdates(updates: TgUpdate[]): void;
  failNextGetUpdates(err: Error): void;
  failNextCall(method: string, err: Error): void;
}

function createFakeApi(opts: { getMeError?: Error } = {}): FakeApi {
  const pending: TgUpdate[][] = [];
  let waiter: ((u: TgUpdate[]) => void) | null = null;
  let nextFailure: Error | null = null;
  let nextCallFailure: { method: string; err: Error } | null = null;
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
    failNextCall(method, err) {
      nextCallFailure = { method, err };
    },
    fileUrl: (p) => `https://files.local/${p}`,
    async callForm(method) {
      api.calls.push({ method, params: {} });
      sentSeq += 1;
      return { message_id: sentSeq, chat: { id: -100, type: 'supergroup' }, date: 1 } as never;
    },
    async call(method, params = {}, signal) {
      api.calls.push({ method, params });
      if (nextCallFailure?.method === method) {
        const { err } = nextCallFailure;
        nextCallFailure = null;
        throw err;
      }
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
      readResult: (name) =>
        secrets.has(name)
          ? { kind: 'value', value: secrets.get(name)! }
          : { kind: 'missing' },
      remove: (name) => void secrets.delete(name),
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code, message) => {
        const error = Object.assign(new Error(`[${code}] ${message}`), { code });
        throw error;
      },
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: (_channel, payload) => void broadcasts.push(payload),
    },
    paths: { feishuMediaDir: tmpDir, telegramMediaDir: tmpDir },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, broadcasts, secrets, handlers };
}

/**
 * 固件消息默认「刚刚到达」。
 *
 * 写死一个过去的时间戳会让每条固件消息都撞上离线积压判据(STALE_MESSAGE_MS);
 * 这些固件模拟的本来就是实时到达的 update, 时间戳按当下取。要造陈旧消息的
 * 用例显式传 `ageSec`。
 */
function nowSec(ageSec = 0): number {
  return Math.floor(Date.now() / 1_000) - ageSec;
}

function privateMessage(text: string, fromId: number, messageId = 1, ageSec = 0): TgUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: fromId, is_bot: false, first_name: 'U' },
      chat: { id: fromId, type: 'private' },
      date: nowSec(ageSec),
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
  hasProtectedContent?: boolean;
  ageSec?: number;
}): TgUpdate {
  const text = args.mentionBot ? `@${BOT.username} ${args.text}` : args.text;
  return {
    update_id: args.messageId,
    message: {
      message_id: args.messageId,
      from: { id: args.fromId, is_bot: false, first_name: 'U' },
      chat: { id: -100200, type: 'supergroup', title: 'Ops' },
      date: nowSec(args.ageSec),
      text,
      ...(args.hasProtectedContent ? { has_protected_content: true } : {}),
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

  it('set-config 连接失败且旧 secret 回滚写失败: 落下线闩锁, 重启不得用混合配置上线', async () => {
    await im.dispose();
    const oldToken = '999:old-token-abcdefghijklmnop';
    const newToken = '888:new-token-abcdefghijklmnop';
    const oldApi = createFakeApi();
    const rejectedApi = createFakeApi({
      getMeError: new TelegramApiError('getMe', 401, 'Unauthorized'),
    });
    im = new TelegramIM(ctx.host, {
      apiFactory: (token) => (token === oldToken ? oldApi : rejectedApi),
    });
    im.registerIpc();
    const handler = ctx.handlers.get('telegramBot:set-config')!;
    await handler({ token: oldToken, ownerUserId: OWNER_ID });
    expect(im.getStatus().kind).toBe('connected');

    const originalWrite = ctx.host.secrets.write;
    ctx.host.secrets.write = (name, value) => {
      // 新 token 已经落盘；模拟连接失败后恢复旧 token 时安全存储拒写。
      if (name === 'telegram-bot-token' && value === oldToken) return false;
      return originalWrite(name, value);
    };
    const result = (await handler({ token: newToken, ownerUserId: '222' })) as {
      status: { kind: string };
      saveErrorStatus?: { kind: string };
    };

    expect(result.status.kind).toBe('error');
    expect(result.saveErrorStatus?.kind).toBe('error');
    expect(ctx.secrets.get('telegram-bot-token')).toBe(newToken);
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');
    ctx.host.secrets.write = originalWrite;

    // 模拟重启：即使磁盘仍是未完成回滚的新 token，也只能停在 offline，零联网。
    await im.dispose();
    const rebootApi = createFakeApi();
    const rebooted = new TelegramIM(ctx.host, { apiFactory: () => rebootApi });
    await rebooted.init();
    expect(rebooted.getStatus().kind).toBe('offline');
    expect(rebootApi.calls).toHaveLength(0);
    await rebooted.dispose();
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

  it('受保护群的消息一个字都不落本地窗口, 但仍可照常触发一轮', async () => {
    // 「禁止保存内容」的群: 与官方 bot 服务端「has_protected_content 的消息
    // 不中继」同一条边界 —— 本地池是个人 bot 的记忆, 不能成为绕过它的通道。
    // 触发判定不受影响: owner @ 机器人照常起 turn, 只是不留历史。
    const events: IMMessageEvent[] = [];
    const windowEntries: TelegramGroupWindowEntry[] = [];
    im.onMessage((e) => events.push(e));
    im.onGroupWindowMessage((e) => windowEntries.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '机密闲聊', fromId: 222, messageId: 40, hasProtectedContent: true }),
      groupMessage({
        text: '看一下',
        fromId: 111,
        messageId: 41,
        mentionBot: true,
        hasProtectedContent: true,
      }),
      // 同一用例里放一条未保护消息, 证明判据只挡带标的那些。
      groupMessage({ text: '普通闲聊', fromId: 222, messageId: 42 }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await vi.waitFor(() => expect(windowEntries).toHaveLength(1));
    expect(events[0]).toMatchObject({ senderId: 'g/-100200', text: '看一下' });
    expect(windowEntries[0]).toMatchObject({ messageId: '42', text: '普通闲聊' });
    expect(windowEntries.some((e) => e.text.includes('机密'))).toBe(false);
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
      date: nowSec(150),
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
          date: nowSec(100),
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
          date: nowSec(0),
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

  it('群里的授权卡改投宿主私聊: 不落群、带触发消息深链、不吃回挂配额', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '改一下代码', fromId: 111, messageId: 70, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    await im.sendInteractiveCard(
      events[0].senderId,
      {
        title: '需要授权',
        body: '要修改 src/app.ts 吗？',
        buttons: [{ id: 'allow', label: '允许', type: 'primary' }],
      },
      // 授权卡由调用方点名转私聊, 并把用户可见说明与**本轮触发消息 id** 一起传进来
      // (传输层不造文案, 也不猜这张卡属于哪一轮)
      {
        deliverToOwnerDm: true,
        ownerDmNote: '群聊里的任务需要你授权。',
        ownerDmSourceMessageId: events[0].messageId,
      },
    );
    const card = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    // 群里的授权卡消不掉, 且只有 owner 能回答它 —— 一律投宿主私聊, 群里一条都不发
    expect(card.params.chat_id).toBe(OWNER_ID);
    expect(
      api.calls.some((c) => c.method === 'sendMessage' && c.params.chat_id === '-100200'),
    ).toBe(false);
    // 私聊里看不出是哪个群问的, 所以带触发消息深链(-100 前缀私有超级群)
    expect(String(card.params.text)).toContain('https://t.me/c/200/70');
    // 群里的回挂目标不被卡片消耗: 本轮真正的回答仍然挂回那条提问
    expect(card.params.reply_parameters).toBeUndefined();
    await im.sendText(events[0].senderId, '改完了');
    const answer = api.calls
      .filter((c) => c.method === 'sendMessage' && c.params.chat_id === '-100200')
      .at(-1)!;
    expect(answer.params.reply_parameters).toEqual({
      message_id: 70,
      allow_sending_without_reply: true,
    });
  });

  it('私聊的授权卡照旧落在私聊、正文不加群来源说明', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([privateMessage('needs approval', 111, 71)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    await im.sendInteractiveCard(
      events[0].senderId,
      {
        title: 'Approval',
        body: 'Continue?',
        buttons: [{ id: 'yes', label: 'Yes' }],
      },
      { deliverToOwnerDm: true, ownerDmNote: '群聊里的任务需要你授权。' },
    );
    const card = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(card.params.chat_id).toBe(OWNER_ID);
    expect(String(card.params.text)).not.toContain('t.me/c/');
    expect(String(card.params.text)).not.toContain('群聊里的任务需要你授权');
  });

  it('未点名转私聊的卡片(命令卡 / 会话选择卡)留在原群 lane', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '/ctr', fromId: 111, messageId: 72, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // 不传 deliverToOwnerDm: 这类卡的回调要落在原群 lane, 转到私聊会让
    // exitControl 释放宿主私聊那把锁而不是原群锁。
    await im.sendInteractiveCard(events[0].senderId, {
      title: '选择要接管的任务',
      body: '挑一个',
      buttons: [{ id: 'sess-1', label: '任务 A' }],
    });
    const card = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(card.params.chat_id).toBe('-100200');
    expect(String(card.params.text)).not.toContain('t.me/c/');
  });

  it('授权卡深链认调用方指定的那一轮, 同 lane 后到的消息不影响它', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    // 群里连发两问 —— 处理中的是 80, 81 已在队列里等下一轮
    api.pushUpdates([
      groupMessage({ text: '第一问', fromId: 111, messageId: 80, mentionBot: true }),
      groupMessage({ text: '第二问', fromId: 111, messageId: 81, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));

    await im.sendInteractiveCard(
      events[0].senderId,
      { title: '需要授权', body: '改文件？', buttons: [{ id: 'allow', label: '允许' }] },
      {
        deliverToOwnerDm: true,
        ownerDmNote: '群聊里的任务需要你授权。',
        ownerDmSourceMessageId: events[0].messageId,
      },
    );
    const card = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(card.params.text)).toContain('https://t.me/c/200/80');
    expect(String(card.params.text)).not.toContain('/81');
  });

  it('深链只认同群的来源 id: 缺省或跨 chat 一律不渲染链接(不猜, 也不链错群)', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '问题', fromId: 111, messageId: 85, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // 不传来源 id: 传输层不得靠回挂状态/流式回合猜, 直接不渲染深链
    await im.sendInteractiveCard(
      events[0].senderId,
      { title: '需要授权', body: '改文件？', buttons: [{ id: 'allow', label: '允许' }] },
      { deliverToOwnerDm: true, ownerDmNote: '群聊里的任务需要你授权。' },
    );
    expect(
      String(api.calls.filter((c) => c.method === 'sendMessage').at(-1)!.params.text),
    ).not.toContain('t.me/c/');

    // 来源 id 属于别的 chat: 链到别的会话比没有链更糟 —— 同样不渲染
    await im.sendInteractiveCard(
      events[0].senderId,
      { title: '需要授权', body: '改文件？', buttons: [{ id: 'allow', label: '允许' }] },
      {
        deliverToOwnerDm: true,
        ownerDmNote: '群聊里的任务需要你授权。',
        ownerDmSourceMessageId: '-100999|85',
      },
    );
    expect(
      String(api.calls.filter((c) => c.method === 'sendMessage').at(-1)!.params.text),
    ).not.toContain('t.me/c/');
  });

  it("授权卡深链在本轮已发过群回复后仍然有效('first' 档会消耗回挂目标)", async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '改一下配置', fromId: 111, messageId: 90, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // 正常时序: agent 先流式回一句, 再请求授权。默认 replyQuoteGroup='first' 下这条
    // 群回复会把 turnReplyTargets 消耗掉 —— 深链身份不能借用回挂状态。
    const handle = await im.startStreamingText(events[0].senderId, '我看一下');
    await handle.finalize('先读配置文件');
    await im.sendInteractiveCard(
      events[0].senderId,
      { title: '需要授权', body: '改文件？', buttons: [{ id: 'allow', label: '允许' }] },
      {
        deliverToOwnerDm: true,
        ownerDmNote: '群聊里的任务需要你授权。',
        ownerDmSourceMessageId: events[0].messageId,
      },
    );
    const card = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(card.params.chat_id).toBe('111');
    expect(String(card.params.text)).toContain('https://t.me/c/200/90');
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

  it('set-online:false → offline, 停止轮询但保留 token/owner/offset', async () => {
    await connect();
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
    // 先让游标前进一格, 验证下线不会把它一并清掉。
    api.pushUpdates([privateMessage('hi', Number(OWNER_ID), 7)]);
    await vi.waitFor(() => {
      expect(ctx.secrets.get('telegram-updates-offset')).toBeDefined();
    });
    const offsetBeforeOffline = ctx.secrets.get('telegram-updates-offset');

    await ctx.handlers.get('telegramBot:set-online')!({ online: false });

    expect(im.getStatus()).toEqual({ kind: 'offline', appId: String(BOT.id) });
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');
    // 解绑才清凭证; 下线只是让位, 绑定信息必须原样留着。
    expect(ctx.secrets.get('telegram-bot-token')).toBe('999:secret-token-abcdefghijk');
    expect(ctx.secrets.get('telegram-owner-user-id')).toBe(OWNER_ID);
    expect(ctx.secrets.get('telegram-updates-offset')).toBe(offsetBeforeOffline);

    // 轮询确已停: 之后不再产生新的 getUpdates 调用。
    const pollsAtOffline = api.calls.filter((c) => c.method === 'getUpdates').length;
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.filter((c) => c.method === 'getUpdates').length).toBe(pollsAtOffline);
  });

  it('下线后立即上线重放同一 update: 旧世代收尾不得移除新任务的游标低水位', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((event) => events.push(event));
    await connect();

    let releaseOldDownload!: () => void;
    let releaseReplayDownload!: () => void;
    const oldDownload = new Promise<void>((resolve) => (releaseOldDownload = resolve));
    const replayDownload = new Promise<void>((resolve) => (releaseReplayDownload = resolve));
    let getFileCalls = 0;
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'getFile') {
        getFileCalls += 1;
        await (getFileCalls === 1 ? oldDownload : replayDownload);
      }
      return originalCall(method, params, signal);
    }) as typeof api.call;
    const attachment: TgUpdate = {
      update_id: 50,
      message: {
        message_id: 50,
        from: { id: 111, is_bot: false, first_name: 'U' },
        chat: { id: 111, type: 'private' },
        date: nowSec(200),
        caption: '慢附件',
        photo: [{ file_id: 'slow', file_unique_id: 'slow-u', width: 10, height: 10 }],
      },
    };

    api.pushUpdates([attachment]);
    await vi.waitFor(() => expect(getFileCalls).toBe(1));
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    await ctx.handlers.get('telegramBot:set-online')!({ online: true });
    api.pushUpdates([attachment]);

    // 同 chat 的重放排在旧任务后；旧任务一收口，重放开始并继续悬在下载中。
    releaseOldDownload();
    await vi.waitFor(() => expect(getFileCalls).toBe(2));
    // 另一 chat 的后续 update 收口会尝试补写游标。先等它确实处理完成，再断言
    // 游标仍不能越过仍在途的重放 50（避免只读到上一个批次留下的旧值）。
    api.pushUpdates([
      groupMessage({ text: 'other chat', fromId: 111, messageId: 51, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].text).toBe('other chat');
    expect(ctx.secrets.get('telegram-updates-offset')).toBe(`${BOT.id}:50`);

    releaseReplayDownload();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await vi.waitFor(() => {
      expect(ctx.secrets.get('telegram-updates-offset')).toBe(`${BOT.id}:52`);
    });
  });

  it('set-online 畸形 payload 一律报错且不产生上下线副作用', async () => {
    await connect();
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true));
    const handler = ctx.handlers.get('telegramBot:set-online')!;

    for (const bad of [
      undefined,
      null,
      true,
      'false',
      [],
      {},
      { online: 'false' },
      { online: 0 },
      { online: null },
    ]) {
      await expect(
        handler(bad),
        `payload ${JSON.stringify(bad) ?? 'undefined'} 应被拒绝`,
      ).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(/^\[INVALID_PARAMS\]/),
      });
      expect(im.getStatus().kind).toBe('connected');
      expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
    }

    // 轮询仍在继续，证明畸形输入没有暗中走到 goOffline。
    const pollsBefore = api.calls.filter((c) => c.method === 'getUpdates').length;
    api.pushUpdates([privateMessage('still online', Number(OWNER_ID), 23)]);
    await vi.waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'getUpdates').length).toBeGreaterThan(pollsBefore);
    });
  });

  it('下线标志写盘失败 → 报错且**不停轮询**(不留会自己复活的假下线)', async () => {
    await connect();
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
    // 模拟 safeStorage 写失败(Linux 无 keychain / 磁盘写不进)。
    const originalWrite = ctx.host.secrets.write;
    ctx.host.secrets.write = (name, value) =>
      name === 'telegram-bot-offline' ? false : originalWrite(name, value);

    await ctx.handlers.get('telegramBot:set-online')!({ online: false });

    expect(im.getStatus().kind).toBe('error');
    expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
    // 关键: 轮询仍在跑 —— 用户看到明确失败, 而不是"看着下线了、重启又上来抢"。
    const pollsBefore = api.calls.filter((c) => c.method === 'getUpdates').length;
    api.pushUpdates([privateMessage('still here', Number(OWNER_ID), 21)]);
    await vi.waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'getUpdates').length).toBeGreaterThan(
        pollsBefore,
      );
    });
    ctx.host.secrets.write = originalWrite;
  });

  it('存储在 remove→read 窗口读取失败: isAvailable 仍为 true 也必须 fail closed', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    // remove 看似成功(不抛), 但紧接着单文件读取失败；此时 isAvailable 仍为 true。
    // 若把"读不到"当成"已删除", 删除失败就被静默放过: 用户看到已上线,
    // 重启后存储恢复、标志还在, 又被打回 offline。
    const originalRemove = ctx.host.secrets.remove;
    const originalReadResult = ctx.host.secrets.readResult!;
    ctx.host.secrets.remove = (name) => {
      if (name !== 'telegram-bot-offline') originalRemove(name);
      if (name === 'telegram-bot-offline') {
        ctx.host.secrets.readResult = (key) =>
          key === 'telegram-bot-offline' ? { kind: 'error' } : originalReadResult(key);
      }
    };

    await ctx.handlers.get('telegramBot:set-online')!({ online: true });

    expect(im.getStatus().kind).toBe('error');
    // 标志确实还在盘上 —— 证明"读不出来"时放行会是真的错。
    ctx.host.secrets.readResult = originalReadResult;
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');
    ctx.host.secrets.remove = originalRemove;
  });

  it('init 读取下线标志失败时不联网, 不把失败误判成标志缺失', async () => {
    ctx.secrets.set('telegram-bot-token', '999:secret-token-abcdefghijk');
    const originalReadResult = ctx.host.secrets.readResult!;
    ctx.host.secrets.readResult = (name) =>
      name === 'telegram-bot-offline' ? { kind: 'error' } : originalReadResult(name);

    await im.init();

    expect(im.getStatus().kind).toBe('error');
    expect(api.calls).toHaveLength(0);
  });

  it('轮询中读取 token 失败时下线报错, 不误报 idle 且不停止轮询', async () => {
    await connect();
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true));
    const originalReadResult = ctx.host.secrets.readResult!;
    ctx.host.secrets.readResult = (name) =>
      name === 'telegram-bot-token' ? { kind: 'error' } : originalReadResult(name);

    await ctx.handlers.get('telegramBot:set-online')!({ online: false });

    expect(im.getStatus().kind).toBe('error');
    expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
    const pollsBefore = api.calls.filter((c) => c.method === 'getUpdates').length;
    api.pushUpdates([privateMessage('still polling', Number(OWNER_ID), 22)]);
    await vi.waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'getUpdates').length).toBeGreaterThan(pollsBefore);
    });
  });

  it('下线标志删不掉时上线要报错, 不能假装已上线(重启会打回 offline)', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    // 模拟 remove 失败(文件锁/权限/磁盘错误 —— 真实实现吞掉异常且无返回值)。
    const originalRemove = ctx.host.secrets.remove;
    ctx.host.secrets.remove = (name) => {
      if (name !== 'telegram-bot-offline') originalRemove(name);
    };

    await ctx.handlers.get('telegramBot:set-online')!({ online: true });

    // 标志还在 → 重启会回到 offline, 所以此刻绝不能显示成已上线。
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');
    expect(im.getStatus().kind).toBe('error');
    ctx.host.secrets.remove = originalRemove;
  });

  it('安全存储不可用时下线报错, 不会误判成「未配置」而放任轮询继续', async () => {
    await connect();
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
    const originalAvailable = ctx.host.secrets.isAvailable;
    ctx.host.secrets.isAvailable = () => false;

    await im.goOffline();

    // 关键: 不是 idle。idle 会让设置页显示"未配置"、而轮询其实还在跑。
    expect(im.getStatus().kind).toBe('error');
    ctx.host.secrets.isAvailable = originalAvailable;
  });

  it('getMe 在途时被下线: 连接结果作废, 不得写 connected、不得起轮询', async () => {
    // 复现远程下线的真实窗口: 目标机正在 connect 等 getMe, 另一台设备把它下线。
    // 控制端已收到「已下线」, 这里若无条件写回 connected 就会回来继续抢同一个 bot。
    ctx.secrets.set('telegram-bot-token', '999:secret-token-abcdefghijk');
    ctx.secrets.set('telegram-owner-user-id', OWNER_ID);
    let releaseGetMe: (() => void) | null = null;
    const slowApi = createFakeApi();
    const originalCall = slowApi.call.bind(slowApi);
    slowApi.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'getMe') {
        await new Promise<void>((resolve) => {
          releaseGetMe = resolve;
        });
      }
      return originalCall(method, params, signal);
    }) as typeof slowApi.call;
    const slowIm = new TelegramIM(ctx.host, { apiFactory: () => slowApi });
    slowIm.registerIpc();

    const connecting = slowIm.init();
    await vi.waitFor(() => expect(releaseGetMe).not.toBeNull());
    // getMe 还挂着 —— 此刻下线
    await slowIm.goOffline();
    releaseGetMe!();
    await connecting;

    expect(slowIm.getStatus().kind).toBe('offline');
    expect(slowApi.calls.some((c) => c.method === 'getUpdates')).toBe(false);
    await slowIm.dispose();
  });

  it('换账号后不继承上个账号的 bot 身份(离线态拿不到 getMe 也不许张冠李戴)', async () => {
    await connect();
    expect(
      (
        (await ctx.handlers.get('telegramBot:get-status')!()) as { botUsername: string | null }
      ).botUsername,
    ).toBe(BOT.username);

    // 账号 A 登出 → 账号 B 的 bot 已持久化为下线态
    await im.dispose();
    ctx.secrets.set('telegram-bot-token', '888:another-account-token-xyz');
    ctx.secrets.set('telegram-owner-user-id', '222');
    ctx.secrets.set('telegram-bot-offline', '1');
    await im.init();

    const status = (await ctx.handlers.get('telegramBot:get-status')!()) as {
      status: { kind: string; appId?: string };
      botUsername: string | null;
    };
    expect(status.status.kind).toBe('offline');
    expect(status.status.appId).toBe('888');
    // 关键: 不是 A 的 my_cindy_bot
    expect(status.botUsername).toBeNull();
  });

  it('带下线标志时 init 直接 offline, 零网络请求(重启不抢回轮询)', async () => {
    ctx.secrets.set('telegram-bot-token', '999:secret-token-abcdefghijk');
    ctx.secrets.set('telegram-owner-user-id', OWNER_ID);
    ctx.secrets.set('telegram-bot-offline', '1');

    await im.init();

    // botId 从 token 前缀解析而来, 不发 getMe。
    expect(im.getStatus()).toEqual({ kind: 'offline', appId: String(BOT.id) });
    expect(api.calls).toHaveLength(0);
  });

  it('set-online:true → 清标志并重新拉起轮询', async () => {
    ctx.secrets.set('telegram-bot-token', '999:secret-token-abcdefghijk');
    ctx.secrets.set('telegram-owner-user-id', OWNER_ID);
    ctx.secrets.set('telegram-bot-offline', '1');
    await im.init();
    expect(api.calls).toHaveLength(0);

    await ctx.handlers.get('telegramBot:set-online')!({ online: true });

    expect(im.getStatus()).toEqual({ kind: 'connected', appId: String(BOT.id) });
    expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
    await vi.waitFor(() => {
      expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true);
    });
  });

  it('先下线再解绑: 仍要清掉 Telegram 里的命令菜单(否则失效命令永久残留)', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    // 下线已把 this.api 置空;此时解绑若不复活 client, deleteMyCommands 会被跳过,
    // 而 token 随即删除 —— 以后再没机会清, /help 等入口就永久留在 Telegram 里。
    const before = api.calls.filter((c) => c.method === 'deleteMyCommands').length;

    await ctx.handlers.get('telegramBot:disconnect')!();

    await vi.waitFor(() => {
      expect(api.calls.filter((c) => c.method === 'deleteMyCommands').length).toBe(before + 1);
    });
    expect(im.getStatus()).toEqual({ kind: 'idle' });
  });

  it('连接失败带稳定 code, 供 UI 取本地化文案(不直接展示英文 reason)', async () => {
    const failing = createFakeApi({
      getMeError: new TelegramApiError('getMe', 401, 'Unauthorized'),
    });
    const failIm = new TelegramIM(ctx.host, { apiFactory: () => failing });
    failIm.registerIpc();
    await ctx.handlers.get('telegramBot:set-config')!({
      token: '999:secret-token-abcdefghijk',
      ownerUserId: OWNER_ID,
    });
    const status = failIm.getStatus();
    expect(status.kind).toBe('error');
    if (status.kind === 'error') expect(status.code).toBe('invalid-token');
    await failIm.dispose();
  });

  it('解绑清掉下线标志(否则重填 token 后重启又被判回 offline)', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');

    await ctx.handlers.get('telegramBot:disconnect')!();

    expect(im.getStatus()).toEqual({ kind: 'idle' });
    expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
    expect(ctx.secrets.has('telegram-bot-token')).toBe(false);
  });

  it('重填 token 时标志删不掉要报错, 不能连上后重启又掉回 offline', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    const originalRemove = ctx.host.secrets.remove;
    ctx.host.secrets.remove = (name) => {
      if (name !== 'telegram-bot-offline') originalRemove(name);
    };

    await ctx.handlers.get('telegramBot:set-config')!({
      token: '999:secret-token-abcdefghijk',
      ownerUserId: OWNER_ID,
    });

    // 标志还在 → 重启必回 offline, 所以不能报告成功。
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');
    expect(im.getStatus().kind).toBe('error');
    ctx.host.secrets.remove = originalRemove;
  });

  it('下线态重新填 token 点连接: 清掉遗留标志, 直接连上', async () => {
    await connect();
    await ctx.handlers.get('telegramBot:set-online')!({ online: false });
    expect(ctx.secrets.get('telegram-bot-offline')).toBe('1');

    await connect();

    expect(im.getStatus()).toEqual({ kind: 'connected', appId: String(BOT.id) });
    expect(ctx.secrets.has('telegram-bot-offline')).toBe(false);
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
        date: nowSec(200),
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
        date: nowSec(200),
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
        date: nowSec(200),
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
          date: nowSec(200),
          text: '按这个继续',
          reply_to_message: {
            message_id: 40,
            from: { id: BOT.id, is_bot: true, first_name: 'Cindy' },
            chat: { id: 111, type: 'private' },
            date: nowSec(1_000),
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

  it('DM 流式与群一致: send+edit 经典路径, 不再走草稿通道', async () => {
    await connect();
    const handle = await im.startStreamingText(OWNER_ID);
    handle.replace('部分回答');
    await vi.waitFor(
      () => {
        expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);
      },
      { timeout: 3_000, interval: 50 },
    );
    // 私聊不再依赖 sendMessageDraft(草稿只能一行纯文本, 装不下过程时间线)
    expect(api.calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    await handle.finalize('最终回答');
    // 定稿是独立的 Rich 消息：过程载体不会再被最终答案覆盖。
    const richSends = api.calls.filter((c) => c.method === 'sendRichMessage');
    expect(richSends).toHaveLength(1);
    expect((richSends[0].params.rich_message as { markdown?: string }).markdown).toBe('最终回答');
  });

  it('DM 中间态能承载多行过程时间线(工具调用在私聊也可见)', async () => {
    await connect();
    const handle = await im.startStreamingText(OWNER_ID);
    handle.replace('⚙️ 工作中 · 2 项 · 3s\n> ✓ 读取 adapter.ts\n> ▸ 搜索 draft\n\n正在看代码');
    await vi.waitFor(
      () => {
        const sent = api.calls.filter((c) => c.method === 'sendMessage').at(-1);
        expect(sent).toBeTruthy();
        const text = String(sent?.params.text ?? '');
        expect(text).toContain('读取 adapter.ts');
        expect(text).toContain('搜索 draft');
        expect(text).toContain('正在看代码');
      },
      { timeout: 3_000, interval: 50 },
    );
    // 收口后只留干净正文(过程区由编排层移除), 与群同口径
    await handle.finalize('看完了');
    const richSends = api.calls.filter((c) => c.method === 'sendRichMessage');
    expect((richSends.at(-1)?.params.rich_message as { markdown?: string }).markdown).toBe('看完了');
  });

  it('Rich 新发 429(退避后仍限流)降级 HTML, 答案不停在过程消息', async () => {
    // turnRunner 的终态路径只把 finalize() 异常记成 non-fatal 警告、不会重试,
    // 所以 Rich 的 429 抛出去 = 用户永远停在"工作中"。callSend 已按 retry_after
    // 退避过, 仍 429 就是明确拒绝 —— 这条 Rich 没落地, HTML 补发不会重复。
    await connect();
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        api.calls.push({ method, params: params ?? {} });
        throw new TelegramApiError('sendRichMessage', 429, 'Too Many Requests', 0);
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 8m');
    vi.useFakeTimers();
    try {
      // callSend 对 429 会按 retry_after 退避重试一次, 之后才交回这里降级。
      const finalized = handle.finalize('flood 下也必须送到的答案');
      await vi.advanceTimersByTimeAsync(10_000);
      await finalized;
    } finally {
      vi.useRealTimers();
    }

    // HTML 新发承载了答案。
    const answer = api.calls.find(
      (c) => c.method === 'sendMessage' && String(c.params.text ?? '').includes('必须送到的答案'),
    );
    expect(answer).toBeDefined();
    // 429 不是方法缺失, 不该熔断: 下一轮仍会尝试 Rich。
    const richBefore = api.calls.filter((c) => c.method === 'sendRichMessage').length;
    const handle2 = await im.startStreamingText(OWNER_ID);
    vi.useFakeTimers();
    try {
      const second = handle2.finalize('第二轮');
      await vi.advanceTimersByTimeAsync(10_000);
      await second;
    } finally {
      vi.useRealTimers();
    }
    expect(api.calls.filter((c) => c.method === 'sendRichMessage').length).toBeGreaterThan(
      richBefore,
    );
  });

  it('Rich 新发 404(方法不可用)实例级 latch, 后续不再尝试', async () => {
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
    const richSendCount = () => api.calls.filter((c) => c.method === 'sendRichMessage').length;
    // Rich 试了一次 → 404 latch; 正文仍由新发 sendMessage 落地不丢。
    expect(richSendCount()).toBe(1);
    expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);

    const handle2 = await im.startStreamingText(OWNER_ID);
    await handle2.finalize('回答二');
    expect(richSendCount()).toBe(1);
  });

  it('429 退避等满 Telegram 给的 retry_after(不再封顶 10s), 终稿不丢', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let richSendAttempts = 0;
    const flood = (): TelegramApiError =>
      new TelegramApiError('editMessageText', 429, 'Too Many Requests: retry after 26', 26);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        richSendAttempts += 1;
        if (richSendAttempts === 1) throw flood();
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 10m44s');
    const sendCount = (): number => api.calls.filter((c) => c.method === 'sendMessage').length;
    const sendsBeforeFinalize = sendCount();

    vi.useFakeTimers();
    try {
      const finalized = handle.finalize('完整的最终答案');
      // 旧实现把退避封在 10s: 此刻已经重试, 而 flood 窗口还剩 16s → 必然二次
      // 失败, 整条终稿就是这样丢的(2026-08-04 线上实测)。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(richSendAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(16_000);
      await finalized;
      expect(richSendAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }

    // 新鲜 Rich 终稿最终送达，过程消息随后清理。
    expect(sendCount()).toBe(sendsBeforeFinalize);
    const richFinal = api.calls.filter((c) => c.method === 'sendRichMessage').at(-1);
    expect((richFinal?.params.rich_message as { markdown?: string }).markdown).toContain('完整的最终答案');
  });

  it('Rich 不可用时, HTML 新消息承载终稿并撤掉过程消息', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        api.calls.push({ method, params: params ?? {} });
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 11m');
    const progressMessageId = handle.messageId;

    await handle.finalize('降级后也必须送到的答案');

    const answer = api.calls.find(
      (c) => c.method === 'sendMessage' && String(c.params.text ?? '').includes('必须送到的答案'),
    );
    expect(answer).toBeDefined();
    // 先发新、后删旧: 补送落地后才撤掉那条停在"工作中"的过程消息。
    const deleted = api.calls.filter((c) => c.method === 'deleteMessage');
    expect(deleted).toHaveLength(1);
    expect(api.calls.indexOf(answer!)).toBeLessThan(api.calls.indexOf(deleted[0]!));
    expect(String(deleted[0]!.params.message_id ?? '')).toBe(
      progressMessageId.split('|')[1] ?? progressMessageId,
    );
  });

  it('群 lane 流式: send+edit 过程路径 + 新发 Rich 终稿(本次统一的基准)', async () => {
    await connect();
    const handle = await im.startStreamingText('g/-100200/r7');
    handle.replace('进行中');
    await handle.finalize('群里的最终回答');
    expect(api.calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    expect(api.calls.some((c) => c.method === 'sendMessage')).toBe(true);
    // 定稿是新的 Rich 消息(表格/LaTeX 原生渲染), 非 HTML edit。
    const richSends = api.calls.filter((c) => c.method === 'sendRichMessage');
    expect(richSends).toHaveLength(1);
    expect((richSends[0].params.rich_message as { markdown?: string }).markdown).toBe(
      '群里的最终回答',
    );
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

  describe('相册发送失败的回落判据', () => {
    // Telegram 没有发送端幂等键: 一次 sendMediaGroup 只要被接受, 图片就已经在
    // 聊天里了 —— 哪怕响应在网络上丢了。逐张补发会让用户看到两套同样的图, 且
    // 无法分辨哪些是重复。只有 400(确定性拒绝相册形状)才可以安全回落。

    function threeImages(): string[] {
      return ['x1.png', 'x2.png', 'x3.png'].map((name) => {
        const abs = path.join(tmpDir, name);
        fs.writeFileSync(abs, 'fake-png');
        return abs;
      });
    }

    async function sendAlbumWith(
      failure: unknown,
    ): Promise<{ groups: number; singles: number }> {
      await connect();
      const originalForm = api.callForm.bind(api);
      api.callForm = (async (method: string, form: FormData, signal?: AbortSignal) => {
        if (method === 'sendMediaGroup') throw failure;
        return originalForm(method, form, signal);
      }) as FakeApi['callForm'];
      const handle = await im.startStreamingText(Number(OWNER_ID).toString());
      for (const abs of threeImages()) handle.addExtraImageAbsPath?.(abs);
      await handle.finalize('三张图的回答');
      return {
        groups: api.calls.filter((c) => c.method === 'sendMediaGroup').length,
        singles: api.calls.filter((c) => c.method === 'sendPhoto').length,
      };
    }

    it('某张图读不出来 → 逐张回落, 其余照发(不因一张丢整组)', async () => {
      // 本地读盘失败时请求根本没发出, 一张都没进聊天 —— 与 Telegram 回 400
      // 同一类确定性失败。把它混进 uncertain 会让整组静默消失。
      await connect();
      const present = ['ok1.png', 'ok2.png'].map((name) => {
        const abs = path.join(tmpDir, name);
        fs.writeFileSync(abs, 'fake-png');
        return abs;
      });
      const missing = path.join(tmpDir, 'gone.png'); // 故意不创建
      const handle = await im.startStreamingText(Number(OWNER_ID).toString());
      for (const abs of [present[0], missing, present[1]]) handle.addExtraImageAbsPath?.(abs);
      await handle.finalize('三张图, 其中一张缺失');
      // 相册组装即失败, 一次 sendMediaGroup 都没打成
      expect(api.calls.filter((c) => c.method === 'sendMediaGroup')).toHaveLength(0);
      // 两张可读的仍然逐张发了出去; 缺失那张在读盘处失败, 不产生出站
      expect(api.calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(2);
    });

    it('400 拒绝 → 逐张回落(确定一张都没进聊天)', async () => {
      const { singles } = await sendAlbumWith(
        new TelegramApiError('sendMediaGroup', 400, 'Bad Request: wrong file identifier'),
      );
      expect(singles).toBe(3);
    });

    it('网络错误 → 不逐张补发(可能已经发出去了)', async () => {
      const { singles } = await sendAlbumWith(new TypeError('fetch failed'));
      // 这一组宁可丢失也不重复 —— 重复的图进了聊天记录就撤不回来了。
      expect(singles).toBe(0);
    });

    it('5xx → 不逐张补发', async () => {
      const { singles } = await sendAlbumWith(
        new TelegramApiError('sendMediaGroup', 500, 'Internal Server Error'),
      );
      expect(singles).toBe(0);
    });

    it('429 限流 → 不逐张补发', async () => {
      const { singles } = await sendAlbumWith(
        new TelegramApiError('sendMediaGroup', 429, 'Too Many Requests', 3),
      );
      expect(singles).toBe(0);
    });
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

  it('回挂目标成功才消耗: 首条出站失败后重试仍带 reply_parameters', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'first', replyQuoteDm: 'first' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([privateMessage('问个事', 111, 96)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // connect 的 linked 确认也发往 owner 私聊 —— 取基线后只看本例新增的出站。
    const dmSendsBefore = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID,
    ).length;

    // 首条 sendMessage 非 400 失败(网络类), 之后恢复 —— 回挂目标不能被那次失败吃掉。
    const originalCall = api.call.bind(api);
    let failedOnce = false;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage' && params?.chat_id === OWNER_ID && !failedOnce) {
        failedOnce = true;
        api.calls.push({ method, params: params ?? {} });
        throw new Error('socket hang up');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    await expect(im.sendText(OWNER_ID, '第一条(会失败)')).rejects.toThrow();
    await im.sendText(OWNER_ID, '重试的第一条');
    // 已成功一条 → 'first' 档后续不再挂回
    await im.sendText(OWNER_ID, '第二条');
    const dmSends = api.calls
      .filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID)
      .slice(dmSendsBefore);
    expect(dmSends).toHaveLength(3);
    // 失败那条 + 重试那条都带引用(引用只在成功后被消耗); 第三条不带
    for (const call of dmSends.slice(0, 2)) {
      expect((call.params.reply_parameters as { message_id: number } | undefined)?.message_id).toBe(
        96,
      );
    }
    expect(dmSends[2].params.reply_parameters).toBeUndefined();
  });

  it('旧轮迟到成功不吃掉新轮目标(提交校身份)', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'first', replyQuoteDm: 'first' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();

    // 第一轮触发(msg 300) → 开流 → 首条 send 挂在途(模拟慢请求/限流退避)
    api.pushUpdates([privateMessage('第一问', 111, 300)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const originalCall = api.call.bind(api);
    let releaseFirstSend: (() => void) | null = null;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage' && !releaseFirstSend) {
        api.calls.push({ method, params: params ?? {} });
        await new Promise<void>((resolve) => {
          releaseFirstSend = resolve;
        });
        return { message_id: 9001, chat: { id: 111, type: 'private' }, date: 1 } as never;
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const firstHandle = await im.startStreamingText(OWNER_ID);
    const firstSend = firstHandle.finalize('第一轮答案');
    await vi.waitFor(() => expect(releaseFirstSend).not.toBeNull());

    // 旧请求还在途, 第二轮触发(msg 301)已 claim 新目标
    api.pushUpdates([privateMessage('第二问', 111, 301)]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await im.startStreamingText(OWNER_ID);

    // 旧请求现在才成功 —— 不得删掉新轮的 301
    releaseFirstSend!();
    await firstSend;
    api.call = originalCall;
    const sendsBefore = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID,
    ).length;
    await im.sendText(OWNER_ID, '第二轮答案');
    const second = api.calls
      .filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID)
      .slice(sendsBefore);
    expect(second).toHaveLength(1);
    expect((second[0].params.reply_parameters as { message_id: number } | undefined)?.message_id)
      .toBe(301);
  });

  it('领取过时槽位: 出站失败且调用方放弃后, 下一条回复不再落后一条', async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'first', replyQuoteDm: 'first' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();

    // 第一条触发(msg 400): 领取目标后出站失败, 调用方直接放弃(不重试)
    api.pushUpdates([privateMessage('一', 111, 400)]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const originalCall = api.call.bind(api);
    let failed = false;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage' && params?.chat_id === OWNER_ID && !failed) {
        failed = true;
        api.calls.push({ method, params: params ?? {} });
        throw new Error('socket hang up');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];
    await expect(im.sendText(OWNER_ID, '丢掉的回答')).rejects.toThrow();

    // 第二条触发(msg 401): 新目标必须能领到, 不能被上一轮残留的 400 堵死
    api.pushUpdates([privateMessage('二', 111, 401)]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const sendsBefore = api.calls.filter(
      (c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID,
    ).length;
    await im.sendText(OWNER_ID, '第二条的回答');
    const reply = api.calls
      .filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID)
      .slice(sendsBefore);
    expect((reply[0].params.reply_parameters as { message_id: number } | undefined)?.message_id)
      .toBe(401);
  });

  it("群默认 'first' 档: Rich 不可用时 HTML 终稿仍引用原触发消息", async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'first', replyQuoteDm: 'off' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([groupMessage({ text: '干活', fromId: 222, messageId: 80, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const lane = events[0].senderId;

    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    // 过程消息先落地 —— 'first' 档下它已经把回挂目标 80 消耗掉了。
    const handle = await im.startStreamingText(lane, '⚙️ 工作中 · 11m');
    const progressSend = api.calls.filter(
      (c) => c.method === 'sendMessage' && String(c.params.chat_id) === '-100200',
    );
    expect((progressSend[0].params.reply_parameters as { message_id: number }).message_id).toBe(80);

    await handle.finalize('Rich 不可用后补送出来的答案');

    // 补送的答案不能脱离提问脉络 —— 重新 lease 会拿到空目标, 必须沿用本轮的 80。
    const answer = api.calls.find(
      (c) =>
        c.method === 'sendMessage' && String(c.params.text ?? '').includes('补送出来的答案'),
    );
    expect(answer).toBeDefined();
    expect((answer!.params.reply_parameters as { message_id: number } | undefined)?.message_id)
      .toBe(80);
  });

  it("回挂档位 off 时, HTML 终稿不带 reply_parameters", async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'off', replyQuoteDm: 'off' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([groupMessage({ text: '干活', fromId: 222, messageId: 81, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const lane = events[0].senderId;

    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(lane, '⚙️ 工作中 · 3m');
    await handle.finalize('off 档的答案');

    const answer = api.calls.find(
      (c) => c.method === 'sendMessage' && String(c.params.text ?? '').includes('off 档的答案'),
    );
    expect(answer).toBeDefined();
    expect(answer!.params.reply_parameters).toBeUndefined();
  });

  it("群 'all' 档: HTML 终稿同样挂回, 档位语义不被回落破坏", async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'all', replyQuoteDm: 'off' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([groupMessage({ text: '干活', fromId: 222, messageId: 82, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const lane = events[0].senderId;

    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(lane, '⚙️ 工作中 · 2m');
    await handle.finalize('all 档补送的答案');

    const groupSends = api.calls.filter(
      (c) => c.method === 'sendMessage' && String(c.params.chat_id) === '-100200',
    );
    expect(groupSends.length).toBeGreaterThanOrEqual(2);
    for (const call of groupSends) {
      expect((call.params.reply_parameters as { message_id: number } | undefined)?.message_id)
        .toBe(82);
    }
  });

  it('429 退避期间被 dispose: 不再发第二次请求, 也不留后台重试', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let sendAttempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        sendAttempts += 1;
        throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 26', 26);
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      const sending = im.sendText(OWNER_ID, '停止边界').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendAttempts).toBe(1);
      // 退避还没走完就销毁 —— 等待必须被取消, 且醒来后不得用旧 api 补发。
      await im.dispose();
      await vi.advanceTimersByTimeAsync(120_000);
      const outcome = await sending;
      expect(outcome).toBeInstanceOf(TelegramApiError);
      expect(sendAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    // 后台没有遗留任务: 再放一段时间也不会冒出新的请求。
    await vi.waitFor(() => expect(sendAttempts).toBe(1));
  });

  it('换 owner 后终稿发送与清理都不再触碰旧回合', async () => {
    await connect();
    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 5m');
    const callsBefore = api.calls.length;

    // 只换主人: 不 stopPolling, api 对象不变 —— 唯一能识别授权易主的是世代/主人。
    await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '777888' });

    // sendFinal 是 finalize 的第一步，核验失败即抛——整个收口放弃。
    await expect(handle.finalize('旧回合的终稿')).rejects.toThrow(/round abandoned/);

    const after = api.calls.slice(callsBefore);
    expect(after.filter((c) => c.method === 'editMessageText')).toEqual([]);
    expect(after.filter((c) => c.method === 'deleteMessage')).toEqual([]);
    expect(after.filter((c) => c.method === 'sendMessage')).toEqual([]);
    expect(after.filter((c) => c.method === 'sendRichMessage')).toEqual([]);
  });

  it('换 owner 后的 NO_REPLY 沉默不再删旧回合的占位消息', async () => {
    await connect();
    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 30s');
    const callsBefore = api.calls.length;
    await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '777889' });

    // NO_REPLY 的删除被 finalize 内部 catch 吞掉, 所以不抛 —— 但一定不能真删。
    await handle.finalize('NO_REPLY');
    expect(api.calls.slice(callsBefore).filter((c) => c.method === 'deleteMessage')).toEqual([]);
  });

  it('多组图片中途换 owner: 第一组之后不再向旧 chat 出站', async () => {
    await connect();
    // 11 张 → 分两组(每组 ≤10), 第一组落地后换主人。
    const paths = Array.from({ length: 11 }, (_, i) => {
      const p = path.join(tmpDir, `g${i}.png`);
      fs.writeFileSync(p, 'fake-png');
      return p;
    });
    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 6m');
    for (const p of paths) handle.addExtraImageAbsPath?.(p);

    const originalForm = api.callForm.bind(api);
    let groups = 0;
    api.callForm = (async (method: string, form: FormData, signal?: AbortSignal) => {
      const result = await originalForm(method, form, signal);
      if (method === 'sendMediaGroup') {
        groups += 1;
        if (groups === 1) {
          await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '777890' });
        }
      }
      return result;
    }) as FakeApi['callForm'];

    // uploadImages 的核验在第二组之前失败 → finalize 抛出。
    await expect(handle.finalize('十一张图的回答')).rejects.toThrow(/round abandoned/);
    // 只发出了第一组, 第二组被挡住。
    expect(groups).toBe(1);
    expect(api.calls.filter((c) => c.method === 'sendMediaGroup')).toHaveLength(1);
  });

  it('合法 retry_after 超过 60s 时不提前重试(不再有固定上限)', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let attempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        attempts += 1;
        if (attempts === 1) {
          throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 180', 180);
        }
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      const sending = im.sendText(OWNER_ID, 'bot-wide flood');
      // 旧实现封在 60s: 此刻已经重试, 而 flood 窗口还剩两分钟 → 必然再失败。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await sending;
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry_after 缺失或非法时走兜底退避(3s)', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let attempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        attempts += 1;
        // 缺失 retry_after
        if (attempts === 1) throw new TelegramApiError('sendMessage', 429, 'Too Many Requests');
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      const sending = im.sendText(OWNER_ID, '无 retry_after');
      await vi.advanceTimersByTimeAsync(3_000);
      await sending;
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('HTML 终稿首段成功后才换 owner: 剩余分段与图片同样不再发给旧 userId', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let ownerSwitched = false;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        throw new TelegramApiError('sendRichMessage', 404, 'Not Found');
      }
      const result = await originalCall(method, params, signal);
      // 首段补送刚落地就换主人 —— 此刻 assertRoundStillLive 已经放行过一次,
      // 剩余分段与图片若不各自核验就会继续发给已失权的旧 userId。
      if (
        method === 'sendMessage' &&
        String(params?.text ?? '').includes('第一段') &&
        !ownerSwitched
      ) {
        ownerSwitched = true;
        await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '444555' });
      }
      return result;
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 7m');
    // chunkTelegramSource 不会按 | 分段, 用一段超长正文迫使终稿分片。
    const long = `第一段${'甲'.repeat(4200)}\n\n第二段尾巴`;
    await handle.finalize(long).catch(() => {});

    expect(ownerSwitched).toBe(true);
    // 首段已经发出(那时回合还有效), 但换主人之后的剩余分段一律不许再出站。
    const tailSends = api.calls.filter(
      (c) => c.method === 'sendMessage' && String(c.params.text ?? '').includes('第二段尾巴'),
    );
    expect(tailSends).toEqual([]);
    // 也不许对新主人产生任何出站。
    expect(
      api.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === '444555'),
    ).toEqual([]);
  });

  it('补送成功后换 owner: 受管图片不再上传(sendPhoto / sendMediaGroup 都不发)', async () => {
    await connect();
    const imgPath = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(imgPath, 'fake-png');
    const originalCall = api.call.bind(api);
    let ownerSwitched = false;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'editMessageText') {
        throw new TelegramApiError('editMessageText', 429, 'Too Many Requests: retry after 26', 26);
      }
      const result = await originalCall(method, params, signal);
      // 补送刚落地就换主人 —— 图片上传排在它后面, 若不各自核验就会照传。
      if (method === 'sendMessage' && String(params?.text ?? '').includes('带图答案')) {
        ownerSwitched = true;
        await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '444556' });
      }
      return result;
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 4m');
    // 走 abs: 旁路(与既有相册用例同一搭法), 不依赖 resolveImageUrl 注入。
    handle.addExtraImageAbsPath?.(imgPath);
    vi.useFakeTimers();
    try {
      const finalized = handle.finalize('带图答案').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(120_000);
      await finalized;
    } finally {
      vi.useRealTimers();
    }

    expect(ownerSwitched).toBe(true);
    expect(
      api.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendMediaGroup'),
    ).toEqual([]);
  });

  it('退避期间只换 owner(api 对象不变): 旧回合的答案不发给已失权的旧 userId', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendRichMessage') {
        throw new TelegramApiError('sendRichMessage', 429, 'Too Many Requests: retry after 26', 26);
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    const handle = await im.startStreamingText(OWNER_ID, '⚙️ 工作中 · 9m');
    const progressMessageId = handle.messageId;
    const answer = '旧 owner 那一轮的完整答案';

    vi.useFakeTimers();
    try {
      const finalized = handle.finalize(answer).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1_000);
      // 只换 ownerUserId、不带 token: 这条分支不 stopPolling, this.api 完全不变,
      // 只有 configVersion / ownerUserId 变了 —— Rich 终稿若按当前世代重新取 api
      // 就会把这轮答案照发给已经失去授权的旧主人。
      await ctx.handlers.get('telegramBot:set-config')!({ ownerUserId: '222333' });
      await vi.advanceTimersByTimeAsync(120_000);
      const outcome = await finalized;
      // 先断言泄露本身: 一个字都不许发出去。
      expect(
        api.calls
          .filter((c) => c.method === 'sendMessage')
          .map((c) => String(c.params.text ?? ''))
          .filter((text) => text.includes('完整答案')),
      ).toEqual([]);
      // Rich 的 429 是明确拒绝 → 降级 HTML; 而 HTML 补送前的身份核验发现 owner
      // 已换, 于是整轮收口作废。关键不变量是"一个字都没发给旧主人"(上面已断言),
      // 错误类型只需证明它是被生命周期拦下的, 不是普通发送失败。
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/round abandoned/);
    } finally {
      vi.useRealTimers();
    }

    // 过程消息保留(没有补送成功就不该删), 也没有对新主人产生任何出站。
    expect(api.calls.filter((c) => c.method === 'deleteMessage')).toEqual([]);
    expect(progressMessageId).not.toBe('');
    expect(
      api.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === '222333'),
    ).toEqual([]);
  });

  it('dispose() 后重新 init(): 退避重试在新世代恢复可用', async () => {
    await connect();
    // 退出登录 → 再登录(同一实例复用; init 里就有 this.disposing = false)。
    await im.dispose();
    await im.init();
    expect(im.getStatus()).toEqual({ kind: 'connected', appId: String(BOT.id) });

    const originalCall = api.call.bind(api);
    let sendAttempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 26', 26);
        }
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      const sending = im.sendText(OWNER_ID, '新世代的出站');
      await vi.advanceTimersByTimeAsync(26_000);
      await sending;
    } finally {
      vi.useRealTimers();
    }
    // 一次性的生命周期控制器若不重建, 新世代每次退避都当场判"已停止"→ 永久
    // 关掉 429 重试, 这里就只会有 1 次尝试。
    expect(sendAttempts).toBe(2);
  });

  it('dispose 收尾窗口里的出站: 已取消信号不再干等满整个退避', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let sendAttempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        sendAttempts += 1;
        throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 26', 26);
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      // dispose 的同步段已经 abort 了生命周期取消源, 但它随后要 await stopPolling
      // (那里等 pollLoop 才把 this.api 置空) —— 这个窗口里的出站拿到的是一个
      // **进来就已 aborted** 的信号。
      const disposing = im.dispose();
      const sending = im.sendText(OWNER_ID, '收尾窗口的出站').catch((err: unknown) => err);
      await disposing;
      // 一个定时器都不推进: 已取消的等待必须当场结束, 否则这里会挂到用例超时
      // (旧实现 addEventListener 对已发生的 abort 不触发, 会干等满 26s)。
      expect(await sending).toBeInstanceOf(TelegramApiError);
      expect(sendAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('429 退避期间下线(stopPolling): 不再发第二次请求', async () => {
    await connect();
    const originalCall = api.call.bind(api);
    let sendAttempts = 0;
    api.call = (async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      if (method === 'sendMessage') {
        sendAttempts += 1;
        throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 26', 26);
      }
      return originalCall(method, params, signal);
    }) as FakeApi['call'];

    vi.useFakeTimers();
    try {
      const sending = im.sendText(OWNER_ID, '下线边界').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendAttempts).toBe(1);
      // 主动下线: stopPolling 会 abort 当前世代并把 this.api 置空 —— 退避必须
      // 就此放弃, 不能用那个已经作废的客户端补发。
      await ctx.handlers.get('telegramBot:set-online')!({ online: false });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await sending).toBeInstanceOf(TelegramApiError);
      expect(sendAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("群 'all' 档: 目标保留整轮, 每条出站都挂回", async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'all', replyQuoteDm: 'off' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([groupMessage({ text: '干活', fromId: 222, messageId: 60, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const lane = events[0].senderId;
    await im.startStreamingText(lane);
    await im.sendText(lane, '第一条');
    await im.sendText(lane, '第二条');
    const groupSends = api.calls.filter(
      (c) => c.method === 'sendMessage' && String(c.params.chat_id) === '-100200',
    );
    expect(groupSends.length).toBeGreaterThanOrEqual(2);
    for (const call of groupSends) {
      expect((call.params.reply_parameters as { message_id: number } | undefined)?.message_id)
        .toBe(60);
    }
  });

  it("群 'all' 档: A 流式期间 B 排队发提示, A 剩下的答案不能改挂到 B", async () => {
    await im.dispose();
    im = new TelegramIM(ctx.host, {
      apiFactory: () => api,
      behavior: () => ({ emojiReactions: 'off', replyQuoteGroup: 'all', replyQuoteDm: 'off' }),
    });
    im.registerIpc();
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();

    // A 触发(msg 70) → 开流(回合持有目标 70)
    api.pushUpdates([groupMessage({ text: 'A 问', fromId: 222, messageId: 70, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const lane = events[0].senderId;
    const handle = await im.startStreamingText(lane);
    handle.replace('A 的第一段');
    await vi.waitFor(
      () => {
        expect(
          api.calls.some(
            (c) => c.method === 'sendMessage' && String(c.params.chat_id) === '-100200',
          ),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 50 },
    );

    // B 在 A 流式期间到达并入队 → 排队提示走独立出站(sendMarkdownText)
    api.pushUpdates([groupMessage({ text: 'B 问', fromId: 333, messageId: 71, mentionBot: true })]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await im.sendMarkdownText(lane, '你排在第 1 位');

    // A 继续输出并定稿 —— 仍须挂回 70, 不得变 71
    await handle.finalize('A 的最终答案');
    const isGroupSend = (c: { method: string; params: Record<string, unknown> }) =>
      (c.method === 'sendMessage' || c.method === 'sendRichMessage') &&
      String(c.params.chat_id) === '-100200';
    const quoted = api.calls
      .filter(isGroupSend)
      .map((c) => (c.params.reply_parameters as { message_id: number } | undefined)?.message_id);
    expect(quoted.length).toBeGreaterThanOrEqual(2);
    expect(quoted.every((id) => id === 70)).toBe(true);

    // B 的目标没被那条提示偷走: B 自己的回合能领到 71
    const beforeB = api.calls.filter(isGroupSend).length;
    const bHandle = await im.startStreamingText(lane);
    await bHandle.finalize('B 的答案');
    const bSends = api.calls.filter(isGroupSend).slice(beforeB);
    expect((bSends[0].params.reply_parameters as { message_id: number } | undefined)?.message_id)
      .toBe(71);
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

  it('授权卡转私聊时也停掉原群的 typing loop(否则群里一直显示正在输入)', async () => {
    const events: IMMessageEvent[] = [];
    im.onMessage((e) => events.push(e));
    await connect();
    api.pushUpdates([
      groupMessage({ text: '改个文件', fromId: 111, messageId: 99, mentionBot: true }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await vi.waitFor(() => {
      expect(
        api.calls.some((c) => c.method === 'sendChatAction' && c.params.chat_id === '-100200'),
      ).toBe(true);
    });

    // 卡片投的是宿主私聊 —— callSend 只会停它自己那条 chat 的 typing loop,
    // 群里那条必须由转发分支显式停掉, 否则每 4.5s 继续打一次 sendChatAction。
    await im.sendInteractiveCard(
      events[0].senderId,
      { title: '需要授权', body: '改 src/app.ts？', buttons: [{ id: 'allow', label: '允许' }] },
      { deliverToOwnerDm: true, ownerDmNote: '群聊里的任务需要你授权。' },
    );
    const groupTypingAfterCard = api.calls.filter(
      (c) => c.method === 'sendChatAction' && c.params.chat_id === '-100200',
    ).length;
    // **必须跨过一个 TYPING_REFRESH_MS(4.5s)**: loop 每 4.5s 才刷一次, 只等 100ms 的话
    // 循环还没来得及打下一枪, 断言对「有没有真的停掉」没有判别力(反向验证时会假通过)。
    await new Promise((r) => setTimeout(r, 4_700));
    expect(
      api.calls.filter((c) => c.method === 'sendChatAction' && c.params.chat_id === '-100200')
        .length,
    ).toBe(groupTypingAfterCard);
  });

  // 交互卡的 callback token 只活在进程内存里(codec 的 callbackRefs), 重启或被淘汰后
  // 解不出来。此前只弹一次「已过期」、按钮原样留在消息上, 看起来还能点。
  describe('失效回调的卡片收口', () => {
    const NOTICE = 'NOTICE-EXPIRED';

    beforeEach(async () => {
      await im.dispose();
      im = new TelegramIM(ctx.host, { apiFactory: () => api, expiredCardNotice: NOTICE });
      im.registerIpc();
      api.calls.length = 0;
    });

    function callbackUpdate(args: {
      data: string;
      fromId: number;
      updateId: number;
      queryId?: string;
      /** 该消息当前挂着的键盘(Telegram 会随 callback_query 一起送来)。 */
      keyboard?: string[];
    }): TgUpdate {
      return {
        update_id: args.updateId,
        callback_query: {
          id: args.queryId ?? `cbq-${args.updateId}`,
          from: { id: args.fromId, is_bot: false, first_name: 'U' },
          message: {
            message_id: 55,
            chat: { id: args.fromId, type: 'private' },
            date: nowSec(200),
            ...(args.keyboard
              ? {
                  reply_markup: {
                    inline_keyboard: args.keyboard.map((d) => [{ callback_data: d }]),
                  },
                }
              : {}),
          },
          data: args.data,
        },
      };
    }

    it('ref 失效: 唯一一次应答带过期 alert, 并清掉该消息的键盘', async () => {
      await connect();
      api.calls.length = 0;
      // 重启后整卡 token 全丢 —— 键盘上每个按钮都解不开, 这才是该清键盘的情形。
      api.pushUpdates([
        callbackUpdate({
          data: 'cbr:gone-after-restart',
          fromId: 111,
          updateId: 9,
          keyboard: ['cbr:gone-after-restart'],
        }),
      ]);

      await vi.waitFor(() =>
        expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true),
      );
      // 只应答一次 —— 二次 answer 会被 Telegram 拒掉, 先发空 answer 会把 alert 吞掉。
      const answers = api.calls.filter((c) => c.method === 'answerCallbackQuery');
      expect(answers).toHaveLength(1);
      expect(answers[0].params).toMatchObject({ text: NOTICE, show_alert: true });
      expect(api.calls.find((c) => c.method === 'editMessageReplyMarkup')!.params).toMatchObject({
        chat_id: 111,
        message_id: 55,
        reply_markup: { inline_keyboard: [] },
      });
    });

    it('同卡还有能解开的按钮时只提示、不清键盘(token 是逐个淘汰的)', async () => {
      await connect();
      const live = encodeCallbackData('deny', { requestId: 'req-multi' });
      api.calls.length = 0;
      // 被点的那个 token 已被淘汰, 但同卡的「拒绝」还在 —— 这次交互仍然能完成。
      api.pushUpdates([
        callbackUpdate({
          data: 'cbr:evicted-one',
          fromId: 111,
          updateId: 12,
          keyboard: ['cbr:evicted-one', live],
        }),
      ]);

      await vi.waitFor(() =>
        expect(api.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1),
      );
      expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);
    });

    it('整卡的 token 都解不开才清键盘', async () => {
      await connect();
      api.calls.length = 0;
      api.pushUpdates([
        callbackUpdate({
          data: 'cbr:evicted-a',
          fromId: 111,
          updateId: 13,
          keyboard: ['cbr:evicted-a', 'cbr:evicted-b'],
        }),
      ]);

      await vi.waitFor(() =>
        expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true),
      );
      expect(api.calls.find((c) => c.method === 'editMessageReplyMarkup')!.params).toMatchObject({
        reply_markup: { inline_keyboard: [] },
      });
    });

    it('容量淘汰后同卡幸存按钮仍可用: 不清键盘且照常派发', async () => {
      await connect();
      // 真实触发容量淘汰: 先发的按钮被 512 个后来者挤出 callbackRefs, 后发的还在。
      // (survivor 必须在填充**之后**创建 —— 否则它会和 evicted 一起被挤掉。)
      const evicted = encodeCallbackData('allow', { requestId: 'req-old' });
      for (let i = 0; i < 512; i += 1) encodeCallbackData('filler', { n: i });
      const survivor = encodeCallbackData('deny', { requestId: 'req-old' });

      const seen: IMCardActionEvent[] = [];
      im.onCardAction((e) => void seen.push(e));
      api.calls.length = 0;
      // 被挤掉的那个先点: 只提示, 不能把幸存的「拒绝」一起清掉。
      api.pushUpdates([
        callbackUpdate({
          data: evicted,
          fromId: 111,
          updateId: 14,
          keyboard: [evicted, survivor],
        }),
      ]);
      await vi.waitFor(() =>
        expect(api.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1),
      );
      expect(api.calls.find((c) => c.method === 'answerCallbackQuery')!.params).toMatchObject({
        text: NOTICE,
        show_alert: true,
      });
      expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);

      // 幸存按钮照常派发, 这次交互仍然能被完成。
      api.pushUpdates([
        callbackUpdate({ data: survivor, fromId: 111, updateId: 15, keyboard: [evicted, survivor] }),
      ]);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({ buttonId: 'deny', payload: { requestId: 'req-old' } });
    });

    it('ref 有效: 应答一次(不带 alert)并派发给卡片处理器, 不动键盘', async () => {
      await connect();
      const seen: IMCardActionEvent[] = [];
      im.onCardAction((e) => void seen.push(e));
      api.calls.length = 0;
      const data = encodeCallbackData('allow', { requestId: 'req-1' });
      api.pushUpdates([callbackUpdate({ data, fromId: 111, updateId: 10 })]);

      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({ buttonId: 'allow', payload: { requestId: 'req-1' } });
      const answers = api.calls.filter((c) => c.method === 'answerCallbackQuery');
      expect(answers).toHaveLength(1);
      expect(answers[0].params.text).toBeUndefined();
      expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);
    });

    it('非 owner 点按: 只消 loading, 不派发也不改别人看到的卡片', async () => {
      await connect();
      const seen: IMCardActionEvent[] = [];
      im.onCardAction((e) => void seen.push(e));
      api.calls.length = 0;
      api.pushUpdates([callbackUpdate({ data: 'cbr:whatever', fromId: 222, updateId: 11 })]);

      await vi.waitFor(() =>
        expect(api.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1),
      );
      expect(api.calls[api.calls.length - 1].params.text).toBeUndefined();
      expect(seen).toHaveLength(0);
      expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);
    });

    it('HTML 编辑失败退回纯文本时仍带上空键盘(否则收口卡片的按钮还在)', async () => {
      await connect();
      api.calls.length = 0;
      api.failNextCall(
        'editMessageText',
        new TelegramApiError('editMessageText', 400, "can't parse entities"),
      );
      await im.updateInteractiveCard(encodeMessageId('111', '55'), {
        body: '已过期',
        buttons: [],
      });

      const edits = api.calls.filter((c) => c.method === 'editMessageText');
      expect(edits).toHaveLength(2);
      expect(edits[1].params.parse_mode).toBeUndefined();
      expect(edits[1].params.reply_markup).toEqual({ inline_keyboard: [] });
    });
  });

  describe('离线期积压消息(stale update)', () => {
    // Telegram 会替离线的 bot 保留最长 24h 的 update, 一上线整批推来。桌面端
    // 天天关机开机, 这是个人 bot 的常态而非异常 —— 官方 bot 服务端早有这道闸
    // (2026-07-27 实踩: 整批历史消息被诈尸回复), 个人侧此前一道都没有。

    it('隔夜私聊消息不再起 turn', async () => {
      const events: IMMessageEvent[] = [];
      im.onMessage((e) => events.push(e));
      await connect();
      api.pushUpdates([
        privateMessage('昨晚发的', Number(OWNER_ID), 80, 8 * 3_600),
        privateMessage('刚发的', Number(OWNER_ID), 81),
      ]);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      // 只有新鲜那条进了 turn; 陈旧那条静默消费。
      expect(events[0]).toMatchObject({ text: '刚发的' });
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toHaveLength(1);
    });

    it('陌生人的陈旧私聊不再收到「我不认识你」', async () => {
      await connect();
      const before = api.calls.filter((c) => c.method === 'sendMessage').length;
      api.pushUpdates([privateMessage('在吗', 999, 82, 8 * 3_600)]);
      await new Promise((r) => setTimeout(r, 300));
      // 隔夜再回一句拒绝语同样是诈尸 —— 一条出站都不该有。
      expect(api.calls.filter((c) => c.method === 'sendMessage').length).toBe(before);
    });

    it('陈旧群消息仍进历史池, 但不再唤起回答', async () => {
      const events: IMMessageEvent[] = [];
      const windowEntries: TelegramGroupWindowEntry[] = [];
      im.onMessage((e) => events.push(e));
      im.onGroupWindowMessage((e) => windowEntries.push(e));
      await connect();
      api.pushUpdates([
        groupMessage({ text: '昨晚问的', fromId: 111, messageId: 83, mentionBot: true, ageSec: 8 * 3_600 }),
        groupMessage({ text: '刚问的', fromId: 111, messageId: 84, mentionBot: true }),
      ]);
      // 群消息的历史价值与「该不该现在回答」是两件事: 两条都入窗, 只有一条起 turn。
      await vi.waitFor(() => expect(windowEntries).toHaveLength(2));
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ text: '刚问的' });
    });

    it('阈值内的离线积压照常处理 —— 短暂离线不误杀', async () => {
      const events: IMMessageEvent[] = [];
      im.onMessage((e) => events.push(e));
      await connect();
      // 用户合上电脑二十分钟再打开, 那条正等回复的消息仍然该被处理。
      api.pushUpdates([privateMessage('二十分钟前发的', Number(OWNER_ID), 85, 20 * 60)]);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ text: '二十分钟前发的' });
    });

    it('时间戳缺失按新鲜处理 —— 拦错比多回一条严重', async () => {
      const events: IMMessageEvent[] = [];
      im.onMessage((e) => events.push(e));
      await connect();
      const update = privateMessage('没有时间戳', Number(OWNER_ID), 86);
      update.message!.date = 0;
      api.pushUpdates([update]);
      await vi.waitFor(() => expect(events).toHaveLength(1));
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
