import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchCardRaw: vi.fn(),
  sendCardRaw: vi.fn(),
  sendFile: vi.fn(),
  sendText: vi.fn(),
  uploadImage: vi.fn(),
  // 默认无 patchable opener — 走新建流式卡路径
  claimPatchableOpener: vi.fn(() => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../moduleScope.js', () => ({
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  getHost: () => ({
    media: { resolveMediaUrl: () => '/tmp/shared.png' },
    paths: { feishuMediaDir: '/tmp' },
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
    mocks.sendText.mockResolvedValue({ messageId: 'om_fallback' });
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
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual([]);
  });

  it('acknowledges only extra images that were actually uploaded', async () => {
    mocks.uploadImage.mockImplementation(async (absPath: string) =>
      absPath.endsWith('ok.png') ? 'image-key' : null,
    );
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/ok.png');
    handle.addExtraImageAbsPath?.('/tmp/failed.png');

    await handle.finalize('正文');

    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual(['/tmp/ok.png']);
    const delivered = handle.getDeliveredExtraImageAbsPaths?.() as string[];
    delivered.push('/tmp/injected.png');
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual(['/tmp/ok.png']);
  });

  it('acknowledges an extra image delivered through the matching body URL', async () => {
    mocks.uploadImage.mockResolvedValue('image-key');
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/shared.png');

    await handle.finalize('![shared](cindy-media://blobs/shared.png)');

    expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual(['/tmp/shared.png']);
  });

  it('does not acknowledge a matching body image removed by card truncation', async () => {
    mocks.uploadImage.mockResolvedValue('image-key');
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/shared.png');

    await handle.finalize(
      `${'超长正文'.repeat(10_000)}\n![shared](cindy-media://blobs/shared.png)`,
    );

    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).not.toContain('shared');
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual([]);
  });

  it('patches a short user-visible notice when the final card shape is rejected', async () => {
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
});
