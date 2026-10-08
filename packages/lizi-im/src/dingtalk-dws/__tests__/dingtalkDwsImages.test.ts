import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent } from '../../types.js';
import { DingTalkDwsIM } from '../index.js';
import { DWS_EVENT_DIRECT } from '../events.js';
import type { DwsRunner, DwsStreamProcess } from '../runner.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** 最小事件流桩：连上即 ready，可推送 NDJSON 事件。 */
class FakeStream implements DwsStreamProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly events = new EventEmitter();
  closeStdin(): void {
    this.events.emit('exit', 0);
  }
  forceKill(): void {
    this.events.emit('exit', null);
  }
  onExit(handler: (code: number | null) => void): void {
    this.events.once('exit', handler);
  }
  onError(handler: (error: Error) => void): void {
    this.events.once('error', handler);
  }
  emit(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

type Download = { localPath: string; bytes: Uint8Array; resourceId: string; messageId: string };

function setup(
  options: {
    downloads?: Download[];
    failedCount?: number;
    mgetError?: boolean;
    filesDir?: string;
    history?: Array<Record<string, unknown>>;
  } = {},
) {
  const secrets = new Map<string, string>([['dingtalk-dws-enabled', '1']]);
  const cached: Array<{ token: string; mimeType: string; size: number }> = [];
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
      handle: () => undefined,
      broadcast: () => undefined,
    },
    paths: {
      feishuMediaDir: '/unused',
      ...(options.filesDir ? { dingtalkMediaDir: options.filesDir } : {}),
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
    media: {
      cacheImage: vi.fn(async (params) => {
        cached.push({ token: params.token, mimeType: params.mimeType, size: params.buffer.byteLength });
        return { absPath: `/cache/${cached.length}.png`, url: `cindy-media://blobs/${cached.length}.png` };
      }),
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: () => null,
    },
  };
  const mgetCalls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const streams: FakeStream[] = [];
  const runner: DwsRunner = {
    isAvailable: async () => true,
    runJson: vi.fn(async (args: readonly string[], opts?: { cwd?: string }) => {
      if (args[0] === 'auth') {
        return {
          authenticated: true,
          token_valid: true,
          corp_id: 'corp',
          corp_name: 'Org',
          user_id: 'agent',
          user_name: 'Cindy 助手',
        };
      }
      if (args[1] === '+messages-mget') {
        mgetCalls.push({ args, cwd: opts?.cwd });
        if (options.mgetError) throw new Error('mget failed');
        // 模拟 dws：把资源写进 cwd 下的相对路径，并返回 ledger。
        for (const download of options.downloads ?? []) {
          const target = path.join(opts!.cwd!, download.localPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, download.bytes);
        }
        return {
          messages: [],
          resourceDownloads: {
            downloads: (options.downloads ?? []).map((d) => ({
              localPath: d.localPath,
              resourceId: d.resourceId,
              messageId: d.messageId,
              resourceType: 'mediaId',
              sizeBytes: d.bytes.byteLength,
            })),
            failedCount: options.failedCount ?? 0,
          },
        };
      }
      if (args[1] === '+chat-messages') return { messages: options.history ?? [] };
      return { success: true };
    }),
    spawnStream: vi.fn(() => {
      const stream = new FakeStream();
      streams.push(stream);
      setTimeout(() => stream.stderr.write('[event] ready event_count=2\n'), 0);
      return stream;
    }),
  };
  const im = new DingTalkDwsIM(host, runner);
  const messages: IMMessageEvent[] = [];
  im.onMessage((event) => messages.push(event));
  return { im, host, runner, streams, messages, mgetCalls, cached };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function connectAndPair(ctx: ReturnType<typeof setup>): Promise<void> {
  await ctx.im.init();
  const code = ctx.im.getPublicState().pairingCode;
  ctx.streams[0].emit({
    type: DWS_EVENT_DIRECT,
    event_id: 'evt-pair',
    message_id: 'msg-pair',
    conversation_id: 'cid-dm',
    sender: '张三',
    sender_open_dingtalk_id: 'owner-open',
    content: code,
  });
  await flush();
  ctx.mgetCalls.length = 0;
}

function ownerMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: DWS_EVENT_DIRECT,
    event_id: `evt-${Math.random()}`,
    message_id: 'msg-img',
    conversation_id: 'cid-dm',
    sender: '张三',
    sender_open_dingtalk_id: 'owner-open',
    content: '看下这张截图',
    ...overrides,
  };
}

