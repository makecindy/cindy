/**
 * feishu/attachmentDownloader.test.ts — downloadOne 的入站附件路由。
 * 钉死新契约: 图片 → host.media.cacheImage(白名单外格式标不支持), 视频/音频 →
 * host.media.cacheMedia, 其余文件 → host.files.stage; host 缺对应能力时如实标
 * 不支持且不下载。任何分支都不写冻结的 `cc-agent/feishu-media`(paths.feishuMediaDir)。
 * 临时目录落 os.tmpdir() 并收尾清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import type * as Lark from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadAttachments, MAX_FILE_SIZE } from '../attachmentDownloader.js';
import type { AttachmentRef } from '../incomingContent.js';
import { setHost } from '../moduleScope.js';
import { defaultLogger, type Logger } from '../../logger.js';
import type { IMHost, IMHostFileStaging, IMHostMediaCache } from '../../types.js';

const PNG_BYTES = Buffer.from('png-bytes');
const CINDY_URL = `cindy-media://blobs/${'a'.repeat(64)}.png`;

let legacyDir = '';

beforeEach(() => {
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-attachment-downloader-'));
});

afterEach(() => {
  // 冻结的老目录从不被写入。
  expect(fs.readdirSync(legacyDir)).toEqual([]);
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

function makeClient(buffer: Buffer, mime: string) {
  const get = vi.fn(async () => ({
    getReadableStream: () => Readable.from([buffer]),
    headers: { 'content-type': mime },
  }));
  const client = { im: { v1: { messageResource: { get } } } } as unknown as Lark.Client;
  return { client, get };
}

function makeMedia(overrides: Partial<IMHostMediaCache> = {}) {
  return {
    cacheImage: vi.fn(async ({ token }: { token: string }) => ({
      absPath: `/blobs/${token}.png`,
      url: CINDY_URL,
    })),
    cacheMedia: vi.fn(async ({ token, mimeType }: { token: string; mimeType: string }) => ({
      absPath: `/blobs/${token}.mp4`,
      url: `cindy-media://blobs/${token}.mp4`,
      mimeType,
    })),
    getCachedImage: vi.fn(async () => null),
    resolveMediaUrl: vi.fn(() => null),
    ...overrides,
  };
}

function makeFiles() {
  const stage = vi.fn<IMHostFileStaging['stage']>(async ({ fileName }) => ({
    absPath: `/staged/${fileName}`,
    discard: vi.fn(async () => {}),
  }));
  return { stage };
}

const silentLog: Logger = { ...defaultLogger('im:feishu:test'), error: () => {} };

function wireHost(
  opts: { media?: IMHostMediaCache; files?: IMHostFileStaging; accountScope?: IMHost['accountScope'] } = {},
): void {
  const host = {
    paths: { feishuMediaDir: legacyDir },
    ...(opts.accountScope ? { accountScope: opts.accountScope } : {}),
    ...(opts.media ? { media: opts.media } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    secrets: {
      isAvailable: () => false,
      write: () => false,
      read: () => null,
      remove: () => {},
    },
    ipc: {
      throwIpcError: (code: string, message: string) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: () => {},
      broadcast: () => {},
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
  } as unknown as IMHost;
  setHost(host, silentLog);
}

const imageRef: AttachmentRef = { kind: 'image', imageKey: 'img_1' };
const pdfRef: AttachmentRef = { kind: 'file', fileKey: 'file_1', fileName: 'report.pdf' };
const videoRef: AttachmentRef = { kind: 'file', fileKey: 'file_v', fileName: 'demo.mp4', video: true };

describe('downloadAttachments: 图片 → 媒体总仓', () => {
  it('png 下载一次入 cacheImage, url 透传', async () => {
    const media = makeMedia();
    wireHost({ media, files: makeFiles() });
    const { client, get } = makeClient(PNG_BYTES, 'image/PNG');

    const result = await downloadAttachments(client, 'om_1', [imageRef]);

    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_1', file_key: 'img_1' },
      params: { type: 'image' },
    });
    expect(media.cacheImage).toHaveBeenCalledWith({
      integration: 'feishu',
      token: 'img_1',
      buffer: PNG_BYTES,
      mimeType: 'image/png',
      // 落库前一律可回收暂存, 换代可回滚。
      staging: true,
    });
    expect(result).toEqual({
      attachments: [
        {
          kind: 'image',
          absPath: '/blobs/img_1.png',
          originalName: 'img_1.png',
          mimeType: 'image/png',
          url: CINDY_URL,
        },
      ],
      unsupported: [],
    });
  });

  it('总仓已有同 token:免下载直接复用', async () => {
    const cachedPath = path.join(legacyDir, '..', `cached-${Date.now()}.webp`);
    fs.writeFileSync(cachedPath, Buffer.from('webp'));
    try {
      const media = makeMedia({
        getCachedImage: vi.fn(async () => ({ absPath: cachedPath, url: CINDY_URL, mimeType: 'image/webp' })),
      });
      wireHost({ media });
      const { client, get } = makeClient(PNG_BYTES, 'image/png');

      const result = await downloadAttachments(client, 'om_1', [imageRef]);

      expect(get).not.toHaveBeenCalled();
      expect(media.cacheImage).not.toHaveBeenCalled();
      expect(result.attachments).toEqual([
        { kind: 'image', absPath: cachedPath, originalName: 'img_1.webp', mimeType: 'image/webp', url: CINDY_URL },
      ]);
    } finally {
      fs.rmSync(cachedPath, { force: true });
    }
  });

  it('响应头没给类型的图片也交 host 按真实字节核验, 附件 MIME 用 host 核验结果', async () => {
    const media = makeMedia({
      cacheImage: vi.fn(async ({ token }: { token: string }) => ({
        absPath: `/blobs/${token}.png`,
        url: CINDY_URL,
        mimeType: 'image/png',
      })),
    });
    wireHost({ media, files: makeFiles() });
    const { client } = makeClient(PNG_BYTES, 'application/octet-stream');

    const result = await downloadAttachments(client, 'om_1', [imageRef]);

    expect(media.cacheImage).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([expect.objectContaining({ kind: 'image', mimeType: 'image/png' })]);
  });

  it('缓存命中的图片同样套 30MB 上限(升级前缓存可能存有超限图片)', async () => {
    const bigPath = path.join(legacyDir, '..', `big-cached-${Date.now()}.png`);
    fs.writeFileSync(bigPath, Buffer.alloc(MAX_FILE_SIZE + 1));
    try {
      const media = makeMedia({
        getCachedImage: vi.fn(async () => ({ absPath: bigPath, url: CINDY_URL, mimeType: 'image/png' })),
      });
      wireHost({ media, files: makeFiles() });
      const { client, get } = makeClient(PNG_BYTES, 'image/png');

      const result = await downloadAttachments(client, 'om_1', [imageRef]);

      expect(get).not.toHaveBeenCalled();
      expect(result.attachments).toEqual([]);
      expect(result.unsupported).toEqual([expect.objectContaining({ type: 'oversize' })]);
    } finally {
      fs.rmSync(bigPath, { force: true });
    }
  });

  it('host 按字节核验拒收(如 svg): 标不支持, 不入仓', async () => {
    const media = makeMedia({
      cacheImage: vi.fn(async () => {
        throw new Error('IM inbound image bytes do not match a supported media type');
      }),
    });
    wireHost({ media, files: makeFiles() });
    const { client } = makeClient(Buffer.from('<svg/>'), 'image/svg+xml');

    const result = await downloadAttachments(client, 'om_1', [imageRef]);

    expect(result).toEqual({
      attachments: [],
      unsupported: [{ type: 'image', label: '不支持的图片格式（图片）' }],
    });
  });

  it('host 无媒体总仓:图片标不支持且不下载', async () => {
    wireHost({ files: makeFiles() });
    const { client, get } = makeClient(PNG_BYTES, 'image/png');

    const result = await downloadAttachments(client, 'om_1', [imageRef]);

    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ attachments: [], unsupported: [{ type: 'image', label: '图片' }] });
  });
});

describe('downloadAttachments: 文件 → host 暂存, 音视频 → 媒体总仓', () => {
  it('pdf 文件交 host.files.stage', async () => {
    const media = makeMedia();
    const files = makeFiles();
    wireHost({ media, files });
    const pdf = Buffer.from('%PDF-1.7');
    const { client, get } = makeClient(pdf, 'application/pdf');

    const result = await downloadAttachments(client, 'om_2', [pdfRef]);

    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_2', file_key: 'file_1' },
      params: { type: 'file' },
    });
    expect(files.stage).toHaveBeenCalledWith({ integration: 'feishu', buffer: pdf, fileName: 'report.pdf' });
    expect(media.cacheImage).not.toHaveBeenCalled();
    expect(media.cacheMedia).not.toHaveBeenCalled();
    expect(result).toEqual({
      attachments: [
        { kind: 'file', absPath: '/staged/report.pdf', originalName: 'report.pdf', mimeType: 'application/pdf' },
      ],
      unsupported: [],
    });
  });

  it('视频消息(video ref)入 cacheMedia; 非视频 content-type 归一为 video/mp4', async () => {
    const media = makeMedia();
    const files = makeFiles();
    wireHost({ media, files });
    const bytes = Buffer.from('mp4-bytes');
    const { client } = makeClient(bytes, 'application/octet-stream');

    const result = await downloadAttachments(client, 'om_3', [videoRef]);

    expect(media.cacheMedia).toHaveBeenCalledWith({
      integration: 'feishu',
      token: 'file_v',
      buffer: bytes,
      mimeType: 'video/mp4',
    });
    expect(files.stage).not.toHaveBeenCalled();
    expect(result).toEqual({
      attachments: [
        {
          kind: 'file',
          absPath: '/blobs/file_v.mp4',
          originalName: 'demo.mp4',
          mimeType: 'video/mp4',
          url: 'cindy-media://blobs/file_v.mp4',
        },
      ],
      unsupported: [],
    });
  });

  it('视频消息但 host 无 cacheMedia:标不支持且不下载', async () => {
    const imageOnly: IMHostMediaCache = { ...makeMedia(), cacheMedia: undefined };
    wireHost({ media: imageOnly, files: makeFiles() });
    const { client, get } = makeClient(Buffer.from('mp4'), 'video/mp4');

    const result = await downloadAttachments(client, 'om_3', [videoRef]);

    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ attachments: [], unsupported: [{ type: 'media', label: 'demo.mp4' }] });
  });

  it('以普通文件发来的音频:总仓拒收时标不支持, 不回落文件暂存', async () => {
    const media = makeMedia({
      cacheMedia: vi.fn(async () => {
        throw new Error('unsupported mime type');
      }),
    });
    const files = makeFiles();
    wireHost({ media, files });
    const { client } = makeClient(Buffer.from('flac'), 'audio/flac');

    const result = await downloadAttachments(client, 'om_4', [
      { kind: 'file', fileKey: 'file_a', fileName: 'song.flac' },
    ]);

    expect(media.cacheMedia).toHaveBeenCalledTimes(1);
    expect(files.stage).not.toHaveBeenCalled();
    expect(result).toEqual({ attachments: [], unsupported: [{ type: 'media', label: 'song.flac' }] });
  });

  it('响应没给类型(octet-stream)时按扩展名识别音视频, 送进媒体总仓', async () => {
    const media = makeMedia();
    const files = makeFiles();
    wireHost({ media, files });
    const { client } = makeClient(Buffer.from('mp4'), 'application/octet-stream');

    const result = await downloadAttachments(client, 'om_6', [
      { kind: 'file', fileKey: 'file_o', fileName: 'record.MP4' },
    ]);

    expect(files.stage).not.toHaveBeenCalled();
    expect(media.cacheMedia).toHaveBeenCalledWith(expect.objectContaining({ token: 'file_o', mimeType: 'video/mp4' }));
    expect(result.attachments).toEqual([expect.objectContaining({ originalName: 'record.MP4', mimeType: 'video/mp4' })]);
  });

  it('以普通文件发来的视频:host 没有 cacheMedia 时标不支持, 不进文件暂存', async () => {
    const media = makeMedia();
    delete (media as Partial<typeof media>).cacheMedia;
    const files = makeFiles();
    wireHost({ media, files });
    const { client } = makeClient(Buffer.from('mkv'), 'video/x-matroska');

    const result = await downloadAttachments(client, 'om_5', [
      { kind: 'file', fileKey: 'file_m', fileName: 'clip.mkv' },
    ]);

    expect(files.stage).not.toHaveBeenCalled();
    expect(result).toEqual({ attachments: [], unsupported: [{ type: 'media', label: 'clip.mkv' }] });
  });

  it('host 无文件暂存:普通文件标不支持且不下载', async () => {
    wireHost({ media: makeMedia() });
    const { client, get } = makeClient(Buffer.from('%PDF'), 'application/pdf');

    const result = await downloadAttachments(client, 'om_5', [pdfRef]);

    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ attachments: [], unsupported: [{ type: 'file', label: 'report.pdf' }] });
  });

  it('声明大小超过 30MB:标 oversize 且不下载', async () => {
    const files = makeFiles();
    wireHost({ media: makeMedia(), files });
    const { client, get } = makeClient(Buffer.from('big'), 'application/zip');
    const fileSize = MAX_FILE_SIZE + 1024 * 1024;

    const result = await downloadAttachments(client, 'om_6', [
      { kind: 'file', fileKey: 'file_big', fileName: 'big.zip', fileSize },
    ]);

    expect(get).not.toHaveBeenCalled();
    expect(files.stage).not.toHaveBeenCalled();
    expect(result).toEqual({
      attachments: [],
      unsupported: [{ type: 'oversize', label: 'big.zip 超过 30MB（实际 31.0MB）' }],
    });
  });

  it('单个附件失败不挡其余附件', async () => {
    const media = makeMedia();
    const files = makeFiles();
    files.stage.mockRejectedValueOnce(new Error('disk full'));
    wireHost({ media, files });
    const get = vi.fn(async ({ params }: { params: { type: string } }) => ({
      getReadableStream: () => Readable.from([params.type === 'image' ? PNG_BYTES : Buffer.from('pdf')]),
      headers: { 'content-type': params.type === 'image' ? 'image/png' : 'application/pdf' },
    }));
    const client = { im: { v1: { messageResource: { get } } } } as unknown as Lark.Client;

    const result = await downloadAttachments(client, 'om_7', [pdfRef, imageRef]);

    expect(result.unsupported).toEqual([
      { type: 'download_failed:file', label: '下载失败 report.pdf（disk full）' },
    ]);
    expect(result.attachments).toEqual([expect.objectContaining({ kind: 'image', absPath: '/blobs/img_1.png' })]);
  });
});

describe('downloadAttachments: 账号换代与群历史', () => {
  function switchableScope() {
    let current = 1;
    return {
      scope: {
        capture: () => current,
        isCurrent: (token: unknown) => token === current,
        run: async <T,>(_token: unknown, op: () => Promise<T>) => op(),
      },
      switchAccount: () => {
        current += 1;
      },
    };
  }

  it('下载期间换账号: 不写入 host, 标为下载失败', async () => {
    const files = makeFiles();
    const { scope, switchAccount } = switchableScope();
    wireHost({ media: makeMedia(), files, accountScope: scope });
    const get = vi.fn(async () => {
      switchAccount();
      return { getReadableStream: () => Readable.from([Buffer.from('pdf')]), headers: { 'content-type': 'application/pdf' } };
    });
    const client = { im: { v1: { messageResource: { get } } } } as unknown as Lark.Client;

    const result = await downloadAttachments(client, 'om_1', [pdfRef]);

    expect(files.stage).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([]);
    expect(result.unsupported).toEqual([expect.objectContaining({ type: 'download_failed:file' })]);
  });

  it('写入 host 后才发现换账号: 回滚本次暂存', async () => {
    const { scope, switchAccount } = switchableScope();
    const discard = vi.fn(async () => {});
    const files = {
      stage: vi.fn<IMHostFileStaging['stage']>(async ({ fileName }) => {
        switchAccount();
        return { absPath: `/staged/${fileName}`, discard };
      }),
    };
    wireHost({ media: makeMedia(), files, accountScope: scope });
    const { client } = makeClient(Buffer.from('pdf'), 'application/pdf');

    const result = await downloadAttachments(client, 'om_1', [pdfRef]);

    expect(discard).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([]);
  });

  it('图片写入期间换账号: 回滚本次缓存写入', async () => {
    const { scope, switchAccount } = switchableScope();
    const discard = vi.fn(async () => {});
    const media = makeMedia({
      cacheImage: vi.fn(async () => {
        switchAccount();
        return { absPath: '/blobs/img_1.png', url: CINDY_URL, discard };
      }),
    });
    wireHost({ media, files: makeFiles(), accountScope: scope });
    const { client } = makeClient(PNG_BYTES, 'image/png');

    const result = await downloadAttachments(client, 'om_1', [imageRef], { history: true });

    expect(discard).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([]);
  });

  it('普通(非群历史)图片写入期间换账号: 同样回滚', async () => {
    const { scope, switchAccount } = switchableScope();
    const discard = vi.fn(async () => {});
    const media = makeMedia({
      cacheImage: vi.fn(async () => {
        switchAccount();
        return { absPath: '/blobs/img_1.png', url: CINDY_URL, discard };
      }),
    });
    wireHost({ media, files: makeFiles(), accountScope: scope });
    const { client } = makeClient(PNG_BYTES, 'image/png');

    const result = await downloadAttachments(client, 'om_1', [imageRef]);

    expect(media.cacheImage).toHaveBeenCalledWith(expect.objectContaining({ staging: true }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([]);
  });

  it('以普通文件发来、响应没给类型的图片: 按扩展名进媒体总仓, 不进文件暂存', async () => {
    const media = makeMedia();
    const files = makeFiles();
    wireHost({ media, files });
    const { client } = makeClient(PNG_BYTES, 'application/octet-stream');

    const result = await downloadAttachments(client, 'om_8', [
      { kind: 'file', fileKey: 'file_p', fileName: 'scan.PNG' },
    ]);

    expect(files.stage).not.toHaveBeenCalled();
    expect(media.cacheImage).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'file_p', mimeType: 'image/png', staging: true }),
    );
    expect(result.attachments).toEqual([expect.objectContaining({ kind: 'image', originalName: 'scan.PNG' })]);
  });

  it('批次最后一项写完后才换账号: 整批已写入的一并回滚', async () => {
    const { scope, switchAccount } = switchableScope();
    const discards = [vi.fn(async () => {}), vi.fn(async () => {})];
    let n = 0;
    const files = {
      stage: vi.fn<IMHostFileStaging['stage']>(async ({ fileName }) => ({
        absPath: `/staged/${fileName}`,
        discard: discards[n++]!,
      })),
    };
    wireHost({ media: makeMedia(), files, accountScope: scope });
    const get = vi.fn(async () => ({
      getReadableStream: () => Readable.from([Buffer.from('pdf')]),
      headers: { 'content-type': 'application/pdf' },
    }));
    const client = { im: { v1: { messageResource: { get } } } } as unknown as Lark.Client;
    const second = { kind: 'file' as const, fileKey: 'file_2', fileName: 'b.pdf' };
    // 第二项写入完成、逐项复查通过之后, 收口前换代。
    files.stage.mockImplementationOnce(async ({ fileName }) => ({ absPath: `/staged/${fileName}`, discard: discards[n++]! }));
    files.stage.mockImplementationOnce(async ({ fileName }) => {
      const result = { absPath: `/staged/${fileName}`, discard: discards[n++]! };
      queueMicrotask(switchAccount);
      return result;
    });

    const result = await downloadAttachments(client, 'om_9', [pdfRef, second]);

    expect(discards[0]).toHaveBeenCalledTimes(1);
    expect(discards[1]).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([]);
    expect(result.unsupported).toHaveLength(2);
  });

  it('群历史: 图片按可回收缓存写入, 不复用/固定已有缓存', async () => {
    const media = makeMedia({
      getCachedImage: vi.fn(async () => ({ absPath: '/blobs/hit.png', url: CINDY_URL, mimeType: 'image/png' })),
    });
    wireHost({ media, files: makeFiles() });
    const { client } = makeClient(PNG_BYTES, 'image/png');

    const result = await downloadAttachments(client, 'om_1', [imageRef], { history: true });

    expect(media.getCachedImage).not.toHaveBeenCalled();
    expect(media.cacheImage).toHaveBeenCalledWith(expect.objectContaining({ staging: true }));
    expect(result.attachments).toHaveLength(1);
  });
});
