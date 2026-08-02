/**
 * normalizeAttachmentsOss.test.ts — 被控端入方向物化:device-link 出方向 OSS 引用 →
 * presign-get 下载 → 写临时文件 → block.path 变本地路径 → 用后删 OSS。失败丢该附件。
 */
import assert from 'node:assert/strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test-attach' } }));

const writeFile = vi.hoisted(() => vi.fn(async () => {}));
const mkdir = vi.hoisted(() => vi.fn(async () => {}));
const readFile = vi.hoisted(() => vi.fn(async () => Buffer.from('image-bytes')));
vi.mock('node:fs/promises', () => ({
  default: { writeFile, mkdir, readFile, rm: vi.fn(async () => {}) },
  writeFile,
  mkdir,
  readFile,
  rm: vi.fn(async () => {}),
}));

const copyFromPath = vi.hoisted(() => vi.fn());
const removeFile = vi.hoisted(() => vi.fn(async () => {}));
const resolveSafe = vi.hoisted(() => vi.fn());
vi.mock('../imageCacheStore.js', () => ({
  copyFromPath,
  removeFile,
  resolveSafe,
  collectSessionImageUrls: vi.fn(() => []),
}));

// cindy-media:媒体 mime 物化走总仓 ingest,mock 记调用。
const BLOB_HASH = 'a'.repeat(64);
const BLOB_URL = `cindy-media://blobs/${BLOB_HASH}.png`;
const ingestMedia = vi.hoisted(() => vi.fn());
vi.mock('../cindy-media/ingest.js', () => ({ ingestMedia }));
const removeRefById = vi.hoisted(() => vi.fn(async () => 1));
const deleteZeroRefBlobRecord = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../cindy-media/ledger.js', () => ({ removeRefById, deleteZeroRefBlobRecord }));
const blobResolveSafe = vi.hoisted(() => vi.fn());
const deleteBlobFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../cindy-media/blobStore.js', () => ({
  deleteBlobFile,
  resolveSafe: blobResolveSafe,
  mimeForExt: (ext: string) =>
    (
      ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      }) as Record<string, string>
    )[ext] ?? null,
  supportedMime: (m: string) =>
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'].includes(m),
}));

const downloadToFile = vi.hoisted(() => vi.fn(async () => {}));
const removeRemote = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../device-link/mediaTransfer.js', () => ({ downloadToFile, removeRemote }));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  materializeDirectSendOssAttachments,
  normalizeUserMessage,
  materializeQueuedOssAttachments,
} from '../maker-ipc/normalizeAttachments';
import { buildAttachmentOssRef } from '../../shared/attachmentOssRef';

const ATTACHMENT_SHA256 = 'a'.repeat(64);

describe('queued attachment cleanup regression', () => {
  it('cleans earlier materialized OSS objects when a later integrity ref rejects the queue', async () => {
    const first = buildAttachmentOssRef({ ossKey: 'oss/first.png', mimeType: 'image/png' });
    const second = buildAttachmentOssRef({
      ossKey: 'oss/second.pdf',
      mimeType: 'application/pdf',
      size: 3,
      sha256: ATTACHMENT_SHA256,
    });
    downloadToFile.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'oss/second.pdf') throw new Error('integrity mismatch');
    });

    await expect(
      materializeQueuedOssAttachments('sess-1', {
        files: [
          { path: first, mimeType: 'image/png' },
          { path: second, mimeType: 'application/pdf' },
        ],
      }),
    ).rejects.toThrow();
    expect(removeRemote).toHaveBeenCalledWith('oss/first.png');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  downloadToFile.mockResolvedValue(undefined);
  readFile.mockResolvedValue(Buffer.from('image-bytes'));
  ingestMedia.mockResolvedValue({
    hash: BLOB_HASH,
    ext: '.png',
    mimeType: 'image/png',
    bytes: 11,
    url: BLOB_URL,
    deduplicated: false,
    refIds: ['ref-1'],
  });
  removeRefById.mockResolvedValue(1);
  deleteZeroRefBlobRecord.mockResolvedValue(false);
  blobResolveSafe.mockImplementation((url: string) => ({
    absPath: `/blobs/${url.slice('cindy-media://blobs/'.length)}`,
    mimeType: 'image/png',
    hash: BLOB_HASH,
  }));
});