describe('DingTalkDwsIM inbound images', () => {
  it('downloads screenshots through dws and attaches them as images', async () => {
    const ctx = setup({
      downloads: [{ localPath: 'downloads/shot.png', bytes: PNG, resourceId: 'media-1', messageId: 'msg-img' }],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage());
    await flush();
    expect(ctx.mgetCalls[0].args).toEqual(
      expect.arrayContaining(['+messages-mget', '--msg-ids', 'msg-img', '--download-resources']),
    );
    expect(ctx.messages[0].attachments).toEqual([
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', url: 'cindy-media://blobs/1.png' }),
    ]);
    expect(ctx.cached[0]).toMatchObject({ token: 'dws:media-1', mimeType: 'image/png' });
    // 临时目录用完即删。
    expect(fs.existsSync(ctx.mgetCalls[0].cwd!)).toBe(false);
    await ctx.im.dispose();
  });

  it('also fetches the quoted message so "this screenshot" works', async () => {
    const ctx = setup();
    await connectAndPair(ctx);
    ctx.streams[0].emit(
      ownerMessage({
        content: '这张图什么意思',
        quoted_message: { message_id: 'msg-quoted', sender: '同事', content: '[图片]' },
      }),
    );
    await flush();
    const idsArg = ctx.mgetCalls[0].args[ctx.mgetCalls[0].args.indexOf('--msg-ids') + 1];
    expect(idsArg).toBe('msg-img,msg-quoted');
    await ctx.im.dispose();
  });

  it('keeps image-only direct messages instead of dropping them as empty', async () => {
    const ctx = setup({
      downloads: [{ localPath: 'downloads/a.png', bytes: PNG, resourceId: 'media-2', messageId: 'msg-img' }],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage({ content: '' }));
    await flush();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].attachments).toHaveLength(1);
    await ctx.im.dispose();
  });

  it('marks failed downloads and non-image files without blocking the message', async () => {
    const ctx = setup({
      downloads: [
        { localPath: 'downloads/doc.pdf', bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]), resourceId: 'f1', messageId: 'msg-img' },
      ],
      failedCount: 1,
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage());
    await flush();
    expect(ctx.messages[0].text).toBe('看下这张截图');
    expect(ctx.messages[0].attachments).toEqual([]);
    expect(ctx.messages[0].unsupported).toEqual([
      { type: 'picture', label: '图片（下载失败）' },
      { type: 'file', label: '文件' },
    ]);
    await ctx.im.dispose();
  });

  it('still delivers the text when the whole lookup fails', async () => {
    const ctx = setup({ mgetError: true });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage());
    await flush();
    expect(ctx.messages[0]).toMatchObject({ text: '看下这张截图', attachments: [], unsupported: [] });
    await ctx.im.dispose();
  });

  it('ignores paths that escape the temporary directory', async () => {
    const ctx = setup({
      downloads: [{ localPath: '../escape.png', bytes: PNG, resourceId: 'x', messageId: 'msg-img' }],
    });
    // 写桩会真的写到上级目录；这里只校验不会被当成附件读入。
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage());
    await flush();
    expect(ctx.messages[0].attachments).toEqual([]);
    const escaped = path.join(path.dirname(ctx.mgetCalls[0].cwd!), 'escape.png');
    fs.rmSync(escaped, { force: true });
    await ctx.im.dispose();
  });
});

