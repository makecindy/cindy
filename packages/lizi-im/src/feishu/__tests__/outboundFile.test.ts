import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openAllowedOutboundFile: vi.fn(),
  createFile: vi.fn(),
  createImage: vi.fn(),
  createMessage: vi.fn(async () => ({ data: { message_id: 'om_sent' } })),
}));

vi.mock('../../allowedFiles.js', () => ({
  openAllowedOutboundFile: mocks.openAllowedOutboundFile,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = {
      v1: {
        message: { create: mocks.createMessage },
        messageReaction: { create: vi.fn(), delete: vi.fn() },
        image: { create: mocks.createImage },
      },
      file: { create: mocks.createFile },
    };
  },
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
}));

vi.mock('../ownerGuard.js', () => ({
  firstAllowed: vi.fn(() => 'ou_owner'),
  check: vi.fn(() => true),
}));

vi.mock('../moduleScope.js', () => ({
  getLog: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { OpenedAllowedOutboundFile } from '../../allowedFiles.js';
import * as outbound from '../outbound.js';

const tempDirs: string[] = [];

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function openedFixture(name: string, content: string): Promise<OpenedAllowedOutboundFile> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-open-file-'));
  tempDirs.push(root);
  const canonicalPath = path.join(root, name);
  await fs.writeFile(canonicalPath, content);
  return {
    canonicalPath,
    handle: await fs.open(canonicalPath, 'r'),
    size: Buffer.byteLength(content),
  };
}

describe('Feishu parent-chat file upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbound.unbindClient();
    outbound.bindClient({ appId: 'cli_file_test', appSecret: 'secret', service: 'feishu' });
    mocks.createFile.mockImplementation(async ({ data }: { data: { file: NodeJS.ReadableStream } }) => {
      await readStream(data.file);
      return { file_key: 'file-key' };
    });
    mocks.createImage.mockImplementation(
      async ({ data }: { data: { image: NodeJS.ReadableStream } }) => {
        await readStream(data.image);
        return { image_key: 'image-key' };
      },
    );
  });

  afterEach(async () => {
    outbound.unbindClient();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('uploads a regular file from the validated handle and closes it', async () => {
    const opened = await openedFixture('report.txt', 'trusted report');
    const close = vi.spyOn(opened.handle, 'close');
    mocks.openAllowedOutboundFile.mockResolvedValue(opened);

    await expect(
      outbound.sendFileToChat('oc_group', opened.canonicalPath, ['/allowed'], 'report.txt', 'u1'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.openAllowedOutboundFile).toHaveBeenCalledWith(opened.canonicalPath, ['/allowed']);
    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the same validated handle for the image fast-path', async () => {
    const opened = await openedFixture('preview.png', 'trusted image');
    const close = vi.spyOn(opened.handle, 'close');
    mocks.openAllowedOutboundFile.mockResolvedValue(opened);

    await expect(
      outbound.sendFileToChat('oc_group', opened.canonicalPath, ['/allowed'], undefined, 'u2'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.createImage).toHaveBeenCalledOnce();
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the validated handle when upload fails', async () => {
    const opened = await openedFixture('report.txt', 'trusted report');
    const close = vi.spyOn(opened.handle, 'close');
    mocks.openAllowedOutboundFile.mockResolvedValue(opened);
    mocks.createFile.mockRejectedValueOnce(new Error('upload failed'));

    await expect(
      outbound.sendFileToChat('oc_group', opened.canonicalPath, ['/allowed'], undefined, 'u3'),
    ).resolves.toEqual({ ok: false, reason: 'UPLOAD_FAIL' });

    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed before contacting Feishu when the path is not allowed', async () => {
    mocks.openAllowedOutboundFile.mockResolvedValue(null);

    await expect(
      outbound.sendFileToChat('oc_group', 'C:\\outside\\secret.txt', [], undefined, 'u4'),
    ).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });

    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });
});