describe('normalizeUserMessage — device-link 出方向 OSS 引用物化', () => {
  it('OSS 引用块 → 流式下载到临时文件 → path 变本地 → 删 OSS', async () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/u/x.png',
      mimeType: 'image/png',
    });
    const out = await normalizeUserMessage('sess-1', {
      type: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', path: ref },
      ],
    });
    expect(downloadToFile).toHaveBeenCalledTimes(1);
    const [ossKeyArg, destArg] = downloadToFile.mock.calls[0] as unknown as [string, string];
    expect(ossKeyArg).toBe('cindy/device-link/u/x.png');
    expect(destArg).toMatch(/cindy-attachments[\\/]sess-1[\\/].+\.png$/);
    const block = (out as { content: Array<{ type: string; path?: string; mimeType?: string }> })
      .content[1];
    expect(block.path).toBe(destArg); // path 指向下载目标
    expect(block.mimeType).toBe('image/png');
    expect(removeRemote).toHaveBeenCalledWith('cindy/device-link/u/x.png');
  });

  it('下载失败 → 丢该附件(turn 仍发出),不删 OSS', async () => {
    downloadToFile.mockRejectedValue(new Error('OSS GET 失败 (404)'));
    const ref = buildAttachmentOssRef({ ossKey: 'k/x.png' });
    const out = await normalizeUserMessage('sess-1', {
      type: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', path: ref },
      ],
    });
    const content = (out as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1); // 附件被丢,只剩 text
    expect(content[0].type).toBe('text');
    expect(removeRemote).not.toHaveBeenCalled();
  });

  it('带完整性声明的新引用下载失败 → 阻止整条消息进入 agent', async () => {
    downloadToFile.mockRejectedValue(new Error('附件下载不完整'));
    const ref = buildAttachmentOssRef({
      ossKey: 'k/x.png',
      size: 3,
      sha256: ATTACHMENT_SHA256,
    });

    await expect(
      normalizeUserMessage('sess-1', {
        type: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', path: ref },
        ],
      }),
    ).rejects.toThrow(/下载不完整/);

    expect(downloadToFile).toHaveBeenCalledWith('k/x.png', expect.any(String), {
      size: 3,
      sha256: ATTACHMENT_SHA256,
    });
  });

  it('普通文本消息 → 原样,不触发下载', async () => {
    const out = await normalizeUserMessage('sess-1', 'plain text');
    expect(out).toBe('plain text');
    expect(downloadToFile).not.toHaveBeenCalled();
  });
});

