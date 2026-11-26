/**
 * 纯文本回答模式(replyFormat='text'):
 *   - FeishuIM 默认仍然是卡片流式, 只有配置成 text 才走纯文本;
 *   - text 模式整段回答一次性发出, 超长按飞书单条上限切片、按顺序发;
 *   - 中间帧(逐字增量 / 工具进度 / 过程记录)不进聊天;
 *   - 空回答不发空消息;
 *   - 正文里的图片 / 文件附件单独成条发出。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const outboundMocks = vi.hoisted(() => ({
  claimPatchableOpener: vi.fn<() => string | null>(() => null),
  getBoundClient: vi.fn<() => { fake: string } | null>(() => ({ fake: 'client' })),
  getAccountEpoch: vi.fn(() => 1),
  recallOwnMessage: vi.fn(async () => true),
  recallOwnMessageWith: vi.fn(async () => true),
  rearmAnchorToTrigger: vi.fn(() => true),
  deferOpenerConsume: vi.fn(),
  drainDeferredOpenerConsumes: vi.fn<() => unknown[]>(() => []),
  takeMatchingDeferredOpenerConsume: vi.fn<() => unknown>(() => undefined),
  takeDeferredOpenerConsumeById: vi.fn<() => unknown>(() => undefined),
  drainEvictedOpeners: vi.fn<() => string[]>(() => []),
  getOpenerTrigger: vi.fn<() => string | undefined>(() => undefined),
  sendText: vi.fn<(userId: string, text: string, opts?: { threadTs?: string }) => Promise<{ messageId: string }>>(
    async () => ({ messageId: 'om_text' }),
  ),
  sendFile: vi.fn<
    (userId: string, absPath: string, displayName?: string, opts?: { threadTs?: string }) => Promise<{ ok: boolean; messageId: string }>
  >(async () => ({ ok: true, messageId: 'om_file' })),
  sendInteractive: vi.fn<(userId: string, spec: unknown, opts?: { threadTs?: string }) => Promise<{ messageId: string }>>(
    async () => ({ messageId: 'om_card' }),
  ),
  updateInteractive: vi.fn(async () => undefined),
  registerCardLane: vi.fn(),
  patchCardRaw: vi.fn(async () => undefined),
  sendCardRaw: vi.fn(async () => ({ messageId: 'om_stream' })),
  uploadImage: vi.fn(async () => 'img_key'),
}));

vi.mock('../outbound.js', () => outboundMocks);

const streamingMocks = vi.hoisted(() => ({
  start: vi.fn(async () => ({
    messageId: 'om_stream',
    append: vi.fn(),
    replace: vi.fn(),
    finalize: vi.fn(async () => undefined),
    close: vi.fn(),
  })),
  patchMarkdown: vi.fn(async () => undefined),
}));

vi.mock('../streamingText.js', () => streamingMocks);

vi.mock('../wsClient.js', () => ({
  QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS: 4500,
  getCurrentStatus: () => 'idle',
  getCurrentBotAppId: () => null,
  setLifecycleAnnouncement: vi.fn(),
  stop: vi.fn(async () => undefined),
  start: vi.fn(async () => 'connected' as const),
}));

vi.mock('../storage.js', () => ({
  readCredentials: () => null,
  readOwnerOpenId: () => null,
  readLifecycleAnnouncement: () => true,
  writeLifecycleAnnouncement: vi.fn(),
  writeCredentials: vi.fn(),
  writeOwnerOpenId: vi.fn(),
  clearAll: vi.fn(),
}));

vi.mock('../ownerGuard.js', () => ({
  loadFromDisk: vi.fn(),
  firstAllowed: () => null,
  clear: vi.fn(),
}));

vi.mock('../appRegistration.js', () => ({
  requestAppRegistration: vi.fn(),
  pollAppRegistration: vi.fn(),
}));

vi.mock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
  getLog: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }),
  setHost: vi.fn(),
}));

import { FeishuIM } from '../index.js';
import {
  FEISHU_TEXT_CONTENT_MAX_BYTES,
  deliverPlainTextFinal,
  splitFeishuPlainText,
  textMessageBytes,
} from '../textReply.js';

function makeIm(replyFormat?: () => 'card' | 'text'): FeishuIM {
  return new FeishuIM({} as unknown as IMHost, replyFormat ? { replyFormat } : {});
}

describe('splitFeishuPlainText', () => {
  it('keeps a short answer as one message', () => {
    expect(splitFeishuPlainText('简短回答')).toEqual(['简短回答']);
  });

  it('returns no message for an empty answer', () => {
    expect(splitFeishuPlainText('')).toEqual([]);
    expect(splitFeishuPlainText('  \n\n \t ')).toEqual([]);
  });

  it('splits an oversized answer into ordered messages that each fit the limit', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段: ${'内容'.repeat(20)}`);
    const text = paragraphs.join('\n\n');
    const chunks = splitFeishuPlainText(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(textMessageBytes(chunk)).toBeLessThanOrEqual(400);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers paragraph boundaries', () => {
    const text = `${'A'.repeat(120)}\n\n${'B'.repeat(120)}\n\n${'C'.repeat(120)}`;
    const chunks = splitFeishuPlainText(text, 150);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(`${'A'.repeat(120)}\n\n`);
    expect(chunks[1]).toBe(`${'B'.repeat(120)}\n\n`);
    expect(chunks[2]).toBe('C'.repeat(120));
  });

  it('never splits a surrogate pair', () => {
    const text = '🔥'.repeat(200);
    const chunks = splitFeishuPlainText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(textMessageBytes(chunk)).toBeLessThanOrEqual(120);
      expect(chunk).toBe('🔥'.repeat(chunk.length / 2));
    }
    expect(chunks.join('')).toBe(text);
  });

  it('counts the JSON-escaped bytes the platform enforces', () => {
    const text = '"\n"'.repeat(100);
    const chunks = splitFeishuPlainText(text, 200);
    for (const chunk of chunks) expect(textMessageBytes(chunk)).toBeLessThanOrEqual(200);
    expect(chunks.join('')).toBe(text);
  });

  it('keeps the default budget under the feishu content cap', () => {
    const text = 'x'.repeat(FEISHU_TEXT_CONTENT_MAX_BYTES);
    const chunks = splitFeishuPlainText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(textMessageBytes(chunk)).toBeLessThanOrEqual(FEISHU_TEXT_CONTENT_MAX_BYTES);
    }
  });
});

describe('deliverPlainTextFinal', () => {
  function deps() {
    return {
      sendText: vi.fn<(text: string) => Promise<{ messageId: string }>>(
        async () => ({ messageId: 'om_text' }),
      ),
      sendAttachment: vi.fn<(absPath: string, displayName?: string) => Promise<boolean>>(
        async () => true,
      ),
      resolveImageUrl: vi.fn<(url: string) => string | null>(() => null),
    };
  }

  it('sends nothing for an empty answer without attachments', async () => {
    const d = deps();
    await deliverPlainTextFinal(d, '   ');
    expect(d.sendText).not.toHaveBeenCalled();
    expect(d.sendAttachment).not.toHaveBeenCalled();
  });

  it('sends long text in ordered chunks', async () => {
    const d = deps();
    const line = `line ${'y'.repeat(200)}`;
    const text = Array.from({ length: 1200 }, () => line).join('\n');
    await deliverPlainTextFinal(d, text);
    expect(d.sendText.mock.calls.length).toBeGreaterThan(1);
    const expected = splitFeishuPlainText(text);
    expect(d.sendText.mock.calls.map((call) => call[0])).toEqual(expected);
    for (const chunk of expected) {
      expect(textMessageBytes(chunk)).toBeLessThanOrEqual(FEISHU_TEXT_CONTENT_MAX_BYTES);
    }
  });

  it('sends inline images, file links and extra tool images once, after the text', async () => {
    const d = deps();
    d.resolveImageUrl.mockReturnValue('/tmp/img.png');
    const text = [
      '看这张图',
      '![shot](xdt-image://cindy-media/abc.png)',
      '[report.pdf](xdt-file:///tmp/report.pdf)',
      '![dup](xdt-image://cindy-media/abc.png)',
    ].join('\n');
    await deliverPlainTextFinal(d, text, ['/tmp/img.png', '/tmp/extra.png']);
    expect(d.sendText.mock.calls).toEqual([['看这张图']]);
    expect(d.sendAttachment.mock.calls).toEqual([
      ['/tmp/img.png', undefined],
      ['/tmp/report.pdf', 'report.pdf'],
      ['/tmp/extra.png', undefined],
    ]);
  });
});

describe('FeishuIM reply format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.claimPatchableOpener.mockReturnValue(null);
    outboundMocks.sendText.mockResolvedValue({ messageId: 'om_text' });
    outboundMocks.sendFile.mockResolvedValue({ ok: true, messageId: 'om_file' });
  });

  it('defaults to the streaming card', async () => {
    const im = makeIm();
    const handle = await im.startStreamingText('ou_owner');
    expect(streamingMocks.start).toHaveBeenCalledWith('ou_owner', undefined, undefined);
    expect(handle.messageId).toBe('om_stream');
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('sends the whole answer as plain text once in text mode', async () => {
    const im = makeIm(() => 'text');
    const handle = await im.startStreamingText('ou_owner');
    handle.replace('过程进度');
    handle.append('增量');
    await handle.finalize('最终回答', { process: { title: '过程记录 · 2 项', lines: ['✓ a'] } });
    expect(streamingMocks.start).not.toHaveBeenCalled();
    expect(outboundMocks.sendText.mock.calls.map((call) => call[1])).toEqual(['最终回答']);
    expect(outboundMocks.sendInteractive).not.toHaveBeenCalled();
    expect(outboundMocks.sendCardRaw).not.toHaveBeenCalled();
    expect(outboundMocks.patchCardRaw).not.toHaveBeenCalled();
  });

  it('splits an oversized text-mode answer and sends every part in order', async () => {
    const im = makeIm(() => 'text');
    const handle = await im.startStreamingText('ou_owner');
    const text = Array.from({ length: 1600 }, (_, i) => `line ${i} ${'z'.repeat(120)}`).join('\n');
    await handle.finalize(text);
    const expected = splitFeishuPlainText(text);
    expect(expected.length).toBeGreaterThan(1);
    expect(outboundMocks.sendText.mock.calls.map((call) => call[1])).toEqual(expected);
  });

  it('does not send anything for an empty text-mode answer', async () => {
    const im = makeIm(() => 'text');
    const handle = await im.startStreamingText('ou_owner');
    await handle.finalize('   ');
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
    expect(outboundMocks.sendCardRaw).not.toHaveBeenCalled();
  });

  it('withdraws the group-topic thinking opener instead of patching it', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    const im = makeIm(() => 'text');
    await im.startStreamingText('g/oc_chat');
    expect(outboundMocks.recallOwnMessage).toHaveBeenCalledWith('om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).toHaveBeenCalledWith('g/oc_chat', 'om_opener');
    expect(outboundMocks.patchCardRaw).not.toHaveBeenCalled();
  });

  it('sends markdown notices as plain text in text mode', async () => {
    const im = makeIm(() => 'text');
    await im.sendMarkdownText('ou_owner', '**已连接**');
    expect(outboundMocks.sendText).toHaveBeenCalledWith('ou_owner', '**已连接**', undefined);
    expect(outboundMocks.sendInteractive).not.toHaveBeenCalled();
  });

  it('keeps the card for markdown notices by default', async () => {
    const im = makeIm();
    await im.sendMarkdownText('ou_owner', '**已连接**');
    expect(outboundMocks.sendInteractive).toHaveBeenCalled();
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('recalls a pending opener card instead of patching it in text mode', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    const im = makeIm(() => 'text');
    await expect(im.consumePendingOpenerCard('g/oc_chat', '回答')).resolves.toBe(false);
    expect(streamingMocks.patchMarkdown).not.toHaveBeenCalled();
    expect(outboundMocks.recallOwnMessage).toHaveBeenCalledWith('om_opener');
  });
});
