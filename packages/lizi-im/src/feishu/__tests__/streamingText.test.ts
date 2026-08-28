import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchCardRaw: vi.fn(),
  sendCardRaw: vi.fn(),
  sendFile: vi.fn(),
  sendFileToChat: vi.fn(),
  sendCardToChat: vi.fn(),
  sendText: vi.fn(),
  uploadImage: vi.fn(),
  // 默认无 patchable opener — 走新建流式卡路径
  claimPatchableOpener: vi.fn(() => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../dualDelivery.js', () => ({
  waitForMirrorConfirmation: vi.fn(async () => true),
  scheduleMirrorOnConfirmation: vi.fn(),
}));
vi.mock('../moduleScope.js', () => ({
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { messages } from '../messages.js';
import { FEISHU_CARD_REQUEST_MAX_BYTES, start } from '../streamingText.js';
import {
  scheduleMirrorOnConfirmation,
  waitForMirrorConfirmation,
} from '../dualDelivery.js';

function markdownContent(card: unknown): string {
  return (card as { body: { elements: Array<{ content: string }> } }).body.elements[0].content;
}

function requestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('feishu streaming text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCardRaw.mockResolvedValue({ messageId: 'om_stream' });
    mocks.patchCardRaw.mockResolvedValue(undefined);
    mocks.sendCardToChat.mockResolvedValue({ messageId: 'om_mirror' });
    mocks.sendFileToChat.mockResolvedValue({ ok: true, messageId: 'om_mirror_file' });
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

  it('mirrors one finalized card to the parent group with a stable uuid', async () => {
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'a'.repeat(64),
    });
    await handle.finalize('最终正文');

    expect(mocks.patchCardRaw).toHaveBeenCalledWith('om_stream', expect.anything());
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'a'.repeat(32)}-card`,
    );
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe('最终正文');
  });

  it('keeps primary finalize successful when parent-group mirroring fails', async () => {
    mocks.sendCardToChat.mockRejectedValueOnce(new Error('group rate limited'));
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'b'.repeat(64),
    });

    await expect(handle.finalize('最终正文')).resolves.toBeUndefined();
    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('defers parent-chat mirroring until late confirmation', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      run();
    });
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'c'.repeat(64),
    });
    await handle.finalize('迟到镜像');

    expect(scheduleMirrorOnConfirmation).toHaveBeenCalledWith('c'.repeat(64), expect.any(Function));
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'c'.repeat(32)}-card`,
    );
  });

  it('does not copy parent-chat files outside allowedFileRoots', async () => {
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'd'.repeat(64),
      allowedFileRoots: [path.join(os.tmpdir(), 'cindy-feishu-allowed-missing')],
    });
    await handle.finalize(`见 [secret](xdt-file://${path.join(os.tmpdir(), 'cindy-secret.txt')})`);

    expect(mocks.sendCardToChat).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('copies parent-chat files that stay inside allowedFileRoots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-allowed-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'e'.repeat(64),
      allowedFileRoots: [root],
    });
    await handle.finalize(`见 [report.txt](xdt-file://${allowedFile})`);

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      await fs.realpath(allowedFile),
      'report.txt',
      `${'e'.repeat(32)}-f0`,
    );
  });
});
