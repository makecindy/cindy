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
  getAccountEpoch: vi.fn(() => 1),
  getBoundClient: vi.fn(() => ({ pinned: true })),
  runWithPinnedAccount: vi.fn(async (_pin: unknown, fn: () => Promise<void>) => fn()),
  isPinnedAccountCurrent: vi.fn(() => true),
  // 默认无 patchable opener — 走新建流式卡路径
  claimPatchableOpener: vi.fn(() => null),
  resolveMediaUrl: vi.fn((): string | null => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../dualDelivery.js', () => ({
  waitForMirrorConfirmation: vi.fn(async () => true),
  scheduleMirrorOnConfirmation: vi.fn(),
}));
vi.mock('../moduleScope.js', () => ({
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  getHost: () => ({
    media: { resolveMediaUrl: mocks.resolveMediaUrl },
    paths: { feishuMediaDir: '/tmp/feishu-media' },
  }),
}));

import { messages } from '../messages.js';
import { FEISHU_CARD_REQUEST_MAX_BYTES, mirrorFinal, start } from '../streamingText.js';
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
    mocks.resolveMediaUrl.mockReturnValue(null);
    mocks.getAccountEpoch.mockReturnValue(1);
    mocks.getBoundClient.mockReturnValue({ pinned: true });
    mocks.isPinnedAccountCurrent.mockReturnValue(true);
    mocks.runWithPinnedAccount.mockImplementation(async (_pin: unknown, fn: () => Promise<void>) =>
      fn(),
    );
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
      inboundEpoch: 1,
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
      inboundEpoch: 1,
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
      inboundEpoch: 1,
    });
    await handle.finalize('迟到镜像');

    expect(scheduleMirrorOnConfirmation).toHaveBeenCalledWith('c'.repeat(64), expect.any(Function));
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'c'.repeat(32)}-card`,
    );
  });

  it('still mirrors parent-chat text when one extra image upload fails', async () => {
    mocks.uploadImage.mockImplementation(async (absPath: string) => {
      if (absPath.includes('missing')) throw new Error('file gone');
      return 'img_ok';
    });

    await mirrorFinal(
      'oc_group',
      'g'.repeat(64),
      '终态正文',
      ['C:\\cindy-media\\ok.png', 'C:\\cindy-media\\missing.png'],
      [],
      1,
    );

    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe('终态正文');
  });

  it('still mirrors parent-chat text and files when an inline image upload fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-inline-fail-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    mocks.resolveMediaUrl.mockReturnValue('/cindy-media/missing.png');
    mocks.uploadImage.mockRejectedValue(new Error('file gone'));

    await mirrorFinal(
      'oc_group',
      'j'.repeat(64),
      `终态正文 ![坏](xdt-image://blob/missing.png)\n[report.txt](xdt-file://${allowedFile})`,
      [],
      [root],
      1,
    );

    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toContain('终态正文');
    expect(mocks.sendFileToChat).toHaveBeenCalled();
  });

  it('does not re-upload extra images already inlined in the mirrored markdown', async () => {
    const absPath = '/cindy-media/same.png';
    mocks.resolveMediaUrl.mockReturnValue(absPath);
    mocks.uploadImage.mockImplementation(async (p: string) => `img:${p}`);

    await mirrorFinal(
      'oc_group',
      'h'.repeat(64),
      '见 ![图](xdt-image://blob/same.png)',
      [absPath],
      [],
      1,
    );

    expect(mocks.uploadImage.mock.calls.filter(([p]) => p === absPath)).toHaveLength(1);
    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
  });

  it('mirrors file-only replies with fileSentDone instead of emptyReply', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-fileonly-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');

    await mirrorFinal(
      'oc_group',
      'i'.repeat(64),
      `[report.txt](xdt-file://${allowedFile})`,
      [],
      [root],
      1,
    );

    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.fileSentDone(1),
    );
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).not.toBe(
      messages.streaming.emptyReply,
    );
    expect(mocks.sendFileToChat.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendCardToChat.mock.invocationCallOrder[0]!,
    );
  });

  it('does not claim delivery when a file-only mirror path is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-missing-'));
    tempDirs.push(root);
    const missingFile = path.join(root, 'missing.txt');
    mocks.sendFileToChat.mockResolvedValueOnce({ ok: false, reason: 'NOT_FOUND' });

    await mirrorFinal(
      'oc_group',
      'p'.repeat(64),
      `[missing.txt](xdt-file://${missingFile})`,
      [],
      [root],
      1,
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledOnce();
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('does not claim delivery for a file-only mirror outside allowed roots', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    mocks.sendFileToChat.mockResolvedValueOnce({ ok: false, reason: 'NOT_FOUND' });

    await mirrorFinal(
      'oc_group',
      's'.repeat(64),
      `[secret.txt](xdt-file://${outsideFile})`,
      [],
      [allowedRoot],
      1,
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledOnce();
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('reports the actual successful count for a partial file-only mirror', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-partial-'));
    tempDirs.push(root);
    const firstFile = path.join(root, 'first.txt');
    const secondFile = path.join(root, 'second.txt');
    await Promise.all([fs.writeFile(firstFile, 'first'), fs.writeFile(secondFile, 'second')]);
    mocks.sendFileToChat.mockImplementation(async (_chatId: string, absPath: string) =>
      absPath === firstFile
        ? { ok: true, messageId: 'om_first' }
        : { ok: false, reason: 'upload rejected' },
    );

    await mirrorFinal(
      'oc_group',
      'q'.repeat(64),
      `[first.txt](xdt-file://${firstFile})\n[second.txt](xdt-file://${secondFile})`,
      [],
      [root],
      1,
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledTimes(2);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.fileSentDone(1),
    );
  });

  it('does not claim delivery when a streaming file-only mirror upload is rejected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-handle-file-fail-'));
    tempDirs.push(root);
    const file = path.join(root, 'report.txt');
    await fs.writeFile(file, 'report');
    mocks.sendFileToChat.mockResolvedValue({ ok: false, reason: 'upload rejected' });
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'r'.repeat(64),
      allowedFileRoots: [root],
      inboundEpoch: 1,
    });

    await handle.finalize(`[report.txt](xdt-file://${file})`);

    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('drops a deferred parent-chat mirror after Feishu credentials rebind', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    let deferred: (() => void) | undefined;
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      deferred = run;
    });

    await mirrorFinal('oc_group', 'k'.repeat(64), '终态正文', [], [], 1);
    expect(deferred).toBeDefined();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();

    mocks.getAccountEpoch.mockReturnValue(2);
    mocks.getBoundClient.mockReturnValue({ pinned: false });
    deferred?.();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    expect(mocks.uploadImage).not.toHaveBeenCalled();
  });

  it('drops a handle-deferred parent-chat mirror after Feishu credentials rebind', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    let deferred: (() => void) | undefined;
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      deferred = run;
    });
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'l'.repeat(64),
      inboundEpoch: 1,
    });
    await handle.finalize('话题终态');
    expect(deferred).toBeDefined();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();

    mocks.getAccountEpoch.mockReturnValue(2);
    mocks.getBoundClient.mockReturnValue({ pinned: false });
    deferred?.();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('drops a parent-chat mirror when credentials rebind before terminal schedule', async () => {
    mocks.getAccountEpoch.mockReturnValue(2);
    mocks.getBoundClient.mockReturnValue({ pinned: false });

    await mirrorFinal('oc_group', 'm'.repeat(64), '终态正文', [], [], 1);

    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    expect(waitForMirrorConfirmation).not.toHaveBeenCalled();
    expect(scheduleMirrorOnConfirmation).not.toHaveBeenCalled();
  });

  it('drops a handle parent-chat mirror when credentials rebind before finalize', async () => {
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'n'.repeat(64),
      inboundEpoch: 1,
    });
    mocks.getAccountEpoch.mockReturnValue(2);
    mocks.getBoundClient.mockReturnValue({ pinned: false });
    await handle.finalize('话题终态');

    expect(mocks.patchCardRaw).toHaveBeenCalled();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
    expect(scheduleMirrorOnConfirmation).not.toHaveBeenCalled();
  });

  it('does not parent-chat mirror a streaming handle without inbound epoch', async () => {
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'o'.repeat(64),
    });
    await handle.finalize('话题终态');

    expect(mocks.patchCardRaw).toHaveBeenCalled();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
  });

  it('catches late-confirmation one-shot mirror failures instead of unhandledRejection', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    let deferred: (() => void) | undefined;
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      deferred = run;
    });
    mocks.sendCardToChat.mockRejectedValueOnce(new Error('group unavailable'));

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await mirrorFinal('oc_group', 'f'.repeat(64), '早期拒绝终态', [], [], 1);
      expect(deferred).toBeDefined();
      deferred?.();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
      expect(mocks.sendCardToChat).toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not copy parent-chat files outside allowedFileRoots', async () => {
    mocks.sendFileToChat.mockResolvedValueOnce({ ok: false, reason: 'NOT_FOUND' });
    const handle = await start('g/oc_group/omt_topic', undefined, {
      mirrorChatId: 'oc_group',
      mirrorKey: 'd'.repeat(64),
      allowedFileRoots: [path.join(os.tmpdir(), 'cindy-feishu-allowed-missing')],
      inboundEpoch: 1,
    });
    await handle.finalize(`见 [secret](xdt-file://${path.join(os.tmpdir(), 'cindy-secret.txt')})`);

    expect(mocks.sendCardToChat).toHaveBeenCalled();
    expect(mocks.sendFileToChat).toHaveBeenCalledOnce();
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
      inboundEpoch: 1,
    });
    await handle.finalize(`见 [report.txt](xdt-file://${allowedFile})`);

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      allowedFile,
      [root],
      'report.txt',
      `${'e'.repeat(32)}-f0`,
    );
  });
});