describe('materializeQueuedOssAttachments — 出方向 files[] + persistedContent 一次性物化', () => {
  it('files[] 与 persistedContent 共用同一 OSS 引用 → 只下载/入库一次,删 OSS 一次;图片入总仓、非媒体走老缓存', async () => {
    // 同一张图,控制端给 files[].url/path 与 persistedContent.images[].url 用了同一个 OSS 引用串。
    const imgRef = buildAttachmentOssRef({
      ossKey: 'oss/img.png',
      mimeType: 'image/png',
      originalName: 'a.png',
    });
    const fileRef = buildAttachmentOssRef({
      ossKey: 'oss/doc.pdf',
      mimeType: 'application/pdf',
      originalName: 'd.pdf',
    });
    copyFromPath.mockImplementation(async ({ originalName }: { originalName: string }) => ({
      url: `xdt-image://sess-1/cached-${originalName}`,
      filename: `cached-${originalName}`,
    }));
    resolveSafe.mockImplementation((url: string) => ({
      absPath: `/cache/${url.replace('xdt-image://', '')}`,
      mimeType: 'x',
    }));

    const item = {
      clientId: 'c1',
      files: [
        { url: imgRef, path: imgRef, mimeType: 'image/png', category: 'image' },
        { url: fileRef, path: fileRef, mimeType: 'application/pdf', category: 'file' },
      ],
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [{ url: imgRef, mimeType: 'image/png', originalName: 'a.png' }],
        files: [{ name: 'd.pdf', path: fileRef }],
      }),
    };

    const out = (await materializeQueuedOssAttachments('sess-1', item)) as typeof item;

    // 每个 OSS 对象只下载一次(2 个),即使 files[] 与 persistedContent 各引用一次。
    expect(downloadToFile).toHaveBeenCalledTimes(2);
    // 用后删:每个 ossKey 删一次。
    expect(removeRemote).toHaveBeenCalledTimes(2);
    expect(removeRemote).toHaveBeenCalledWith('oss/img.png');
    expect(removeRemote).toHaveBeenCalledWith('oss/doc.pdf');

    // 图片(媒体 mime)→ 总仓 ingest 一次,并直接挂 session-attachment 引用;
    // pdf(非媒体)→ 维持老 image cache 落地(规则 25 边界)。
    expect(ingestMedia).toHaveBeenCalledTimes(1);
    expect(ingestMedia.mock.calls[0][0]).toMatchObject({
      mimeType: 'image/png',
      refs: [{ refKind: 'session-attachment', refId: 'sess-1', originSessionId: 'sess-1' }],
    });
    expect(copyFromPath).toHaveBeenCalledTimes(1);

    // files[]:图片喂 agent 走 url=cindy-media://(normalizeUserMessage 再解析)。
    const f = out.files as Array<{ url: string; path: string; base64?: unknown }>;
    expect(f[0].url).toBe(BLOB_URL);
    expect(f[0].path).toBe(`/blobs/${BLOB_HASH}.png`);
    expect(f[0].base64).toBeUndefined();

    // persistedContent:images 引用走 url=cindy-media://(可渲染),files 引用走 path=老 cache 绝对路径。
    const pc = JSON.parse(out.persistedContent) as {
      images: Array<{ url: string }>;
      files: Array<{ path: string }>;
    };
    expect(pc.images[0].url).toBe(BLOB_URL);
    expect(pc.files[0].path).toBe('/cache/sess-1/cached-d.pdf');
  });

  it('无 OSS 引用(本机会话)→ 原样返回,不下载/不入库', async () => {
    const item = {
      clientId: 'c1',
      files: [{ url: 'xdt-image://sess-1/local.png', mimeType: 'image/png' }],
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [{ url: 'xdt-image://sess-1/local.png' }],
        files: [],
      }),
    };
    const out = await materializeQueuedOssAttachments('sess-1', item);
    expect(out).toBe(item); // 引用相等:零改动
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(copyFromPath).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled();
  });

  it('images[].url 为被控端本机绝对路径图片(手机文件浏览器发送)→ 读字节入总仓改写为 cindy-media://,不删源文件', async () => {
    // 手机文件浏览器「发送到会话」的远程图片:写侧只有 fs 路径,不物化的话
    // coerceImageRef 只认托管协议,两端聊天记录都不渲染缩略图。
    const item = {
      clientId: 'c1',
      files: [{ path: '/workdir/assets/photo.png', mimeType: 'image/png', category: 'image' }],
      persistedContent: JSON.stringify({
        text: '看下这张',
        images: [
          { url: '/workdir/assets/photo.png', mimeType: 'image/png', originalName: 'photo.png' },
        ],
        files: [],
      }),
    };

    const out = (await materializeQueuedOssAttachments('sess-1', item)) as typeof item;

    // 读源文件字节 → 总仓 ingest(带 session-attachment 引用);老缓存零参与。
    expect(readFile).toHaveBeenCalledWith('/workdir/assets/photo.png');
    expect(ingestMedia).toHaveBeenCalledTimes(1);
    expect(ingestMedia.mock.calls[0][0]).toMatchObject({
      mimeType: 'image/png',
      refs: [{ refKind: 'session-attachment', refId: 'sess-1', originSessionId: 'sess-1' }],
    });
    expect(copyFromPath).not.toHaveBeenCalled();
    // 源文件是用户工作区文件:不走 OSS 下载,更不能删任何东西。
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled();

    const pc = JSON.parse(out.persistedContent) as {
      images: Array<{ url: string; originalName: string }>;
    };
    expect(pc.images[0].url).toBe(BLOB_URL);
    expect(pc.images[0].originalName).toBe('photo.png'); // spread 保留其余字段
    // files[] 分支只处理 OSS 引用:裸路径原样(喂 agent 走 path 读文件)。
    const f = out.files as Array<{ path: string }>;
    expect(f[0].path).toBe('/workdir/assets/photo.png');
  });

  it('本机绝对路径图片读取失败 → 保留原引用(降级,不阻断整条)', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    const item = {
      clientId: 'c1',
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [{ url: '/gone/missing.png', mimeType: 'image/png', originalName: 'missing.png' }],
        files: [],
      }),
    };
    const out = (await materializeQueuedOssAttachments('sess-1', item)) as {
      persistedContent: string;
    };
    const pc = JSON.parse(out.persistedContent) as { images: Array<{ url: string }> };
    expect(pc.images[0].url).toBe('/gone/missing.png');
  });

  it('非图片扩展的绝对路径不触发物化(仅 png/jpg/jpeg/gif/webp 准入)', async () => {
    const item = {
      clientId: 'c1',
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [
          { url: '/workdir/report.pdf', mimeType: 'application/pdf', originalName: 'report.pdf' },
        ],
        files: [{ name: 'notes.txt', path: '/workdir/notes.txt' }],
      }),
    };
    const out = await materializeQueuedOssAttachments('sess-1', item);
    expect(out).toBe(item); // 无需物化:引用相等原样返回
    expect(copyFromPath).not.toHaveBeenCalled();
  });

  it('单个附件物化失败 → 保留原引用,不删该 OSS(降级,不阻断整条)', async () => {
    const imgRef = buildAttachmentOssRef({ ossKey: 'oss/img.png', mimeType: 'image/png' });
    downloadToFile.mockRejectedValue(new Error('OSS GET 失败'));
    const item = {
      clientId: 'c1',
      files: [{ url: imgRef, path: imgRef, mimeType: 'image/png' }],
      persistedContent: '{"text":"hi"}',
    };
    const out = (await materializeQueuedOssAttachments('sess-1', item)) as typeof item;
    const f = out.files as Array<{ url: string }>;
    expect(f[0].url).toBe(imgRef); // 原引用保留
    expect(removeRemote).not.toHaveBeenCalled();
  });

  it('排队消息的新引用校验失败 → 不入队且不保留伪引用', async () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'oss/doc.pdf',
      mimeType: 'application/pdf',
      originalName: 'doc.pdf',
      size: 3,
      sha256: ATTACHMENT_SHA256,
    });
    downloadToFile.mockRejectedValue(new Error('附件完整性校验失败'));

    await expect(
      materializeQueuedOssAttachments('sess-1', {
        clientId: 'c1',
        files: [{ path: ref, mimeType: 'application/pdf' }],
        persistedContent: JSON.stringify({
          text: 'hi',
          images: [],
          files: [{ name: 'doc.pdf', path: ref }],
        }),
      }),
    ).rejects.toThrow(/完整性校验失败/);
  });
});

