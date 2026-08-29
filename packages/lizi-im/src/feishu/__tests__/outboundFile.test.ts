import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFile: vi.fn(),
  createImage: vi.fn(),
  createMessage: vi.fn(async () => ({ data: { message_id: 'om_sent' } })),
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

import * as outbound from '../outbound.js';

const tempDirs: string[] = [];

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fileFixture(name: string, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-file-'));
  tempDirs.push(root);
  const absPath = path.join(root, name);
  await fs.writeFile(absPath, content);
  return absPath;
}

describe('Feishu parent-chat file reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbound.unbindClient();
    outbound.bindClient({ appId: 'cli_file_test', appSecret: 'secret', service: 'feishu' });
    mocks.createFile.mockImplementation(
      async ({ data }: { data: { file: NodeJS.ReadableStream } }) => {
        await readStream(data.file);
        return { file_key: 'file-key' };
      },
    );
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

  it('uploads a regular file once and reuses its file_key for the parent chat', async () => {
    const absPath = await fileFixture('report.txt', 'trusted report');

    const primary = await outbound.sendFile('ou_owner', absPath, 'report.txt');
    expect(primary).toEqual({
      ok: true,
      messageId: 'om_sent',
      reusableMessage: {
        msgType: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
    });

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u1'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('uploads an image once and reuses its image_key for the parent chat', async () => {
    const absPath = await fileFixture('preview.png', 'trusted image');

    const primary = await outbound.sendFile('ou_owner', absPath);
    expect(primary.reusableMessage).toEqual({
      msgType: 'image',
      content: JSON.stringify({ image_key: 'image-key' }),
    });

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u2'),
    ).resolves.toEqual({ ok: true, messageId: 'om_sent' });

    expect(mocks.createImage).toHaveBeenCalledOnce();
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('reports a parent-message failure without uploading the local file again', async () => {
    const absPath = await fileFixture('report.txt', 'trusted report');
    const primary = await outbound.sendFile('ou_owner', absPath);
    mocks.createMessage.mockRejectedValueOnce(new Error('group unavailable'));

    await expect(
      outbound.sendFileToChat('oc_group', primary.reusableMessage!, 'u3'),
    ).resolves.toEqual({ ok: false, reason: 'SEND_FAIL' });

    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });
});
