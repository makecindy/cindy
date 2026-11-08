/**
 * 自定义渠道传输层: token 校验、按 conversationId 分线、出站回调形状。
 */

import { describe, expect, it } from 'vitest';

import type { IMHost } from '@cindy/im';
import { createCustomIM } from '@cindy/im';

const TOKEN = 'b'.repeat(64);

function host(): IMHost {
  return {
    secrets: {
      write: () => true,
      read: () => null,
      remove: () => {},
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code: string, message: string) => {
        throw new Error(`${code}: ${message}`);
      },
      handle: () => {},
      broadcast: () => {},
    },
    paths: { feishuMediaDir: '/tmp' },
    httpPostForm: async () => ({ status: 200, body: null }),
  };
}

describe('CustomIM', () => {
  it('token 不符不入站; 合法入站带 scopeKey=conversationId', () => {
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
    });
    const events: Array<{ chatId: string; scopeKey?: string }> = [];
    im.onMessage((e) => events.push({ chatId: e.chatId, scopeKey: e.scopeKey }));

    expect(im.handleInbound('wrong', { conversationId: 'c1', text: 'hi' })).toBe(false);
    expect(im.handleInbound(TOKEN, { conversationId: 'c1', text: 'hi' })).toBe(true);
    expect(events).toEqual([{ chatId: 'c1', scopeKey: 'c1' }]);
  });

  it('终稿回调带 conversationId、terminal 与附件绝对路径', async () => {
    const delivered: Array<{ url: string; body: unknown; token: string }> = [];
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: 'http://127.0.0.1:9/hook',
      resolveAttachment: (absPath) => ({ name: absPath.split('/').pop() ?? 'file', mimeType: 'text/plain' }),
      deliver: async (url, body, token) => void delivered.push({ url, body, token }),
    });

    await im.commitFinal({
      userId: 'c1',
      text: 'done',
      terminal: 'done',
      mediaAbsPaths: ['/tmp/out.txt'],
    });

    expect(delivered).toEqual([
      {
        url: 'http://127.0.0.1:9/hook',
        token: TOKEN,
        body: {
          conversationId: 'c1',
          text: 'done',
          terminal: 'done',
          attachments: [{ absPath: '/tmp/out.txt', name: 'out.txt' }],
        },
      },
    ]);
  });

  it('没有 callbackUrl 时只入站, 不发请求', async () => {
    const delivered: unknown[] = [];
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
      deliver: async () => void delivered.push(1),
    });
    await im.commitFinal({ userId: 'c1', text: 'done', terminal: 'done' });
    expect(delivered).toEqual([]);
  });

  it('userId 只做发言人, 路由与会话仍锚在 conversationId', () => {
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
    });
    const seen: Array<Record<string, unknown>> = [];
    im.onMessage((e) =>
      seen.push({
        senderId: e.senderId,
        chatId: e.chatId,
        contextId: e.contextId,
        speaker: e.speaker,
      }),
    );
    im.handleInbound(TOKEN, { conversationId: 'order-1', userId: 'u-9', userName: '张三', text: 'hi' });
    expect(seen).toEqual([
      {
        senderId: 'order-1',
        chatId: 'order-1',
        contextId: 'conn-1',
        speaker: { id: 'u-9', name: '张三', isOwner: false },
      },
    ]);
  });

  it('每条入站消息的回调地址按顺序消费, 不会互相覆盖', async () => {
    const delivered: Array<{ url: string; body: any }> = [];
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
      deliver: async (url, body) => void delivered.push({ url, body }),
    });

    im.handleInbound(TOKEN, { conversationId: 'c1', text: 'first', callbackUrl: 'http://127.0.0.1:1/a' });
    im.handleInbound(TOKEN, { conversationId: 'c1', text: 'second', callbackUrl: 'http://127.0.0.1:1/b' });

    await im.commitFinal({ userId: 'c1', text: 'r1', terminal: 'done' });
    await im.commitFinal({ userId: 'c1', text: 'r2', terminal: 'done' });

    expect(delivered.map((item) => item.url)).toEqual([
      'http://127.0.0.1:1/a',
      'http://127.0.0.1:1/b',
    ]);
  });

  it('直接回复(如 /help)也走当前消息的回调地址', async () => {
    const delivered: Array<{ url: string; body: any }> = [];
    const im = createCustomIM(host(), {
      connectionId: 'conn-1',
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: 'http://127.0.0.1:1/default',
      deliver: async (url, body) => void delivered.push({ url, body }),
    });

    im.handleInbound(TOKEN, { conversationId: 'c1', text: '/help', callbackUrl: 'http://127.0.0.1:1/temp' });
    await im.sendText('c1', 'commands');

    expect(delivered).toEqual([
      {
        url: 'http://127.0.0.1:1/temp',
        body: { conversationId: 'c1', text: 'commands', terminal: 'done', attachments: [] },
      },
    ]);
  });
});