describe('DingTalkDwsIM inbound files', () => {
  it('saves non-image files into the injected DingTalk files directory', async () => {
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dws-files-test-'));
    const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const ctx = setup({
      filesDir,
      downloads: [{ localPath: 'downloads/report.pdf', bytes: PDF, resourceId: 'f1', messageId: 'msg-img' }],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage({ content: '帮我看下这份报告' }));
    await flush();
    const [attachment] = ctx.messages[0].attachments;
    expect(attachment).toMatchObject({ kind: 'file', originalName: 'report.pdf', mimeType: 'application/pdf' });
    expect(path.dirname(attachment.absPath)).toBe(filesDir);
    expect(fs.readFileSync(attachment.absPath)).toEqual(Buffer.from(PDF));
    expect(ctx.messages[0].unsupported).toEqual([]);
    fs.rmSync(filesDir, { recursive: true, force: true });
    await ctx.im.dispose();
  });
});

describe('DingTalkDwsIM group history resources', () => {
  const history = [
    { messageId: 'h1', sender: '甲', senderId: 'a', text: '这是报错截图', createTime: '2026-10-05 10:01:00' },
    { messageId: 'h2', sender: '乙', senderId: 'b', text: '', createTime: '2026-10-05 10:02:00' },
    { messageId: 'trigger', sender: '丙', senderId: 'c', text: '@Cindy 看下', createTime: '2026-10-05 10:03:00' },
  ];

  it('downloads resources of recent messages, excluding the trigger, and hangs them per message', async () => {
    const ctx = setup({
      history,
      downloads: [{ localPath: 'downloads/err.png', bytes: PNG, resourceId: 'm-err', messageId: 'h2' }],
    });
    await ctx.im.init();
    const result = await ctx.im.fetchRecentGroupMessages('cid-group', 30, {
      withResources: 10,
      excludeMessageId: 'trigger',
    });
    const idsArg = ctx.mgetCalls[0].args[ctx.mgetCalls[0].args.indexOf('--msg-ids') + 1];
    expect(idsArg).toBe('h1,h2');
    expect(result.find((m) => m.messageId === 'h2')?.attachments).toEqual([
      expect.objectContaining({ kind: 'image', mimeType: 'image/png' }),
    ]);
    expect(result.find((m) => m.messageId === 'h1')?.attachments).toEqual([]);
    await ctx.im.dispose();
  });

  it('does not download anything unless resources are requested', async () => {
    const ctx = setup({ history });
    await ctx.im.init();
    await ctx.im.fetchRecentGroupMessages('cid-group', 30);
    expect(ctx.mgetCalls).toHaveLength(0);
    await ctx.im.dispose();
  });
});

describe('DingTalkDwsIM quoted attachments', () => {
  it('keeps quoted-message attachments out of the current message attachments', async () => {
    const ctx = setup({
      downloads: [
        { localPath: 'downloads/own.png', bytes: PNG, resourceId: 'own', messageId: 'msg-img' },
        { localPath: 'downloads/quoted.png', bytes: PNG, resourceId: 'quoted', messageId: 'msg-quoted' },
      ],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(
      ownerMessage({
        content: '对比一下这两张',
        quoted_message: { message_id: 'msg-quoted', sender: '同事', content: '[图片]' },
      }),
    );
    await flush();
    const event = ctx.messages[0];
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments[0].url).toBe('cindy-media://blobs/1.png');
    expect(event.replyAttachments).toEqual([
      expect.objectContaining({ kind: 'image', url: 'cindy-media://blobs/2.png' }),
    ]);
    await ctx.im.dispose();
  });

  it('still delivers a text-free reply that only quotes an image', async () => {
    const ctx = setup({
      downloads: [
        { localPath: 'downloads/quoted.png', bytes: PNG, resourceId: 'q', messageId: 'msg-quoted' },
      ],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(
      ownerMessage({ content: '', quoted_message: { message_id: 'msg-quoted', sender: '同事', content: '' } }),
    );
    await flush();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].attachments).toEqual([]);
    expect(ctx.messages[0].replyAttachments).toHaveLength(1);
    await ctx.im.dispose();
  });
});

describe('DingTalkDwsIM group context files', () => {
  const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const history = [
    { messageId: 'h1', sender: '甲', senderId: 'a', text: '方案文档', createTime: '2026-10-05 10:01:00' },
  ];

  it('reuses one stored copy when the same file is pulled into context repeatedly', async () => {
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dws-context-test-'));
    const ctx = setup({
      filesDir,
      history,
      downloads: [{ localPath: 'downloads/plan.pdf', bytes: PDF, resourceId: 'file-1', messageId: 'h1' }],
    });
    await ctx.im.init();
    const first = await ctx.im.fetchRecentGroupMessages('cid', 30, { withResources: 10 });
    const second = await ctx.im.fetchRecentGroupMessages('cid', 30, { withResources: 10 });
    const a = first[0].attachments[0];
    const b = second[0].attachments[0];
    expect(a).toMatchObject({ kind: 'file', originalName: 'plan.pdf' });
    expect(b.absPath).toBe(a.absPath);
    const contextRoot = path.join(filesDir, 'context');
    expect(fs.readdirSync(contextRoot)).toHaveLength(1);
    fs.rmSync(filesDir, { recursive: true, force: true });
    await ctx.im.dispose();
  });

  it('prunes context files that have not been used for 7 days', async () => {
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dws-context-prune-'));
    const staleDir = path.join(filesDir, 'context', 'stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const staleFile = path.join(staleDir, 'old.pdf');
    fs.writeFileSync(staleFile, 'x');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, old, old);
    const ctx = setup({
      filesDir,
      history,
      downloads: [{ localPath: 'downloads/plan.pdf', bytes: PDF, resourceId: 'file-2', messageId: 'h1' }],
    });
    await ctx.im.init();
    await ctx.im.fetchRecentGroupMessages('cid', 30, { withResources: 10 });
    await flush();
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.readdirSync(path.join(filesDir, 'context'))).toHaveLength(1);
    fs.rmSync(filesDir, { recursive: true, force: true });
    await ctx.im.dispose();
  });

  it('keeps direct-message files as individual attachments (not in the context cache)', async () => {
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dws-direct-files-'));
    const ctx = setup({
      filesDir,
      downloads: [{ localPath: 'downloads/r.pdf', bytes: PDF, resourceId: 'f9', messageId: 'msg-img' }],
    });
    await connectAndPair(ctx);
    ctx.streams[0].emit(ownerMessage());
    await flush();
    expect(path.dirname(ctx.messages[0].attachments[0].absPath)).toBe(filesDir);
    expect(fs.existsSync(path.join(filesDir, 'context'))).toBe(false);
    fs.rmSync(filesDir, { recursive: true, force: true });
    await ctx.im.dispose();
  });
});
