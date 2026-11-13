import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramApiError } from '@cindy/im';

import {
  beginChannelToolScope,
  resetChannelToolScopeForTests,
  type TelegramToolScope,
  type TelegramToolTransport,
} from '../../im/shared/channelToolScope';
import { createTelegramBotMcpServer, TELEGRAM_DOWNLOAD_SUBDIR } from '../telegramBotMcpServer';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface FakeTransport extends TelegramToolTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  echoes: Array<{ userId: string; text: string; messageId: number; fileNames?: string[] }>;
  failNext?: (method: string) => unknown;
}

function fakeTransport(): FakeTransport {
  let seq = 100;
  const t: FakeTransport = {
    calls: [],
    echoes: [],
    getBotApi: () => ({
      async call(method: string, params: Record<string, unknown> = {}) {
        t.calls.push({ method, params });
        const failure = t.failNext?.(method);
        if (failure) throw failure;
        if (method === 'getChat') return { id: Number(params.chat_id), type: 'supergroup', title: 'Ops' } as never;
        if (method === 'getChatMemberCount') return 12 as never;
        if (method === 'getChatAdministrators') {
          return [{ status: 'creator', user: { id: 1, first_name: 'Chris', username: 'chris', is_bot: false } }] as never;
        }
        if (/^(send|copy|forward)/.test(method)) {
          seq += 1;
          return { message_id: seq, chat: { id: Number(params.chat_id), type: 'supergroup' }, date: 1 } as never;
        }
        return true as never;
      },
      async callForm() {
        throw new Error('unexpected');
      },
      fileUrl: (p: string) => `https://files/${p}`,
    }),
    getBotId: () => '999',
    getBotUsername: () => 'hulu_bot',
    resolveSendTarget: (userId: string) => {
      if (!userId.startsWith('g/')) return { chat_id: userId };
      const [chatId, threadId] = userId.slice(2).split('/');
      return threadId ? { chat_id: chatId, message_thread_id: Number(threadId) } : { chat_id: chatId };
    },
    recordOutboundEcho: (userId, text, sent, fileNames) => {
      t.echoes.push({ userId, text, messageId: sent.message_id, ...(fileNames ? { fileNames } : {}) });
    },
    sendMedia: vi.fn(async (_userId, input) => {
      if (!input.absPath && !input.url && !input.fileId) throw new Error('NO_SOURCE');
      return { messageId: '-100|501' };
    }),
    downloadFile: vi.fn(async (_fileId, destDir, fileName) => {
      fs.mkdirSync(destDir, { recursive: true });
      const abs = path.join(destDir, fileName ?? 'report.pdf');
      fs.writeFileSync(abs, 'x');
      return { absPath: abs, size: 1, fileName: path.basename(abs) };
    }),
  };
  return t;
}

function groupScope(t: FakeTransport, overrides: Partial<TelegramToolScope> = {}): TelegramToolScope {
  return {
    channel: 'telegram',
    im: t,
    botId: 'bot-1',
    laneUserId: 'g/-100/7',
    chatId: '-100',
    threadId: '7',
    chatKind: 'group',
    requesterIsOwner: false,
    triggerMessageId: '81',
    companion: false,
    ...overrides,
  };
}

function ownerDmScope(t: FakeTransport): TelegramToolScope {
  return groupScope(t, {
    laneUserId: '123',
    chatId: '123',
    threadId: '',
    chatKind: 'direct',
    requesterIsOwner: true,
    triggerMessageId: '5',
  });
}

async function withServer(
  scope: TelegramToolScope | null,
  run: (call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>,
  options: { workingDir?: string; contextInstanceId?: string } = {},
) {
  const release = scope
    ? beginChannelToolScope({ sessionId: 's-1', sessionInstanceId: 'i-1', scope })
    : null;
  const server = createTelegramBotMcpServer({
    getSessionContext: () => ({
      agentKind: 'claude-code',
      workingDir: options.workingDir ?? '/tmp/task',
      sessionId: 's-1',
      sessionInstanceId: options.contextInstanceId ?? 'i-1',
    }),
  });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tg-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    await run(async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
      return { ...(JSON.parse(text) as Record<string, unknown>), __isError: res.isError === true };
    });
  } finally {
    release?.();
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  resetChannelToolScopeForTests();
});

