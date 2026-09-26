/**
 * feishu/attachmentDownloader.test.ts — 下载增量上限回归。
 *
 * 修复前:附件先经 streamToBuffer 整只进内存(并写盘),之后才被 30MB 检查
 * 归为 oversize —— 超大文件的内存峰值与文件本身一样大,Electron main 直扛。
 * 修复后:流式累计超限立刻断流抛 ATTACHMENT_OVERSIZE,downloadAttachments
 * 把它归入 oversize(与"下载完成后才发现超限"同一收口),其余附件不受影响。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadAttachments, MAX_FILE_SIZE } from '../attachmentDownloader.js';
import { ATTACHMENT_OVERSIZE_CODE, streamToBuffer } from '../mediaStore.js';
import { setHost } from '../moduleScope.js';
import { defaultLogger } from '../../logger.js';
import type { IMHost } from '../../types.js';

const tmpRoots: string[] = [];
let currentMediaDir = '';

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-att-downloader-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  currentMediaDir = tempDir();
  const host = {
    paths: { feishuMediaDir: currentMediaDir },
    secrets: {
      isAvailable: () => false,
      write: () => false,
      read: () => null,
      remove: () => {},
    },
  } as unknown as IMHost;
  setHost(host, defaultLogger('im:feishu:test'));
});

function streamOfChunks(chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

describe('streamToBuffer 增量上限', () => {
  it('未超限时行为不变', async () => {
    const buf = await streamToBuffer(streamOfChunks([Buffer.from('ab'), Buffer.from('cd')]), 4);
    expect(buf.toString()).toBe('abcd');
  });

  it('累计超限立刻断流并抛 ATTACHMENT_OVERSIZE,不再拉取后续 chunk', async () => {
    // Greptile review:只观察 close 不能证明"停止读取"(异常分支无论如何都会
    // destroy)。用异步生成器做严格按需的源(每次迭代只产一个值, 无 Readable
    // 内部预取), 断言超限后源头不再被拉取。
    const chunks = [
      Buffer.alloc(10),
      Buffer.alloc(10),
      Buffer.alloc(10),
      Buffer.alloc(10),
    ];
    let pulled = 0;
    async function* demandDriven(): AsyncGenerator<Buffer> {
      for (const buf of chunks) {
        pulled += 1;
        yield buf;
      }
    }
    await expect(
      streamToBuffer(demandDriven() as unknown as NodeJS.ReadableStream, 25),
    ).rejects.toMatchObject({ code: ATTACHMENT_OVERSIZE_CODE });
    // 3 个 chunk(30B)就超 25B 上限;第 4 个永远不该被拉取。
    expect(pulled).toBe(3);
    // 30MB 上限必须真的传到了下载层。
    expect(MAX_FILE_SIZE).toBe(30 * 1024 * 1024);
  });
});

function fakeClientReturning(chunks: Buffer[]): never {
  const get = vi.fn(async () => ({
    getReadableStream: () => streamOfChunks(chunks),
    headers: { 'content-type': 'application/octet-stream' },
  }));
  return { im: { v1: { messageResource: { get } } } } as never;
}

describe('downloadAttachments 超限收口', () => {
  it('中途触顶归为 oversize,不再整只下载,同批其余附件继续处理', async () => {
    const oversize = [
      Buffer.alloc(MAX_FILE_SIZE - 4),
      Buffer.alloc(16),
      Buffer.alloc(1024),
    ];
    // Greptile review:同批加入一个正常附件,锁定超限分支 continue 后
    // 仍处理后续附件(若未来改成 break/return,该附件会丢)。
    const client = {
      im: {
        v1: {
          messageResource: {
            get: vi.fn()
              .mockImplementationOnce(async () => ({
                getReadableStream: () => streamOfChunks([...oversize]),
                headers: { 'content-type': 'application/octet-stream' },
              }))
              .mockImplementationOnce(async () => ({
                getReadableStream: () => streamOfChunks([Buffer.from('tiny-file-bytes')]),
                headers: { 'content-type': 'text/plain' },
              })),
          },
        },
      },
    } as never;

    const result = await downloadAttachments(client, 'm1', [
      { kind: 'file', fileKey: 'big-key', fileName: 'big.bin' },
      { kind: 'file', fileKey: 'small-key', fileName: 'small.txt' },
    ]);

    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]?.type).toBe('oversize');
    expect(result.unsupported[0]?.label).toContain('big.bin');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.absPath).toContain('small-key');
    // 媒体目录只落正常附件(旧路径会先整只写盘再判超)。
    const filesDir = fs.readdirSync(path.join(currentMediaDir, 'files'));
    expect(filesDir).toEqual([expect.stringContaining('small-key')]);
  });

  it('正常小附件路径不受影响', async () => {
    const client = fakeClientReturning([Buffer.from('tiny-file-bytes')]);
    const result = await downloadAttachments(client, 'm2', [
      { kind: 'file', fileKey: 'small-key', fileName: 'small.txt' },
    ]);
    expect(result.unsupported).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.absPath).toContain('small-key');
    expect(result.attachments[0]?.kind).toBe('file');
  });
});
