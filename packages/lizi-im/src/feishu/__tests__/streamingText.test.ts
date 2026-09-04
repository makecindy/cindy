import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchCardRaw: vi.fn(),
  sendCardRaw: vi.fn(),
  sendFile: vi.fn(),
  sendText: vi.fn(),
  uploadImage: vi.fn(),
  claimPatchableOpener: vi.fn(() => null),
  resolveMediaUrl: vi.fn((): string | null => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../moduleScope.js', () => ({
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  getHost: () => ({
    media: { resolveMediaUrl: mocks.resolveMediaUrl },
    paths: { feishuMediaDir: '/tmp/feishu-media' },
  }),
}));

import { messages } from '../messages.js';
import { FEISHU_CARD_REQUEST_MAX_BYTES, start } from '../streamingText.js';

function markdownContent(card: unknown): string {
  return (card as { body: { elements: Array<{ content: string }> } }).body.elements[0].content;
}

function requestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

describe('feishu streaming text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCardRaw.mockResolvedValue({ messageId: 'om_stream' });
    mocks.patchCardRaw.mockResolvedValue(undefined);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
    });
    mocks.sendText.mockResolvedValue({ messageId: 'om_fallback' });
    mocks.resolveMediaUrl.mockReturnValue(null);
  });

  it('keeps an in-limit final card unchanged', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('正常正文');

    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('正常正文');
  });

  it('truncates an oversized final card within Feishu request limits', async () => {
    const handle = await start('ou_owner');
    const longMarkdown = [
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| 很长的内容 | 更多内容 |',
      '```ts',
      'const answer = "很长的代码块";',
      '```',
    ].join('\n').repeat(500);
    await handle.finalize(longMarkdown);

    const card = mocks.patchCardRaw.mock.calls[0][1];
    expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
    expect(markdownContent(card)).toContain('完整内容仍可在 Cindy 桌面端查看');
  });

  it('uses a bounded plain card when image elements alone exceed the limit', async () => {
    mocks.uploadImage.mockImplementation(async (path: string) => `${path}-${'x'.repeat(128)}`);
    const handle = await start('ou_owner');
    for (let i = 0; i < 200; i++) handle.addExtraImageAbsPath?.(`/tmp/${i}.png`);
    await handle.finalize('正文');

    const card = mocks.patchCardRaw.mock.calls[0][1];
    expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
    expect(markdownContent(card)).toBe(messages.streaming.deliveryFailed);
  });

  it('patches a short notice when the primary final card is rejected', async () => {
    mocks.patchCardRaw.mockRejectedValueOnce(new Error('unsupported card shape'));
    const handle = await start('ou_owner');
    await handle.finalize('正文');

    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
    expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe(
      messages.streaming.deliveryFailed,
    );
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('falls back to plain text when even the short card patch fails', async () => {
    mocks.patchCardRaw.mockRejectedValue(new Error('card patch unavailable'));
    const handle = await start('ou_owner');
    await handle.finalize('正文');

    expect(mocks.sendText).toHaveBeenCalledWith(
      'ou_owner',
      messages.streaming.deliveryFailed,
    );
  });

  it('still finalizes a streaming card when an inline image upload throws', async () => {
    const absPath = '/cindy-media/missing.png';
    mocks.resolveMediaUrl.mockReturnValue(absPath);
    mocks.uploadImage.mockRejectedValue(new Error('file gone'));
    const handle = await start('g/oc_group/omt_topic');

    await expect(
      handle.finalize('终态正文 ![坏](xdt-image://blob/missing.png)'),
    ).resolves.toBeUndefined();

    expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toContain('终态正文');
  });
});
