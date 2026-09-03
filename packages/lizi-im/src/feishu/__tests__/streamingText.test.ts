import fsSync from 'node:fs';
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
  attestedRealPath: vi.fn(),
  attestOpenFileWithinDirectory: vi.fn(),
  // 默认无 patchable opener — 走新建流式卡路径
  claimPatchableOpener: vi.fn(() => null),
  resolveMediaUrl: vi.fn((): string | null => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../dualDelivery.js', () => ({
  releaseMirrorConfirmation: vi.fn(),
  waitForMirrorConfirmation: vi.fn(async () => true),
  scheduleMirrorOnConfirmation: vi.fn(() => false),
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
  releaseMirrorConfirmation,
  scheduleMirrorOnConfirmation,
  waitForMirrorConfirmation,
} from '../dualDelivery.js';

function markdownContent(card: unknown): string {
  return (card as { body: { elements: Array<{ content: string }> } }).body.elements[0].content;
}

function requestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

function terminalMirror(
  key: string,
  allowedFileRoots?: string[],
  pinnedFileRoots?: Array<{ dev: string; ino: string; realPath?: string }>,
) {
  return {
    finalReplyMirror: {
      kind: 'parent-chat' as const,
      chatId: 'oc_group',
      idempotencyKey: key,
      accountEpoch: 1,
      ...(allowedFileRoots ? { allowedFileRoots } : {}),
      ...(pinnedFileRoots ? { pinnedFileRoots } : {}),
    },
  };
}

function pinRoot(root: string): Array<{ dev: string; ino: string; realPath: string }> {
  const realPath = fsSync.realpathSync.native(root);
  const st = fsSync.statSync(realPath, { bigint: true });
  return [{ dev: String(st.dev), ino: String(st.ino), realPath }];
}

