import { beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  sha256MobileAttachmentBody,
  sha256MobileAttachmentFile,
} from '@/session/mobileAttachmentSha256';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('mobile attachment SHA-256', () => {
  it('matches a known vector for Blob uploads', async () => {
    await expect(sha256MobileAttachmentBody(new Blob(['abc']), 3)).resolves.toBe(ABC_SHA256);
  });

  it('reads files in bounded chunks and hashes the exact bytes', async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x5a);
    const readChunk = vi.fn(async (_uri: string, position: number, length: number) =>
      bytes.subarray(position, position + length).toString('base64'),
    );

    const digest = await sha256MobileAttachmentFile('file:///attachment.bin', bytes.length, {
      readChunk,
    });

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readChunk).toHaveBeenCalledTimes(2);
    expect(readChunk.mock.calls[0]?.slice(1)).toEqual([0, 1024 * 1024]);
    expect(readChunk.mock.calls[1]?.slice(1)).toEqual([1024 * 1024, 17]);
  });

  it('rejects truncated chunks before upload', async () => {
    const readChunk = vi.fn(async () => Buffer.from('ab').toString('base64'));
    await expect(
      sha256MobileAttachmentFile('file:///attachment.bin', 3, { readChunk }),
    ).rejects.toThrow(/文件读取不完整/);
  });
});
