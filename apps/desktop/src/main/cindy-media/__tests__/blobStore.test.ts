/**
 * blobStore.test.ts — cindy-media 字节仓单测。
 * 覆盖:内容寻址写入(指纹/分桶/幂等去重)、URL 形状校验(指纹正则 + 扩展名
 * 白名单,爬目录类输入一律拒)、resolveSafe 仓内双保险、读回一致性。
 * 文件落 os.tmpdir() 临时目录并收尾清理(规则 23:凭证不入仓同族约束)。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpUserData = '';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

const blobStore = await import('../blobStore');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_HASH = createHash('sha256').update(PNG_BYTES).digest('hex');

beforeAll(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-media-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

describe('writeBlob(内容寻址写入)', () => {
  it('支持 Telegram voice 使用的 Ogg/Opus 容器 MIME', () => {
    expect(blobStore.supportedMime('audio/ogg')).toBe(true);
    expect(blobStore.mimeForExt('.ogg')).toBe('audio/ogg');
  });

  it('按指纹分桶落盘,返回稳定 URL', async () => {
    const written = await blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(written.hash).toBe(PNG_HASH);
    expect(written.ext).toBe('.png');
    expect(written.url).toBe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(written.deduplicated).toBe(false);
    const expected = path.join(
      tmpUserData,
      'cindy-media',
      'blobs',
      PNG_HASH.slice(0, 2),
      `${PNG_HASH}.png`,
    );
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('同内容重复写入 = 去重命中,不产生第二份', async () => {
    const again = await blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(again.deduplicated).toBe(true);
    expect(again.hash).toBe(PNG_HASH);
    const shard = path.join(tmpUserData, 'cindy-media', 'blobs', PNG_HASH.slice(0, 2));
    expect(fs.readdirSync(shard)).toHaveLength(1);
  });

  it('空字节 / 未知类型拒绝', async () => {
    await expect(
      blobStore.writeBlob({ buffer: new Uint8Array(0), mimeType: 'image/png' }),
    ).rejects.toThrow('empty buffer');
    await expect(
      blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'application/x-msdownload' }),
    ).rejects.toThrow('unsupported mime');
  });
});

describe('parseBlobUrl / resolveSafe(取件形状校验)', () => {
  it('合法地址往返解析', () => {
    const parsed = blobStore.parseBlobUrl(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(parsed).toEqual({ hash: PNG_HASH, ext: '.png' });
    const resolved = blobStore.resolveSafe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(resolved.hash).toBe(PNG_HASH);
    expect(resolved.mimeType).toBe('image/png');
    const root = path.resolve(path.join(tmpUserData, 'cindy-media', 'blobs'));
    expect(resolved.absPath.startsWith(root + path.sep)).toBe(true);
  });

  it('指纹形状不合 / 扩展名不在白名单 / 其它 host 一律拒', () => {
    for (const bad of [
      'cindy-media://blobs/short.png', // 非 64 位指纹
      `cindy-media://blobs/${PNG_HASH.toUpperCase()}.png`, // 大写不收
      `cindy-media://blobs/${PNG_HASH}.exe`, // 扩展名白名单外
      `cindy-media://blobs/${PNG_HASH}`, // 无扩展名
      `cindy-media://other/${PNG_HASH}.png`, // 未知 host
      'cindy-media://blobs/../../secrets.png', // 爬目录企图(形状即拒)
      `xdt-image://blobs/${PNG_HASH}.png`, // 别家协议
      'not-a-url',
    ]) {
      expect(blobStore.parseBlobUrl(bad)).toBeNull();
      expect(() => blobStore.resolveSafe(bad)).toThrow();
    }
  });

  it('拒绝为同一 blob 制造缓存别名的 URL 附加部分', () => {
    const canonical = `cindy-media://blobs/${PNG_HASH}.png`;
    for (const alias of [
      `${canonical}?nonce=1`,
      `${canonical}?`,
      `${canonical}#preview`,
      `${canonical}#`,
      `cindy-media://user@blobs/${PNG_HASH}.png`,
      `cindy-media://blobs:443/${PNG_HASH}.png`,
      `cindy-media://blobs/${PNG_HASH}.PNG`,
      `cindy-media://@blobs/${PNG_HASH}.png`,
      `cindy-media://blobs:/${PNG_HASH}.png`,
      `cindy-media://blobs/a/../${PNG_HASH}.png`,
    ]) {
      expect(blobStore.parseBlobUrl(alias)).toBeNull();
      expect(() => blobStore.resolveSafe(alias)).toThrow('invalid url');
    }
  });

  it('resolveHashRef 拒绝非法指纹与扩展名(供图分支复用同一校验)', () => {
    expect(() => blobStore.resolveHashRef('..', '.png')).toThrow('invalid hash');
    expect(() => blobStore.resolveHashRef(PNG_HASH, '.sh')).toThrow('unsupported ext');
    const ok = blobStore.resolveHashRef(PNG_HASH, '.png');
    expect(ok.mimeType).toBe('image/png');
  });
});

describe('readFile(读回一致性)', () => {
  it('读回的字节与写入完全一致', async () => {
    const { buffer, mimeType } = await blobStore.readFile(
      `cindy-media://blobs/${PNG_HASH}.png`,
    );
    expect(mimeType).toBe('image/png');
    expect(Buffer.compare(buffer, PNG_BYTES)).toBe(0);
  });

  it('查无此文件 → ENOENT 上抛(协议层译 404)', async () => {
    const missing = createHash('sha256').update('missing').digest('hex');
    await expect(
      blobStore.readFile(`cindy-media://blobs/${missing}.png`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