function ancestorInodes(fileRealPath: string): Array<{ dev: string; ino: string }> {
  const ancestors: Array<{ dev: string; ino: string }> = [];
  const seen = new Set<string>();
  let current = path.dirname(fileRealPath);
  for (;;) {
    try {
      const st = fsSync.statSync(current, { bigint: true });
      if (st.ino === 0n) break;
      const key = `${st.dev}:${st.ino}`;
      if (seen.has(key)) break;
      seen.add(key);
      ancestors.push({ dev: String(st.dev), ino: String(st.ino) });
    } catch {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function fileSourceFromPath(absPath: string): {
  realPath: string;
  dev: string;
  ino: string;
  ancestors: Array<{ dev: string; ino: string }>;
} {
  const realPath = fsSync.realpathSync.native(absPath);
  const st = fsSync.statSync(realPath, { bigint: true });
  return {
    realPath,
    dev: String(st.dev),
    ino: String(st.ino),
    ancestors: ancestorInodes(realPath),
  };
}

function flipPathCase(value: string): string {
  return value.replace(/[a-zA-Z]/g, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
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
    mocks.sendFile.mockImplementation(async (_userId: string, absPath: string) => {
      let uploadedSource: ReturnType<typeof fileSourceFromPath> | undefined;
      try {
        uploadedSource = fileSourceFromPath(absPath);
      } catch {
        /* tests may point at missing files */
      }
      return {
        ok: true,
        messageId: 'om_primary_file',
        reusableMessage: {
          msgType: 'file',
          content: JSON.stringify({ file_key: 'file-key' }),
        },
        ...(uploadedSource ? { uploadedSource } : {}),
      };
    });
    mocks.sendFileToChat.mockResolvedValue({ ok: true, messageId: 'om_mirror_file' });
    mocks.sendText.mockResolvedValue({ messageId: 'om_fallback' });
    mocks.resolveMediaUrl.mockReturnValue(null);
    mocks.getAccountEpoch.mockReturnValue(1);
    mocks.getBoundClient.mockReturnValue({ pinned: true });
    mocks.isPinnedAccountCurrent.mockReturnValue(true);
    mocks.attestedRealPath.mockResolvedValue('');
    mocks.attestOpenFileWithinDirectory.mockResolvedValue(true);
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

  it('patches a short notice and still mirrors when the primary final card is rejected', async () => {
    mocks.patchCardRaw.mockRejectedValueOnce(new Error('unsupported card shape'));
    const handle = await start('ou_owner');
    await handle.finalize('正文', terminalMirror('v'.repeat(64)));

    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
    expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe(
      messages.streaming.deliveryFailed,
    );
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'v'.repeat(32)}-card`,
    );
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
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize('最终正文', terminalMirror('a'.repeat(64)));

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
    const handle = await start('g/oc_group/omt_topic');

    await expect(
      handle.finalize('最终正文', terminalMirror('b'.repeat(64))),
    ).resolves.toBeUndefined();
    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('defers parent-chat mirroring until late confirmation', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      run();
      return true;
    });
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize('迟到镜像', terminalMirror('c'.repeat(64)));

    expect(scheduleMirrorOnConfirmation).toHaveBeenCalledWith('c'.repeat(64), expect.any(Function));
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'c'.repeat(32)}-card`,
    );
  });

  it('mirrors immediately when inbound pairing was already confirmed', async () => {
    await mirrorFinal('oc_group', 'p'.repeat(64), '终态正文', [], [], 1, true);

    expect(waitForMirrorConfirmation).not.toHaveBeenCalled();
    expect(scheduleMirrorOnConfirmation).not.toHaveBeenCalled();
    expect(mocks.sendCardToChat).toHaveBeenCalledWith(
      'oc_group',
      expect.anything(),
      `${'p'.repeat(32)}-card`,
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
      ['/allowed'],
      1,
    );

    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe('终态正文');
  });

  it('still mirrors parent-chat text without reopening files when an inline image upload fails', async () => {
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
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('still finalizes and mirrors a streaming card when an inline image upload throws', async () => {
    const absPath = '/cindy-media/missing.png';
    mocks.resolveMediaUrl.mockReturnValue(absPath);
    mocks.uploadImage.mockRejectedValue(new Error('file gone'));
    const handle = await start('g/oc_group/omt_topic');

    await expect(
      handle.finalize(
        '终态正文 ![坏](xdt-image://blob/missing.png)',
        terminalMirror('w'.repeat(64), ['/cindy-media']),
      ),
    ).resolves.toBeUndefined();

    expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toContain('终态正文');
    expect(releaseMirrorConfirmation).toHaveBeenCalledWith('w'.repeat(64));
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
      ['/allowed'],
      1,
    );

    expect(mocks.uploadImage.mock.calls.filter(([p]) => p === absPath)).toHaveLength(1);
    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
  });

  it('does not resolve local images when allowedFileRoots is empty', async () => {
    mocks.resolveMediaUrl.mockReturnValue('/cindy-media/secret.png');
    mocks.uploadImage.mockResolvedValue('img_secret');

    await mirrorFinal(
      'oc_group',
      't'.repeat(64),
      '正文 ![图](xdt-image://blob/secret.png)',
      ['/cindy-media/extra.png'],
      [],
      1,
    );

    expect(mocks.resolveMediaUrl).not.toHaveBeenCalled();
    expect(mocks.uploadImage).not.toHaveBeenCalled();
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe('正文');
  });

  it('does not claim delivery for an image-only mirror with empty allowedFileRoots', async () => {
    mocks.resolveMediaUrl.mockReturnValue('/cindy-media/secret.png');
    mocks.uploadImage.mockResolvedValue('img_secret');

    await mirrorFinal(
      'oc_group',
      'u'.repeat(64),
      '![图](xdt-image://blob/secret.png)',
      [],
      [],
      1,
    );

    expect(mocks.resolveMediaUrl).not.toHaveBeenCalled();
    expect(mocks.uploadImage).not.toHaveBeenCalled();
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('does not copy local images on the streaming-handle parent-chat mirror when allowedFileRoots is empty', async () => {
    mocks.resolveMediaUrl.mockReturnValue('/cindy-media/secret.png');
    mocks.uploadImage.mockResolvedValue('img_secret');
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      '正文 ![图](xdt-image://blob/secret.png)',
      terminalMirror('t'.repeat(64), []),
    );

    expect(mocks.patchCardRaw).toHaveBeenCalled();
    expect(mocks.sendCardToChat).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe('正文');
  });

  it('fits an oversized SSH streaming mirror card within Feishu request limits', async () => {
    const handle = await start('g/oc_group/omt_topic');
    const longMarkdown = [
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| 很长的内容 | 更多内容 |',
      '```ts',
      'const answer = "很长的代码块";',
      '```',
    ].join('\n').repeat(500);

    await handle.finalize(longMarkdown, terminalMirror('z'.repeat(64), []));

    const mirrored = mocks.sendCardToChat.mock.calls[0][1];
    expect(requestBytes(mirrored)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
    expect(markdownContent(mirrored)).toContain('完整内容仍可在 Cindy 桌面端查看');
  });

  it('fails closed for one-shot file-only replies without a primary upload key', async () => {
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
      messages.streaming.deliveryFailed,
    );
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).not.toBe(
      messages.streaming.emptyReply,
    );
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not claim delivery when a file-only mirror path is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-missing-'));
    tempDirs.push(root);
    const missingFile = path.join(root, 'missing.txt');
    await mirrorFinal(
      'oc_group',
      'p'.repeat(64),
      `[missing.txt](xdt-file://${missingFile})`,
      [],
      [root],
      1,
    );

    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
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
    await mirrorFinal(
      'oc_group',
      's'.repeat(64),
      `[secret.txt](xdt-file://${outsideFile})`,
      [],
      [allowedRoot],
      1,
    );

    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('preserves source indexes when only some primary uploads can be mirrored', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-partial-'));
    tempDirs.push(root);
    const firstFile = path.join(root, 'first.txt');
    const secondFile = path.join(root, 'second.txt');
    await Promise.all([fs.writeFile(firstFile, 'first'), fs.writeFile(secondFile, 'second')]);
    mocks.sendFile.mockImplementation(async (_userId: string, absPath: string) =>
      absPath === firstFile
        ? { ok: false, reason: 'UPLOAD_FAIL' }
        : {
            ok: true,
            messageId: 'om_second',
            reusableMessage: {
              msgType: 'file',
              content: JSON.stringify({ file_key: 'second-key' }),
            },
            uploadedSource: fileSourceFromPath(secondFile),
          },
    );
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `[first.txt](xdt-file://${firstFile})\n[second.txt](xdt-file://${secondFile})`,
      terminalMirror('q'.repeat(64), [root], pinRoot(root)),
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledOnce();
    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'second-key' }),
      },
      `${'q'.repeat(32)}-f1`,
    );
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
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `[report.txt](xdt-file://${file})`,
      terminalMirror('r'.repeat(64), [root], pinRoot(root)),
    );

    expect(markdownContent(mocks.sendCardToChat.mock.calls[0][1])).toBe(
      messages.streaming.deliveryFailed,
    );
  });

  it('drops a deferred parent-chat mirror after Feishu credentials rebind', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    let deferred: (() => void) | undefined;
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      deferred = run;
      return true;
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
      return true;
    });
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize('话题终态', terminalMirror('l'.repeat(64)));
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
    const handle = await start('g/oc_group/omt_topic');
    mocks.getAccountEpoch.mockReturnValue(2);
    mocks.getBoundClient.mockReturnValue({ pinned: false });
    await handle.finalize('话题终态', terminalMirror('n'.repeat(64)));

    expect(mocks.patchCardRaw).toHaveBeenCalled();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
    expect(scheduleMirrorOnConfirmation).not.toHaveBeenCalled();
  });

  it('does not parent-chat mirror a pre-interaction finalize without a terminal mirror', async () => {
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize('话题终态');

    expect(mocks.patchCardRaw).toHaveBeenCalled();
    expect(mocks.sendCardToChat).not.toHaveBeenCalled();
  });

  it('catches late-confirmation one-shot mirror failures instead of unhandledRejection', async () => {
    vi.mocked(waitForMirrorConfirmation).mockResolvedValueOnce(false);
    let deferred: (() => void) | undefined;
    vi.mocked(scheduleMirrorOnConfirmation).mockImplementation((_key, run) => {
      deferred = run;
      return true;
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
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize(
      `见 [secret](xdt-file://${path.join(os.tmpdir(), 'cindy-secret.txt')})`,
      terminalMirror('d'.repeat(64), [
        path.join(os.tmpdir(), 'cindy-feishu-allowed-missing'),
      ]),
    );

    expect(mocks.sendCardToChat).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not copy parent-chat files after the allowed root path is replaced with an outside symlink', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-pin-allowed-'));
    const secretRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-pin-secret-'));
    tempDirs.push(secretRoot);
    await fs.writeFile(path.join(allowedRoot, 'report.txt'), 'ok');
    await fs.writeFile(path.join(secretRoot, 'secret.txt'), 'secret');
    const pinnedFileRoots = pinRoot(allowedRoot);
    await fs.rm(allowedRoot, { recursive: true, force: true });
    try {
      await fs.symlink(secretRoot, allowedRoot);
    } catch {
      return;
    }
    tempDirs.push(allowedRoot);
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `见 [secret](xdt-file://${path.join(allowedRoot, 'secret.txt')})`,
      terminalMirror('w'.repeat(64), [allowedRoot], pinnedFileRoots),
    );

    expect(mocks.sendFile).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not copy a parent-chat file whose real path escapes allowedFileRoots via symlink', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-symlink-allowed-'));
    const secretRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-symlink-secret-'));
    tempDirs.push(allowedRoot, secretRoot);
    const secretFile = path.join(secretRoot, 'secret.txt');
    await fs.writeFile(secretFile, 'secret');
    const link = path.join(allowedRoot, 'link.txt');
    try {
      await fs.symlink(secretFile, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `见 [secret](xdt-file://${link})`,
      terminalMirror('y'.repeat(64), [allowedRoot]),
    );

    expect(mocks.sendFile).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not reuse a file_key when stuffed ancestors claim the pinned root', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-stuffed-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-stuffed-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const secret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secret, 'secret');
    await fs.writeFile(path.join(allowedRoot, 'report.txt'), 'ok');
    const secretReal = fsSync.realpathSync.native(secret);
    const secretStat = fsSync.statSync(secretReal, { bigint: true });
    const pinned = pinRoot(allowedRoot);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: secretReal,
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
        ancestors: pinned,
      },
    });
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `见 [secret](xdt-file://${secret})`,
      terminalMirror('s'.repeat(64), [allowedRoot], pinned),
    );

    expect(mocks.sendFile).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not reuse a file_key when a parent is swapped onto the pinned root after upload', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-swap-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-swap-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    const secret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secret, 'secret');
    await fs.writeFile(path.join(allowedRoot, 'decoy.txt'), 'decoy');
    const secretReal = fsSync.realpathSync.native(secret);
    const secretStat = fsSync.statSync(secretReal, { bigint: true });
    const pinned = pinRoot(allowedRoot);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: secretReal,
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
        ancestors: ancestorInodes(secretReal),
      },
    });

    const realStat = fsSync.statSync.bind(fsSync);
    const spy = vi.spyOn(fsSync, 'statSync').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      const target = typeof file === 'string' ? file : String(file);
      if (target === secretReal) {
        const leaf = realStat(file as Parameters<typeof realStat>[0], options as Parameters<typeof realStat>[1]);
        try {
          fsSync.rmSync(outsideRoot, { recursive: true, force: true });
          fsSync.symlinkSync(allowedRoot, outsideRoot);
        } catch {
          /* already swapped */
        }
        return leaf;
      }
      return realStat(file as Parameters<typeof realStat>[0], options as Parameters<typeof realStat>[1]);
    }) as typeof fsSync.statSync);

    try {
      const handle = await start('g/oc_group/omt_topic');
      await handle.finalize(
        `见 [secret](xdt-file://${secret})`,
        terminalMirror('v'.repeat(64), [allowedRoot], pinned),
      );
      expect(mocks.sendFile).toHaveBeenCalled();
      expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('binds the uploaded leaf and pinned root through one descriptor-relative object chain', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-chain-race-'));
    tempDirs.push(base);
    const allowedRoot = path.join(base, 'allowed');
    const outsideRoot = path.join(base, 'outside');
    const parkedAllowed = path.join(base, 'parked-allowed');
    await Promise.all([fs.mkdir(allowedRoot), fs.mkdir(outsideRoot)]);
    await Promise.all([
      fs.writeFile(path.join(allowedRoot, 'secret.txt'), 'decoy'),
      fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'secret'),
    ]);
    const pinned = pinRoot(allowedRoot);

    await fs.rename(allowedRoot, parkedAllowed);
    await fs.rename(outsideRoot, allowedRoot);
    const apparentSource = path.join(allowedRoot, 'secret.txt');
    const uploadedSource = fileSourceFromPath(apparentSource);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource,
    });
    const actualOutbound = await vi.importActual<typeof import('../outbound.js')>('../outbound.js');
    mocks.attestOpenFileWithinDirectory.mockImplementation(
      actualOutbound.attestOpenFileWithinDirectory,
    );

    const realOpen = fsSync.openSync.bind(fsSync);
    let swapAttempted = false;
    let swapCompleted = false;
    const spyOpen = vi.spyOn(fsSync, 'openSync').mockImplementation(((
      file: unknown,
      flags: unknown,
      mode?: unknown,
    ) => {
      const fd = realOpen(
        file as Parameters<typeof fsSync.openSync>[0],
        flags as Parameters<typeof fsSync.openSync>[1],
        mode as Parameters<typeof fsSync.openSync>[2],
      );
      if (!swapAttempted && String(file) === uploadedSource.realPath) {
        swapAttempted = true;
        try {
          fsSync.renameSync(allowedRoot, outsideRoot);
          fsSync.renameSync(parkedAllowed, allowedRoot);
          swapCompleted = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          // Windows locks the parent while the leaf handle is open. That is
          // already fail-closed; the direct helper test covers mismatched live
          // root/source handles on Windows.
        }
      }
      return fd;
    }) as typeof fsSync.openSync);

    try {
      const handle = await start('g/oc_group/omt_topic');
      await handle.finalize(
        `见 [secret](xdt-file://${apparentSource})`,
        terminalMirror('o'.repeat(64), [allowedRoot], pinned),
      );
      expect(swapAttempted).toBe(true);
      expect(mocks.attestOpenFileWithinDirectory).toHaveBeenCalledTimes(swapCompleted ? 1 : 0);
      expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    } finally {
      spyOpen.mockRestore();
    }
  });

  it('does not reuse a file_key when live root realpath and inode come from different lookups', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-root-bind-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-root-bind-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    await fs.writeFile(path.join(allowedRoot, 'report.txt'), 'ok');
    const secret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secret, 'secret');
    const secretReal = fsSync.realpathSync.native(secret);
    const secretStat = fsSync.statSync(secretReal, { bigint: true });
    const pinned = pinRoot(allowedRoot);
    const outsideReal = fsSync.realpathSync.native(outsideRoot);
    const allowedReal = fsSync.realpathSync.native(allowedRoot);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: secretReal,
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
        ancestors: pinned,
      },
    });

    const realRealpath = fsSync.realpathSync.native.bind(fsSync.realpathSync);
    const realStat = fsSync.statSync.bind(fsSync);
    const pinStat = fsSync.statSync(allowedReal, { bigint: true });
    const rootNames = new Set([allowedRoot, allowedReal]);
    const outsideNames = new Set([outsideRoot, outsideReal]);
    const spyRealpath = vi.spyOn(fsSync.realpathSync, 'native').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      const target = String(file);
      if (rootNames.has(target)) return outsideReal;
      return realRealpath(
        file as Parameters<typeof realRealpath>[0],
        options as Parameters<typeof realRealpath>[1],
      );
    }) as typeof fsSync.realpathSync.native);
    const spyStat = vi.spyOn(fsSync, 'statSync').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      const target = String(file);
      if (outsideNames.has(target)) return pinStat;
      return realStat(
        file as Parameters<typeof realStat>[0],
        options as Parameters<typeof realStat>[1],
      );
    }) as typeof fsSync.statSync);

    try {
      const handle = await start('g/oc_group/omt_topic');
      await handle.finalize(
        `见 [secret](xdt-file://${secret})`,
        terminalMirror('b'.repeat(64), [allowedRoot], pinned),
      );
      expect(mocks.sendFile).toHaveBeenCalled();
      expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    } finally {
      spyRealpath.mockRestore();
      spyStat.mockRestore();
    }
  });

  it('does not reuse a file_key when the attested path no longer names the uploaded inode', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-leaf-allowed-'));
    const secretRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-leaf-secret-'));
    tempDirs.push(allowedRoot, secretRoot);
    const decoy = path.join(allowedRoot, 'report.txt');
    const secret = path.join(secretRoot, 'secret.txt');
    await Promise.all([fs.writeFile(decoy, 'decoy'), fs.writeFile(secret, 'secret')]);
    const secretStat = fsSync.statSync(secret, { bigint: true });
    const decoyReal = fsSync.realpathSync.native(decoy);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: decoyReal,
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
        ancestors: ancestorInodes(fsSync.realpathSync.native(secret)),
      },
    });
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `见 [report.txt](xdt-file://${decoy})`,
      terminalMirror('x'.repeat(64), [allowedRoot]),
    );

    expect(mocks.sendFile).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not collapse distinct 64-bit inode identities through number precision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-bigint-inode-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    const realPath = fsSync.realpathSync.native(allowedFile);
    const actual = fsSync.statSync(realPath, { bigint: true });
    const uploadedIno = 2n ** 60n;
    const differentIno = uploadedIno + 1n;
    expect(Number(uploadedIno)).toBe(Number(differentIno));
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath,
        dev: String(actual.dev),
        ino: String(uploadedIno),
        ancestors: [],
      },
    });

    const realStat = fsSync.statSync.bind(fsSync);
    const spy = vi.spyOn(fsSync, 'statSync').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      if (String(file) === realPath && (options as { bigint?: boolean } | undefined)?.bigint) {
        return { dev: actual.dev, ino: differentIno } as never;
      }
      return realStat(
        file as Parameters<typeof realStat>[0],
        options as Parameters<typeof realStat>[1],
      );
    }) as typeof fsSync.statSync);

    try {
      const handle = await start('g/oc_group/omt_topic');
      await handle.finalize(
        `瑙?[report.txt](xdt-file://${allowedFile})`,
        terminalMirror('q'.repeat(64), [root], pinRoot(root)),
      );
      expect(mocks.sendFileToChat).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('does not reuse a file_key when uploaded inode identity is zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-zero-ino-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    const realPath = fsSync.realpathSync.native(allowedFile);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath,
        dev: '1',
        ino: '0',
        ancestors: ancestorInodes(realPath),
      },
    });
    const handle = await start('g/oc_group/omt_topic');

    await handle.finalize(
      `见 [report.txt](xdt-file://${allowedFile})`,
      terminalMirror('w'.repeat(64), [root], [{ dev: '1', ino: '0' }]),
    );

    expect(mocks.sendFile).toHaveBeenCalled();
    expect(mocks.sendFileToChat).not.toHaveBeenCalled();
  });

  it('does not probe a mutable case alias during terminal containment', async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-cs-allowed-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-cs-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);
    await fs.writeFile(path.join(allowedRoot, 'report.txt'), 'ok');
    const secret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(secret, 'secret');
    const rootReal = fsSync.realpathSync.native(allowedRoot);
    const flippedRoot = flipPathCase(rootReal);
    if (flippedRoot === rootReal) return;
    const collidingPath = path.join(flippedRoot, 'outside.txt');
    const secretStat = fsSync.statSync(secret, { bigint: true });
    const pinned = pinRoot(allowedRoot);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      uploadedSource: {
        realPath: collidingPath,
        dev: String(secretStat.dev),
        ino: String(secretStat.ino),
        ancestors: pinned,
      },
    });

    const realRealpath = fsSync.realpathSync.native.bind(fsSync.realpathSync);
    const realStat = fsSync.statSync.bind(fsSync);
    const spyRealpath = vi.spyOn(fsSync.realpathSync, 'native').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      if (String(file) === collidingPath) return collidingPath;
      return realRealpath(
        file as Parameters<typeof realRealpath>[0],
        options as Parameters<typeof realRealpath>[1],
      );
    }) as typeof fsSync.realpathSync.native);
    const spyStat = vi.spyOn(fsSync, 'statSync').mockImplementation(((
      file: unknown,
      options?: unknown,
    ) => {
      const target = String(file);
      if (target === collidingPath) return secretStat;
      return realStat(
        file as Parameters<typeof realStat>[0],
        options as Parameters<typeof realStat>[1],
      );
    }) as typeof fsSync.statSync);

    try {
      const handle = await start('g/oc_group/omt_topic');
      await handle.finalize(
        `见 [secret](xdt-file://${collidingPath})`,
        terminalMirror('c'.repeat(64), [allowedRoot], pinned),
      );
      expect(mocks.sendFile).toHaveBeenCalled();
      expect(mocks.sendFileToChat).not.toHaveBeenCalled();
      expect(spyStat.mock.calls.some(([file]) => String(file) === flippedRoot)).toBe(false);
    } finally {
      spyRealpath.mockRestore();
      spyStat.mockRestore();
    }
  });

  it('copies parent-chat files when the allowed root uses host filesystem case', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-case-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'Report.txt');
    await fs.writeFile(allowedFile, 'report');
    const flipped = flipPathCase(root);
    if (flipped === root) return;
    try {
      await fs.access(flipped);
    } catch {
      return;
    }
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize(
      `见 [Report.txt](xdt-file://${allowedFile})`,
      terminalMirror('z'.repeat(64), [flipped], pinRoot(flipped)),
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      `${'z'.repeat(32)}-f0`,
    );
  });

  it('copies parent-chat files that stay inside allowedFileRoots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-allowed-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    const actualOutbound = await vi.importActual<typeof import('../outbound.js')>('../outbound.js');
    mocks.attestedRealPath.mockImplementation(actualOutbound.attestedRealPath);
    mocks.attestOpenFileWithinDirectory.mockImplementation(
      actualOutbound.attestOpenFileWithinDirectory,
    );
    const identityOnlyPin = pinRoot(root).map(({ dev, ino }) => ({ dev, ino }));
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize(
      `见 [report.txt](xdt-file://${allowedFile})`,
      terminalMirror('e'.repeat(64), [root], identityOnlyPin),
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      `${'e'.repeat(32)}-f0`,
    );
  });

  it('copies parent-chat files when the mirror is supplied only at terminal finalize', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-armed-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    await fs.writeFile(allowedFile, 'report');
    const handle = await start('g/oc_group/omt_topic');
    await handle.finalize(
      `见 [report.txt](xdt-file://${allowedFile})`,
      terminalMirror('r'.repeat(64), [root], pinRoot(root)),
    );

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      'oc_group',
      {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      `${'r'.repeat(32)}-f0`,
    );
  });
});
