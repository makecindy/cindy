/**
 * outboundMediaCompress.test.ts — outboundMedia 与出方向压缩的接线:
 * base64 / xdt-image:// 来源压缩后走 uploadBuffer,普通磁盘路径保持字节精确不压,
 * 压缩不可用时回退原上传路径。压缩模块整体 mock,只验路由与参数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadLocalFile = vi.hoisted(() => vi.fn());
const uploadBuffer = vi.hoisted(() => vi.fn());
vi.mock('../mediaTransfer', () => ({ uploadLocalFile, uploadBuffer }));

const resolveSafe = vi.hoisted(() => vi.fn());
vi.mock('../../imageCacheStore', () => ({ resolveSafe }));

const compressOutboundImage = vi.hoisted(() => vi.fn());
const mayCompressOutboundImage = vi.hoisted(() => vi.fn());
vi.mock('../outboundImageCompress', () => ({
  compressOutboundImage,
  mayCompressOutboundImage,
  // 常量随真实实现口径 mock(整模块 mock 后必须显式提供,否则 import 得 undefined 让护栏恒假)
  OUTBOUND_IMAGE_INPUT_MAX_BYTES: 48 * 1024 * 1024,
}));

const readFile = vi.hoisted(() => vi.fn());
const statFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, promises: { ...original.promises, readFile, stat: statFile } };
});

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { rewriteOutboundMedia } from '../outboundMedia';
import { isAttachmentOssRef } from '../../../shared/attachmentOssRef';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const SHA256 = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  uploadLocalFile.mockResolvedValue({
    key: 'cindy/device-link/u/x.png',
    size: 10,
    contentType: 'image/png',
    sha256: SHA256,
  });
  uploadBuffer.mockResolvedValue({
    key: 'cindy/device-link/u/b.jpg',
    size: 5,
    contentType: 'image/jpeg',
    sha256: SHA256,
  });
  // 与真实实现同口径:png/jpeg 可能压,其它 mime 直通不读盘。
  mayCompressOutboundImage.mockImplementation(
    (mime: string | undefined) => mime === 'image/png' || mime === 'image/jpeg',
  );
  // 默认输入体量在护栏内(48MB 上限见 OUTBOUND_IMAGE_INPUT_MAX_BYTES)。
  statFile.mockResolvedValue({ size: 1024 });
});

describe('base64 来源', () => {
  it('压缩命中 → uploadBuffer 收到压缩字节与压缩后的 contentType/ext', async () => {
    const compressedBytes = Buffer.from([9, 9]);
    compressOutboundImage.mockResolvedValue({
      bytes: compressedBytes,
      contentType: 'image/jpeg',
      ext: 'jpg',
    });
    const raw = Buffer.alloc(64, 1);
    const out = await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', base64: raw.toString('base64'), mimeType: 'image/jpeg' }],
      },
    ]);
    expect(compressOutboundImage).toHaveBeenCalledTimes(1);
    expect(compressOutboundImage.mock.calls[0][0].equals(raw)).toBe(true);
    expect(compressOutboundImage.mock.calls[0][1]).toBe('image/jpeg');
    expect(uploadBuffer).toHaveBeenCalledWith(compressedBytes, {
      ext: 'jpg',
      contentType: 'image/jpeg',
    });
    const block = (out[1] as { content: Array<{ path?: string }> }).content[0];
    expect(isAttachmentOssRef(block.path!)).toBe(true);
  });

  it('压缩回退(null)→ uploadBuffer 收到原字节与原 mime', async () => {
    compressOutboundImage.mockResolvedValue(null);
    const raw = Buffer.alloc(16, 2);
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', base64: raw.toString('base64'), mimeType: 'image/png' }],
      },
    ]);
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), {
      ext: 'png',
      contentType: 'image/png',
    });
    expect((uploadBuffer.mock.calls[0][0] as Buffer).equals(raw)).toBe(true);
  });

  it('超过输入体量护栏(48MB)→ 不进压缩管线,原字节直接上传', async () => {
    const raw = Buffer.alloc(48 * 1024 * 1024 + 1, 3);
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', base64: raw.toString('base64'), mimeType: 'image/jpeg' }],
      },
    ]);
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), {
      ext: 'jpg',
      contentType: 'image/jpeg',
    });
    expect((uploadBuffer.mock.calls[0][0] as Buffer).byteLength).toBe(raw.byteLength);
  });
});

describe('xdt-image:// 来源', () => {
  it('读文件 → 压缩命中 → uploadBuffer,不再走 uploadLocalFile', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    readFile.mockResolvedValue(Buffer.alloc(128, 3));
    compressOutboundImage.mockResolvedValue({
      bytes: Buffer.from([1]),
      contentType: 'image/png',
      ext: 'png',
    });
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', path: 'xdt-image://s/a.png', mimeType: 'image/png' }],
      },
    ]);
    expect(readFile).toHaveBeenCalledWith('/cache/a.png');
    expect(uploadBuffer).toHaveBeenCalledWith(Buffer.from([1]), {
      ext: 'png',
      contentType: 'image/png',
    });
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('block 无 mimeType 时用 resolveSafe 的 mimeType 做压缩判定与回退上传', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/b.jpg', mimeType: 'image/jpeg' });
    readFile.mockResolvedValue(Buffer.alloc(8, 4));
    compressOutboundImage.mockResolvedValue(null);
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      { type: 'user', content: [{ type: 'image', path: 'xdt-image://s/b.jpg' }] },
    ]);
    expect(compressOutboundImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg');
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/b.jpg', { contentType: 'image/jpeg' });
  });

  it('读文件失败 → 跳过压缩,uploadLocalFile 走原路径保持原错误语义', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/gone.png', mimeType: 'image/png' });
    readFile.mockRejectedValue(new Error('ENOENT'));
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', path: 'xdt-image://s/gone.png', mimeType: 'image/png' }],
      },
    ]);
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/gone.png', { contentType: 'image/png' });
  });

  it('显式文件(url + 纯磁盘 path 双持)→ 字节精确,不读盘不压,流式上传缓存副本', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/design.png', mimeType: 'image/png' });
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.INPUT_ENQUEUE, [
      'sess',
      {
        text: '',
        files: [
          {
            id: '1',
            name: 'design.png',
            category: 'image',
            mimeType: 'image/png',
            url: 'xdt-image://s/design.png',
            path: '/abs/design.png',
          },
        ],
        persistedContent: JSON.stringify({
          text: '',
          images: [{ url: 'xdt-image://s/design.png' }],
          files: [],
        }),
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/design.png', { contentType: 'image/png' });
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('输入超过体量上限 → 不读盘不压,直接流式上传(防 main 进程内存尖峰)', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/monster.png', mimeType: 'image/png' });
    statFile.mockResolvedValue({ size: 48 * 1024 * 1024 + 1 });
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', path: 'xdt-image://s/monster.png', mimeType: 'image/png' }],
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/monster.png', {
      contentType: 'image/png',
    });
  });

  it('不可压格式(gif)不整读进内存,直接流式上传', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/anim.gif', mimeType: 'image/gif' });
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', path: 'xdt-image://s/anim.gif', mimeType: 'image/gif' }],
      },
    ]);
    expect(mayCompressOutboundImage).toHaveBeenCalledWith('image/gif');
    expect(readFile).not.toHaveBeenCalled();
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/anim.gif', { contentType: 'image/gif' });
  });
});

describe('磁盘路径来源(字节精确语义)', () => {
  it('绝对路径附件不压缩,原样 uploadLocalFile', async () => {
    await rewriteOutboundMedia(IPC_CHANNELS.MAKER_INVOKE.SEND, [
      'sess',
      {
        type: 'user',
        content: [{ type: 'image', path: '/abs/design.png', mimeType: 'image/png' }],
      },
    ]);
    expect(compressOutboundImage).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/abs/design.png', { contentType: 'image/png' });
  });
});
