/**
 * outboundMedia.test.ts — 控制端出方向附件改写:上传 OSS + 替换为引用串。
 * mock mediaTransfer + imageCacheStore,验 scheme 路由 / 双形态(send block / enqueue files)/
 * 失败传播 / 非媒体 channel 与无附件透传。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadLocalFile = vi.hoisted(() => vi.fn());
const uploadBuffer = vi.hoisted(() => vi.fn());
vi.mock('../mediaTransfer', () => ({ uploadLocalFile, uploadBuffer }));

const resolveSafe = vi.hoisted(() => vi.fn());
vi.mock('../../imageCacheStore', () => ({ resolveSafe }));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { rewriteOutboundMedia, __testing } from '../outboundMedia';
import { parseAttachmentOssRef, isAttachmentOssRef } from '../../../shared/attachmentOssRef';

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
    key: 'cindy/device-link/u/b.png',
    size: 5,
    contentType: 'image/png',
    sha256: SHA256,
  });
});

describe('rewriteOutboundMedia — channel gating', () => {
  it('非媒体 channel → 原样,不上传', async () => {
    const args = [{ a: 1 }];
    const out = await rewriteOutboundMedia('maker:set-model', args);
    expect(out).toBe(args);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('send 纯文本(string message)→ 原样', async () => {
    const out = await rewriteOutboundMedia('maker:send', ['sess', 'hello']);
    expect(out[1]).toBe('hello');
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('send 无附件 content → 不上传', async () => {
    await rewriteOutboundMedia('maker:send', [
      'sess',
      { type: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(uploadLocalFile).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('rewriteQueued — persistedContent 同批改写 + 去重单上传', () => {
  it('files[] 与 persistedContent 的同一附件用同一 OSS 引用,只上传一次', async () => {
    resolveSafe.mockReturnValue({ absPath: '/abs/a.png', mimeType: 'image/png' });
    uploadLocalFile
      .mockResolvedValueOnce({
        key: 'cindy/device-link/u/img.png',
        size: 1,
        contentType: 'image/png',
        sha256: SHA256,
      })
      .mockResolvedValueOnce({
        key: 'cindy/device-link/u/doc.pdf',
        size: 1,
        contentType: 'application/pdf',
        sha256: SHA256,
      });

    const item = {
      clientId: 'c1',
      files: [
        { url: 'xdt-image://s/a.png', mimeType: 'image/png', category: 'image' },
        { path: '/abs/d.pdf', mimeType: 'application/pdf', category: 'file' },
      ],
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [{ url: 'xdt-image://s/a.png', mimeType: 'image/png', originalName: 'a.png' }],
        files: [{ name: 'd.pdf', path: '/abs/d.pdf' }],
      }),
    };

    const out = (await __testing.rewriteQueued(item)) as {
      files: Array<{ url: string; path: string; size: number; sha256: string }>;
      persistedContent: string;
    };

    // 两个附件各只上传一次(persistedContent 复用 refMap,不再额外上传)。
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);

    const imgRef = out.files[0].url;
    const fileRef = out.files[1].url;
    expect(isAttachmentOssRef(imgRef)).toBe(true);
    expect(isAttachmentOssRef(fileRef)).toBe(true);
    expect(out.files[0]).toMatchObject({ size: 1, sha256: SHA256 });
    expect(out.files[1]).toMatchObject({ size: 1, sha256: SHA256 });

    // persistedContent 用同一批引用(images→url、files→path),与 files[] 对齐。
    const pc = JSON.parse(out.persistedContent) as {
      images: Array<{ url: string; size: number; sha256: string }>;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(pc.images[0]).toMatchObject({ url: imgRef, size: 1, sha256: SHA256 });
    expect(pc.files[0]).toMatchObject({ path: fileRef, size: 1, sha256: SHA256 });
  });

  it('persistedContent 解析失败 → 原样保留(降级),files[] 仍照常改写', async () => {
    uploadLocalFile.mockResolvedValue({
      key: 'cindy/device-link/u/x.png',
      size: 1,
      contentType: 'image/png',
      sha256: SHA256,
    });
    const item = {
      files: [{ path: '/abs/x.png', mimeType: 'image/png' }],
      persistedContent: 'not-json{',
    };
    const out = (await __testing.rewriteQueued(item)) as {
      files: Array<{ url: string }>;
      persistedContent: string;
    };
    expect(isAttachmentOssRef(out.files[0].url)).toBe(true);
    expect(out.persistedContent).toBe('not-json{'); // 解析失败原样
  });
});

describe('rewriteOutboundMedia — send/steer content-block 形态', () => {
  it('maker:send 同批改写 message 与持久内容，同一附件只上传一次并传播原名', async () => {
    uploadLocalFile.mockResolvedValue({
      key: 'cindy/device-link/u/setup.bin',
      size: 42,
      contentType: 'application/octet-stream',
      sha256: SHA256,
    });
    const persistedContent = JSON.stringify({
      text: 'check it',
      images: [],
      files: [{ name: 'setup.exe', path: 'C:\\cache\\setup.exe.bin' }],
    });

    const out = await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [
          {
            type: 'file',
            path: 'C:\\cache\\setup.exe.bin',
            mimeType: 'application/octet-stream',
            originalName: 'setup.exe',
          },
        ],
      },
      undefined,
      { persistUserMessage: { clientId: 'c1', content: persistedContent } },
    ]);

    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
    const block = (out[1] as { content: Array<{ path: string; originalName: string }> }).content[0];
    const pc = JSON.parse(
      ((out[3] as { persistUserMessage: { content: string } }).persistUserMessage.content),
    ) as { files: Array<{ path: string }> };
    expect(pc.files[0].path).toBe(block.path);
    expect(block.originalName).toBe('setup.exe');
    expect(parseAttachmentOssRef(block.path)?.originalName).toBe('setup.exe');
  });

  it('uses queued file.name when originalName is absent', async () => {
    const out = await rewriteOutboundMedia('maker:input:enqueue', [
      'sess',
      {
        files: [
          {
            name: 'archive.zip',
            path: '/abs/archive.zip',
            mimeType: 'application/zip',
          },
        ],
      },
    ]);
    const ref = (out[1] as { files: Array<{ path: string }> }).files[0].path;
    expect(parseAttachmentOssRef(ref)?.originalName).toBe('archive.zip');
  });

  it('xdt-image:// 块 → resolveSafe → uploadLocalFile → block.path 变 OSS 引用,base64 清掉', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    const out = await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', path: 'xdt-image://s/a.png', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(resolveSafe).toHaveBeenCalledWith('xdt-image://s/a.png');
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/a.png', { contentType: 'image/png' });
    const block = (out[1] as { content: Array<{ type: string; path?: string }> }).content[1];
    expect(isAttachmentOssRef(block.path!)).toBe(true);
    expect(parseAttachmentOssRef(block.path!)?.ossKey).toBe('cindy/device-link/u/x.png');
  });

  it('base64 块 → uploadBuffer', async () => {
    const out = await rewriteOutboundMedia('maker:steer', [
      'sess',
      {
        type: 'user',
        content: [
          { type: 'image', base64: Buffer.from([1, 2]).toString('base64'), mimeType: 'image/png' },
        ],
      },
    ]);
    expect(uploadBuffer).toHaveBeenCalled();
    const block = (out[1] as { content: Array<{ path?: string; base64?: string }> }).content[0];
    expect(isAttachmentOssRef(block.path!)).toBe(true);
    expect(block.base64).toBeUndefined();
  });

  it('绝对路径块 → uploadLocalFile(原路径)', async () => {
    await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [{ type: 'file', path: '/abs/doc.pdf', mimeType: 'application/pdf' }],
      },
    ]);
    expect(uploadLocalFile).toHaveBeenCalledWith('/abs/doc.pdf', {
      contentType: 'application/pdf',
    });
  });
});

describe('rewriteOutboundMedia — enqueue files 形态', () => {
  it('item.files[] 上传 + url/path 变引用、base64 清掉(buildMakerUserMessage 取 url)', async () => {
    const out = await rewriteOutboundMedia('maker:input:enqueue', [
      'sess',
      {
        text: 'hi',
        files: [
          {
            id: '1',
            name: 'a.png',
            category: 'image',
            mimeType: 'image/png',
            base64: Buffer.from([9]).toString('base64'),
          },
        ],
      },
    ]);
    expect(uploadBuffer).toHaveBeenCalled();
    const f = (out[1] as { files: Array<{ url?: string; base64?: string }> }).files[0];
    expect(isAttachmentOssRef(f.url!)).toBe(true);
    expect(f.base64).toBeUndefined();
  });

  it('enqueue 无 files → 原样', async () => {
    const item = { text: 'hi' };
    const out = await rewriteOutboundMedia('maker:input:enqueue', ['sess', item]);
    expect(out[1]).toBe(item);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('maker:input:steer 同 enqueue 形态(steer 带附件也必须改写)', async () => {
    const out = await rewriteOutboundMedia('maker:input:steer', [
      'sess',
      {
        text: 'hi',
        files: [
          { id: '1', name: 'a.png', category: 'image', mimeType: 'image/png', path: '/abs/a.png' },
        ],
      },
    ]);
    expect(uploadLocalFile).toHaveBeenCalledWith('/abs/a.png', { contentType: 'image/png' });
    const f = (out[1] as { files: Array<{ url?: string }> }).files[0];
    expect(isAttachmentOssRef(f.url!)).toBe(true);
  });
});

describe('rewriteOutboundMedia — 失败传播', () => {
  it('上传失败 → 抛错(handleInvoke 转 MEDIA_TRANSFER_FAILED,整条不发)', async () => {
    uploadLocalFile.mockRejectedValue(new Error('OSS PUT 失败 (403)'));
    await expect(
      rewriteOutboundMedia('maker:send', [
        'sess',
        { type: 'user', content: [{ type: 'image', path: '/abs/a.png' }] },
      ]),
    ).rejects.toThrow(/OSS PUT/);
  });

  it('clipboard 占位 → 抛错', async () => {
    await expect(
      rewriteOutboundMedia('maker:send', [
        'sess',
        { type: 'user', content: [{ type: 'image', path: 'clipboard://paste-1' }] },
      ]),
    ).rejects.toThrow(/clipboard/);
  });
});