describe('cindy_telegram_bot scope gate', () => {
  it('fails closed without an active scope, and when the session instance changed', async () => {
    await withServer(null, async (call) => {
      const r = await call('send_text', { text: 'hi' });
      expect(r).toMatchObject({ ok: false, errorCode: 'NO_ACTIVE_TELEGRAM_SCOPE', __isError: true });
    });
    const t = fakeTransport();
    await withServer(
      groupScope(t),
      async (call) => {
        const r = await call('get_chat');
        expect(r).toMatchObject({ ok: false, errorCode: 'NO_ACTIVE_TELEGRAM_SCOPE' });
      },
      { contextInstanceId: 'i-2' },
    );
    expect(t.calls).toEqual([]);
  });

  it('exposes the full tool surface', async () => {
    const t = fakeTransport();
    const server = createTelegramBotMcpServer({ getSessionContext: () => ({ agentKind: 'pi', workingDir: '/x' }) });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tg-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      'call_api',
      'delete_message',
      'download_file',
      'get_chat',
      'pin_message',
      'send_media',
      'send_poll',
      'send_text',
      'set_reaction',
    ]);
    await client.close();
    void t;
  });
});

describe('cindy_telegram_bot sends into the current lane', () => {
  it('send_text targets the lane, honours reply / parse_mode, and echoes into the group window', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      const r = await call('send_text', { text: '<b>hi</b>', parse_mode: 'HTML', reply_to_message_id: '-100|81' });
      expect(r).toMatchObject({ ok: true, messageId: '-100|101', message_id: 101, chat_id: '-100', message_thread_id: 7 });
      expect(t.calls.at(-1)).toEqual({
        method: 'sendMessage',
        params: {
          chat_id: '-100',
          message_thread_id: 7,
          text: '<b>hi</b>',
          parse_mode: 'HTML',
          reply_parameters: { message_id: 81, allow_sending_without_reply: true },
        },
      });
      expect(t.echoes).toEqual([{ userId: 'g/-100/7', text: '<b>hi</b>', messageId: 101 }]);
      expect(await call('send_text', { text: 'x', reply_to_message_id: 'abc' })).toMatchObject({ errorCode: 'INVALID_MESSAGE_ID' });
    });
  });

  it('send_media goes through the transport; guests may only upload files inside the task directory', async () => {
    const t = fakeTransport();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-'));
    try {
      const workingDir = path.join(root, 'work');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(workingDir);
      fs.mkdirSync(outsideDir);
      const inside = path.join(workingDir, 'chart.png');
      const outside = path.join(outsideDir, 'private.txt');
      fs.writeFileSync(inside, 'png');
      fs.writeFileSync(outside, 'fixture');
      const escapeDir = path.join(workingDir, 'outside-link');
      // A file reached through a directory link still escapes realpath containment;
      // Windows junctions keep this regression runnable without symlink privileges.
      fs.symlinkSync(outsideDir, escapeDir, process.platform === 'win32' ? 'junction' : 'dir');
      const escapeLink = path.join(escapeDir, 'private.txt');
      await withServer(
        groupScope(t),
        async (call) => {
          expect(await call('send_media', { kind: 'photo', path: inside, caption: 'c' })).toMatchObject({
            ok: true,
            messageId: '-100|501',
            file: 'chart.png',
          });
          expect(t.sendMedia).toHaveBeenLastCalledWith('g/-100/7', { kind: 'photo', absPath: fs.realpathSync.native(inside), caption: 'c' });
          expect(await call('send_media', { kind: 'document', path: outside })).toMatchObject({
            ok: false,
            errorCode: 'PERMISSION_DENIED',
          });
          // 回归(PR #6289 review): 工作目录里指向外面的 symlink 之前按字面路径放行。
          expect(await call('send_media', { kind: 'document', path: escapeLink })).toMatchObject({
            ok: false,
            errorCode: 'PERMISSION_DENIED',
          });
          expect(t.sendMedia).toHaveBeenCalledTimes(1);
          expect(await call('send_media', { kind: 'document', path: 'relative.bin' })).toMatchObject({ errorCode: 'PATH_NOT_ABSOLUTE' });
          expect(await call('send_media', { kind: 'sticker', file_id: 'CAAC1' })).toMatchObject({ ok: true });
          expect(await call('send_media', { kind: 'photo' })).toMatchObject({ ok: false, errorCode: 'NO_SOURCE' });
        },
        { workingDir },
      );
      // The owner may send any absolute path (same as the Feishu send_file_to_user tool).
      await withServer(ownerDmScope(t), async (call) => {
        expect(await call('send_media', { kind: 'document', path: outside })).toMatchObject({ ok: true });
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('send_poll builds Bot API options and requires correct_option_id for quizzes', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      expect(await call('send_poll', { question: 'Lunch?', options: ['A', 'B'], type: 'quiz' })).toMatchObject({ errorCode: 'INVALID_PARAMS' });
      const r = await call('send_poll', { question: 'Lunch?', options: ['A', 'B'], allows_multiple_answers: true });
      expect(r).toMatchObject({ ok: true, message_id: 101 });
      expect(t.calls.at(-1)).toEqual({
        method: 'sendPoll',
        params: {
          chat_id: '-100',
          message_thread_id: 7,
          question: 'Lunch?',
          options: [{ text: 'A' }, { text: 'B' }],
          allows_multiple_answers: true,
        },
      });
      expect(t.echoes.at(-1)?.text).toBe('[投票] Lunch?\n• A\n• B');
    });
  });

  it('set_reaction defaults to the trigger message and clears with an empty emoji', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      expect(await call('set_reaction', { emoji: '🔥' })).toMatchObject({ ok: true, message_id: 81, emoji: '🔥' });
      expect(t.calls.at(-1)?.params).toEqual({ chat_id: '-100', message_id: 81, reaction: [{ type: 'emoji', emoji: '🔥' }] });
      expect(await call('set_reaction', { message_id: '90' })).toMatchObject({ ok: true, message_id: 90, emoji: null });
      expect(t.calls.at(-1)?.params).toEqual({ chat_id: '-100', message_id: 90, reaction: [] });
    });
  });

  it('download_file saves under <workingDir>/telegram-downloads', async () => {
    const t = fakeTransport();
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-'));
    try {
      await withServer(
        groupScope(t),
        async (call) => {
          const r = await call('download_file', { file_id: 'f1', file_name: 'a.pdf' });
          expect(r).toMatchObject({ ok: true, fileName: 'a.pdf', size: 1 });
          expect(String(r.absPath).startsWith(path.join(workingDir, TELEGRAM_DOWNLOAD_SUBDIR))).toBe(true);
        },
        { workingDir },
      );
    } finally {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('get_chat describes the current chat with member count and admins', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      const r = await call('get_chat');
      expect(r).toMatchObject({
        ok: true,
        chat: { id: -100, title: 'Ops' },
        member_count: 12,
        administrators: [{ id: 1, name: 'Chris', username: 'chris', status: 'creator' }],
        bot: { id: '999', username: 'hulu_bot' },
        message_thread_id: 7,
      });
    });
  });

  it('maps Telegram API errors to a structured payload the model can act on', async () => {
    const t = fakeTransport();
    t.failNext = (method) => (method === 'sendMessage' ? new TelegramApiError('sendMessage', 429, 'Too Many Requests', 9) : undefined);
    await withServer(groupScope(t), async (call) => {
      expect(await call('send_text', { text: 'x' })).toMatchObject({
        ok: false,
        errorCode: 'TELEGRAM_API_ERROR',
        error_code: 429,
        retry_after: 9,
        __isError: true,
      });
    });
  });
});