describe('materializeDirectSendOssAttachments — message + persistUserMessage 一次性物化', () => {
  it('同一危险文件只下载一次，agent path 与持久路径同时落到 .bin，发送 accepted 后才删 OSS', async () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'oss/setup.bin',
      mimeType: 'application/octet-stream',
      originalName: 'setup.exe',
      size: 15,
      sha256: ATTACHMENT_SHA256,
    });
    copyFromPath.mockImplementation(async ({ originalName }: { originalName: string }) => ({
      url: `xdt-image://sess-1/cached-${originalName}.bin`,
      filename: `cached-${originalName}.bin`,
    }));
    resolveSafe.mockImplementation((url: string) => ({
      absPath: `/cache/${url.replace('xdt-image://', '')}`,
      mimeType: 'application/octet-stream',
    }));
    const persistedContent = JSON.stringify({
      text: 'run check',
      images: [],
      files: [{
        name: 'setup.exe',
        path: ref,
        size: 15,
        sha256: ATTACHMENT_SHA256,
      }],
    });

    const out = await materializeDirectSendOssAttachments(
      'sess-1',
      {
        type: 'user',
        content: [
          { type: 'text', text: 'run check' },
          {
            type: 'file',
            path: ref,
            mimeType: 'application/octet-stream',
            originalName: 'setup.exe',
          },
        ],
      },
      { persistUserMessage: { clientId: 'c1', content: persistedContent } },
    );

    assert.equal(downloadToFile.mock.calls.length, 1);
    const copyArgs = copyFromPath.mock.calls[0]?.[0] as { originalName?: unknown } | undefined;
    assert.equal(copyArgs?.originalName, 'setup.exe');
    assert.equal(removeRemote.mock.calls.length, 0);
    assert.equal(typeof out.cleanupAfterAcceptance, 'function');
    assert.equal(typeof out.cleanupBeforeAcceptance, 'function');
    await out.cleanupBeforeAcceptance?.();
    expect(removeRemote).not.toHaveBeenCalled();
    expect(removeFile).toHaveBeenCalledWith('xdt-image://sess-1/cached-setup.exe.bin');
    out.cleanupAfterAcceptance?.();
    const removeCalls = removeRemote.mock.calls as unknown[][];
    assert.equal(removeCalls.length, 1);
    assert.equal(removeCalls[0]?.[0], 'oss/setup.bin');

    const block = (out.message as { content: Array<{ path?: string }> }).content[1];
    assert.equal(block.path, '/cache/sess-1/cached-setup.exe.bin');
    const pc = JSON.parse(
      (out.sendOpts as { persistUserMessage: { content: string } }).persistUserMessage.content,
    ) as { files: Array<{ name: string; path: string }> };
    assert.deepEqual(pc.files[0], {
      name: 'setup.exe',
      path: '/cache/sess-1/cached-setup.exe.bin',
      size: 15,
      sha256: ATTACHMENT_SHA256,
    });
  });

  it('cleans a cindy-media materialization and its ref before an unaccepted send', async () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'oss/photo.png',
      mimeType: 'image/png',
      originalName: 'photo.png',
    });
    deleteZeroRefBlobRecord.mockResolvedValue(true);

    const out = await materializeDirectSendOssAttachments(
      'sess-1',
      { type: 'user', content: [{ type: 'file', path: ref, mimeType: 'image/png' }] },
      undefined,
    );

    await out.cleanupBeforeAcceptance?.();

    expect(removeRefById).toHaveBeenCalledWith('ref-1');
    expect(deleteZeroRefBlobRecord).toHaveBeenCalledWith(BLOB_HASH, expect.any(Number));
    expect(deleteBlobFile).toHaveBeenCalledWith(BLOB_HASH, '.png');
    expect(removeRemote).not.toHaveBeenCalled();

    out.cleanupAfterAcceptance?.();
    expect(removeRemote).toHaveBeenCalledWith('oss/photo.png');
  });

  it('没有 OSS 引用时保持原对象，不产生文件 IO', async () => {
    const message = {
      type: 'user',
      content: [{ type: 'file', path: 'C:\\cache\\local.pdf', mimeType: 'application/pdf' }],
    };
    const sendOpts = {
      persistUserMessage: {
        content: JSON.stringify({
          text: '',
          images: [],
          files: [{ name: 'local.pdf', path: 'C:\\cache\\local.pdf' }],
        }),
      },
    };
    const out = await materializeDirectSendOssAttachments('sess-1', message, sendOpts);
    assert.deepEqual(out, { message, sendOpts });
    assert.equal(downloadToFile.mock.calls.length, 0);
  });

  it('materializing another OSS file does not strip an unrelated base64 image', async () => {
    const fileRef = buildAttachmentOssRef({
      ossKey: 'oss/doc.pdf',
      mimeType: 'application/pdf',
      originalName: 'doc.pdf',
    });
    copyFromPath.mockResolvedValue({
      url: 'xdt-image://sess-1/cached-doc.pdf',
      filename: 'cached-doc.pdf',
    });
    resolveSafe.mockReturnValue({
      absPath: '/cache/sess-1/cached-doc.pdf',
      mimeType: 'application/pdf',
    });
    const message = {
      type: 'user',
      content: [
        { type: 'image', base64: 'inline-image', mimeType: 'image/png' },
        { type: 'file', path: fileRef, mimeType: 'application/pdf' },
      ],
    };
    const out = await materializeDirectSendOssAttachments(
      'sess-1',
      message,
      {
        persistUserMessage: {
          content: JSON.stringify({
            text: '',
            images: [],
            files: [{ name: 'doc.pdf', path: fileRef }],
          }),
        },
      },
    );
    assert.deepEqual((out.message as typeof message).content[0], {
      type: 'image',
      base64: 'inline-image',
      mimeType: 'image/png',
    });
  });

  it('dangerous original names stay .bin even when a remote MIME claims image/png', async () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'oss/spoofed.png',
      mimeType: 'image/png',
      originalName: 'setup.exe',
      size: 3,
      sha256: ATTACHMENT_SHA256,
    });
    copyFromPath.mockResolvedValue({
      url: 'xdt-image://sess-1/cached-setup.bin',
      filename: 'cached-setup.bin',
    });
    resolveSafe.mockReturnValue({
      absPath: '/cache/sess-1/cached-setup.bin',
      mimeType: 'application/octet-stream',
    });
    const out = await materializeDirectSendOssAttachments(
      'sess-1',
      {
        type: 'user',
        content: [{ type: 'file', path: ref, mimeType: 'image/png', originalName: 'setup.exe' }],
      },
      {
        persistUserMessage: {
          content: JSON.stringify({
            text: '',
            images: [],
            files: [{ name: 'setup.exe', path: ref, size: 3, sha256: ATTACHMENT_SHA256 }],
          }),
        },
      },
    );
    assert.equal(ingestMedia.mock.calls.length, 0);
    const copyArgs = copyFromPath.mock.calls[0]?.[0] as { originalName?: unknown } | undefined;
    assert.equal(copyArgs?.originalName, 'setup.exe');
    assert.equal(
      (out.message as { content: Array<{ path: string }> }).content[0].path,
      '/cache/sess-1/cached-setup.bin',
    );
  });
});
