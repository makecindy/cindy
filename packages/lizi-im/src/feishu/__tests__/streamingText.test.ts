import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchCardRaw: vi.fn(),
  getAccountEpoch: vi.fn(() => 1),
  rearmAnchorToTrigger: vi.fn(),
  recallMessage: vi.fn(),
  sendCardRaw: vi.fn(),
  sendFile: vi.fn(),
  sendText: vi.fn(),
  uploadImage: vi.fn(),
  claimPatchableOpener: vi.fn((): string | null => null),
  resolveMediaUrl: vi.fn((): string | null => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  getHost: () => ({
    media: { resolveMediaUrl: mocks.resolveMediaUrl },
    paths: { feishuMediaDir: '/tmp/feishu-media' },
  }),
}));

import { messages } from '../messages.js';
import { FEISHU_CARD_REQUEST_MAX_BYTES, start, patchMarkdown } from '../streamingText.js';

function markdownContent(card: unknown): string {
  return (card as { body: { elements: Array<{ content: string }> } }).body.elements[0].content;
}

function requestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

describe('feishu streaming text', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAccountEpoch.mockReturnValue(1);
    mocks.sendCardRaw.mockResolvedValueOnce({ messageId: 'om_stream' }).mockResolvedValue({ messageId: 'om_final' });
    mocks.patchCardRaw.mockResolvedValue(undefined);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
    });
    mocks.sendText.mockResolvedValue({ messageId: 'om_fallback' });
    mocks.resolveMediaUrl.mockReturnValue(null);
  });

  it('updates the original card with the final answer without sending or recalling a message', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('正常正文');

    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('正常正文');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(handle.messageId).toBe('om_stream');
  });

  it.each(['', ' \n '])('recalls an empty final %j without a placeholder', async (text) => {
    const handle = await start('ou_owner');
    await handle.finalize(text);
    await handle.finalize(text);
    expect(mocks.recallMessage).toHaveBeenCalledExactlyOnceWith('om_stream');
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('recalls an existing interaction/opener card when its final is empty', async () => {
    await patchMarkdown('om_opener', ' \n ');
    expect(mocks.recallMessage).toHaveBeenCalledWith('om_opener');
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
  });

  it('keeps attachment-only finals', async () => {
    mocks.uploadImage.mockResolvedValue('image_key');
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/image.png');
    await handle.finalize('');
    expect(mocks.uploadImage).toHaveBeenCalledWith('/tmp/image.png');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    const card = mocks.patchCardRaw.mock.calls[0][1];
    expect(card.body.elements).toEqual([expect.objectContaining({ tag: 'img', img_key: 'image_key' })]);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
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

  // Regression: an oversized intermediate frame used to bypass the final-card byte cap.
  // Production entry: append/timer -> patchCardRaw; existing coverage only checked finalize.
  // Minimal failing input: one multi-byte Markdown frame; unit tier with fake timers/mocks.
  it('truncates an oversized intermediate card within Feishu request limits', async () => {
    vi.useFakeTimers();
    try {
      const handle = await start('ou_owner');
      const longMarkdown = '| 列一 | 列二 |\n| --- | --- |\n| 很长的内容 | 更多内容 |'.repeat(1000);
      handle.append(longMarkdown);
      await vi.advanceTimersByTimeAsync(1500);

      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
      const card = mocks.patchCardRaw.mock.calls[0][1];
      expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
      expect(markdownContent(card)).toContain('完整内容仍可在 Cindy 桌面端查看');
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('delivers a file separately and updates the original card with its receipt', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('[report.txt](xdt-file:///tmp/report.txt)');
    expect(mocks.sendFile).toHaveBeenCalledExactlyOnceWith('ou_owner', '/tmp/report.txt', 'report.txt', undefined);
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe(messages.streaming.fileSentDone(1));
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
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

  // Regression for PR #6817: start/finalize must edit the existing message.
  // Unit tier; the previous tests asserted fresh delivery and missed recall notices.
  it('sends the full final only as a fallback when updating the original card fails', async () => {
    const handle = await start('ou_owner', 'working', { threadTs: 'om_root' });
    mocks.patchCardRaw.mockRejectedValueOnce(new Error('patch unavailable'));
    await handle.finalize('正文');
    await handle.finalize('正文');
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(2);
    expect(markdownContent(mocks.sendCardRaw.mock.calls[1][1])).toBe('正文');
    expect(mocks.sendCardRaw.mock.calls[1][2]).toEqual({ threadTs: 'om_root', advanceRound: false });
    expect(handle.messageId).toBe('om_final');
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('edits progress and then the final on the same card, only once', async () => {
    vi.useFakeTimers();
    try {
      const handle = await start('ou_owner', 'working', { threadTs: 'om_root' });
      handle.append('draft');
      await vi.advanceTimersByTimeAsync(1500);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('draft');
      handle.replace('pending draft');
      await handle.finalize('answer');
      await handle.finalize('answer');
      await vi.advanceTimersByTimeAsync(1500);
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
      expect(mocks.patchCardRaw.mock.calls.map(([id]) => id)).toEqual(['om_stream', 'om_stream']);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe('answer');
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
      expect(mocks.recallMessage).not.toHaveBeenCalled();
      expect(handle.messageId).toBe('om_stream');
    } finally { vi.useRealTimers(); }
  });

  it('waits for an in-flight progress edit before writing the final answer', async () => {
    vi.useFakeTimers();
    try {
      let finishProgress!: () => void;
      mocks.patchCardRaw.mockImplementationOnce(() => new Promise<void>((resolve) => { finishProgress = resolve; }));
      const handle = await start('ou_owner');
      handle.append('draft');
      await vi.advanceTimersByTimeAsync(1500);
      const finished = handle.finalize('answer');
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
      finishProgress();
      await finished;
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe('answer');
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
      expect(mocks.recallMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('updates a claimed opener without recalling it or resetting its reply anchor', async () => {
    mocks.claimPatchableOpener.mockReturnValueOnce('om_opener');
    const handle = await start('g/oc_chat/omt_topic');
    await handle.finalize('answer');
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_opener', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('answer');
    expect(mocks.sendCardRaw).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(mocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(handle.messageId).toBe('om_opener');
  });

  it('does not send a fallback through a replacement account after a failed final edit', async () => {
    const handle = await start('ou_owner');
    mocks.patchCardRaw.mockImplementationOnce(async () => {
      mocks.getAccountEpoch.mockReturnValue(2);
      throw new Error('old account disconnected');
    });
    await handle.finalize('answer');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  it('does not send or recall through a replacement account after image upload', async () => {
    mocks.uploadImage.mockImplementation(async () => {
      mocks.getAccountEpoch.mockReturnValue(2);
      return 'img_old_account';
    });
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/image.png');
    await handle.finalize('answer');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  it('sends a delivery notice if both final editing and fallback delivery fail', async () => {
    mocks.patchCardRaw.mockRejectedValue(new Error('card patch unavailable'));
    const handle = await start('ou_owner');
    mocks.sendCardRaw.mockRejectedValueOnce(new Error('send unavailable'));
    await handle.finalize('正文');

    expect(mocks.sendText).toHaveBeenCalledWith(
      'ou_owner',
      messages.streaming.deliveryFailed,
      undefined,
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
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toContain('终态正文');
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });
});