describe('cindy_telegram_bot owner-only and call_api boundaries', () => {
  it('pin / delete need an owner-triggered turn', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      expect(await call('pin_message', {})).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
      expect(await call('delete_message', { message_id: '81' })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    });
    expect(t.calls).toEqual([]);
    await withServer(groupScope(t, { requesterIsOwner: true }), async (call) => {
      expect(await call('pin_message', { disable_notification: true })).toMatchObject({ ok: true, message_id: 81, pinned: true });
      expect(t.calls.at(-1)).toEqual({ method: 'pinChatMessage', params: { chat_id: '-100', message_id: 81, disable_notification: true } });
      expect(await call('pin_message', { unpin: true, message_id: '-100|82' })).toMatchObject({ ok: true, pinned: false });
      expect(t.calls.at(-1)).toEqual({ method: 'unpinChatMessage', params: { chat_id: '-100', message_id: 82 } });
      expect(await call('delete_message', { message_id: '83' })).toMatchObject({ ok: true, deleted: true });
    });
  });

  it('call_api pins chat_id to the current chat, injects the topic for sends, and blocks connection-breaking methods', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t, { requesterIsOwner: true }), async (call) => {
      expect(await call('call_api', { method: 'getUpdates' })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
      expect(await call('call_api', { method: 'setWebhook', params: { url: 'https://x' } })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
      // Owner in a group still cannot redirect to another chat (group text is member-controlled).
      expect(await call('call_api', { method: 'sendMessage', params: { chat_id: '-999', text: 'leak' } })).toMatchObject({
        errorCode: 'PERMISSION_DENIED',
      });
      const dice = await call('call_api', { method: 'sendDice', params: { emoji: '🎲' } });
      expect(dice).toMatchObject({ ok: true, method: 'sendDice' });
      expect(t.calls.at(-1)).toEqual({ method: 'sendDice', params: { emoji: '🎲', chat_id: '-100', message_thread_id: 7 } });
      expect(t.echoes.at(-1)).toMatchObject({ text: '[sendDice]' });
      await call('call_api', { method: 'banChatMember', params: { user_id: 5 } });
      // Non-send methods get the chat but not the topic id.
      expect(t.calls.at(-1)).toEqual({ method: 'banChatMember', params: { user_id: 5, chat_id: '-100' } });
      await call('call_api', { method: 'getMe' });
      expect(t.calls.at(-1)).toEqual({ method: 'getMe', params: {} });
    });
    expect(t.calls.some((c) => c.method === 'getUpdates' || c.method === 'setWebhook')).toBe(false);
  });

  it('call_api from a guest turn allows read / send methods only', async () => {
    const t = fakeTransport();
    await withServer(groupScope(t), async (call) => {
      expect(await call('call_api', { method: 'getChatMember', params: { user_id: 5 } })).toMatchObject({ ok: true });
      expect(await call('call_api', { method: 'sendLocation', params: { latitude: 1, longitude: 2 } })).toMatchObject({ ok: true });
      for (const method of ['banChatMember', 'restrictChatMember', 'setChatTitle', 'pinChatMessage', 'deleteMessage', 'leaveChat', 'createForumTopic']) {
        expect(await call('call_api', { method })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
      }
    });
    expect(t.calls.map((c) => c.method)).toEqual(['getChatMember', 'sendLocation']);
  });

  it('only an owner DM turn may address another chat explicitly', async () => {
    const t = fakeTransport();
    await withServer(ownerDmScope(t), async (call) => {
      const r = await call('call_api', { method: 'sendMessage', params: { chat_id: '-100', text: 'to the group' } });
      expect(r).toMatchObject({ ok: true });
      expect(t.calls.at(-1)).toEqual({ method: 'sendMessage', params: { chat_id: '-100', text: 'to the group' } });
      // Cross-chat sends are not echoed into the DM lane window (nothing to echo for a DM anyway).
      expect(t.echoes).toEqual([]);
    });
  });
});
