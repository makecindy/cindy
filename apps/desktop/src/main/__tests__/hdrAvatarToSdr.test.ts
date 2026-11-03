/**
 * hdrAvatarToSdr 单测:用 macOS ImageIO 真实编码的 HDR 夹具(PQ / HLG PNG、PQ JPEG、
 * ISO 21496-1 增益图 JPEG,来源见 fixtures/hdr-avatar/make-hdr-avatar-fixtures.swift)
 * 跑真实 sharp 转换,并对输出字节逐项断言:不再携带 HDR 信号,且像素确为 SDR 色调映射
 * 结果。夹具场景为线性光水平渐变 0 → 8×SDR 白(x / 255 × 8),上半中性、下半暖色。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  readIccCicp,
  readPngHdrChunks,
  toSdrAvatarImage,
} from '../hdrAvatarToSdr';

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', 'hdr-avatar', name));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}
/** 在 IHDR 之后插入块(IHDR 固定占 8 + 25 字节)。 */
function insertAfterIhdr(png: Buffer, ...chunks: Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}
function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    types.push(png.toString('latin1', offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

const PQ = (nits: number) => {
  const m1 = 2610 / 16384,
    m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096,
    c2 = (2413 / 4096) * 32,
    c3 = (2392 / 4096) * 32;
  const y = Math.pow(nits / 10_000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
};

/** 16-bit RGBA PQ(BT.709 原色)PNG,仅靠 cICP 块声明 HDR,不带 ICC。 */
async function syntheticPqPng(
  pixels: Array<{ nits: [number, number, number]; alpha: number }>,
  options: { cicp?: [number, number, number, number]; cllNits?: number; orientation?: number } = {},
) {
  const raw = new Uint16Array(pixels.length * 4);
  pixels.forEach(({ nits, alpha }, index) => {
    raw.set([...nits.map((value) => Math.round(PQ(value) * 65535)), alpha], index * 4);
  });
  let encoder = sharp(raw, { raw: { width: pixels.length, height: 1, channels: 4 } }).toColourspace(
    'rgb16',
  );
  if (options.orientation) encoder = encoder.withMetadata({ orientation: options.orientation });
  const png = await encoder.png().toBuffer();
  const extra = [pngChunk('cICP', Buffer.from(options.cicp ?? [1, 16, 0, 1]))];
  if (options.cllNits) {
    const clli = Buffer.alloc(8);
    clli.writeUInt32BE(options.cllNits * 10_000, 0);
    extra.push(pngChunk('cLLI', clli));
  }
  return insertAfterIhdr(png, ...extra);
}

/** 仿 Apple HDR gain map 的字节:SDR 主图后追加一张带 hdrgainmap XMP 的辅助图(无 libvips 可解析的增益图结构)。 */
async function appleGainMapJpeg(width: number, height: number): Promise<Buffer> {
  const primary = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const xmp = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap"/></x:xmpmeta>',
    'latin1',
  );
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(xmp.length + 2, 2);
  const auxiliary = await sharp(Buffer.alloc(8 * 8 * 3, 90), {
    raw: { width: 8, height: 8, channels: 3 },
  })
    .jpeg()
    .toBuffer();
  const secondary = Buffer.concat([auxiliary.subarray(0, 2), app1, xmp, auxiliary.subarray(2)]);
  return Buffer.concat([primary, secondary]);
}

async function rgbaAt(buffer: Buffer, xs: number[], y = 0) {
  const { data, info } = await sharp(buffer)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return xs.map((x) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]);
}

/** 输出必须是 8-bit、无 HDR 信号(ICC cicp / PNG cICP / 增益图签名)的普通 SDR 图。 */
async function expectNoHdrSignal(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  expect(metadata.depth).toBe('uchar');
  expect(metadata.gainMap).toBeUndefined();
  expect(readIccCicp(metadata.icc)?.transfer ?? 0).not.toBeOneOf([16, 18]);
  if (metadata.format === 'png') expect(readPngHdrChunks(buffer).cicp).toBeNull();
  for (const signature of ['urn:iso:std:iso:ts:21496:-1', 'hdr-gain-map', 'aux:hdrgainmap']) {
    expect(buffer.includes(signature)).toBe(false);
  }
  return metadata;
}

// 夹具渐变上的采样列与其场景线性值:0, 0.25, 0.5, 1.0(SDR 白), 4.0, 8.0。
const RAMP_XS = [0, 8, 16, 32, 128, 255];

describe('toSdrAvatarImage — PQ / HLG', () => {
  it.each([
    ['pq-bt2100.png', 'image/png', 16],
    ['hlg-bt2100.png', 'image/png', 18],
    ['pq-bt2100.jpg', 'image/jpeg', 16],
  ])('%s is tone mapped to 8-bit sRGB without HDR signalling', async (name, mimeType, transfer) => {
    const input = fixture(name);
    const inputMetadata = await sharp(input).metadata();
    expect(readIccCicp(inputMetadata.icc)?.transfer).toBe(transfer);

    const output = await toSdrAvatarImage({ buffer: input, mimeType });
    expect(output.mimeType).toBe(mimeType);
    const metadata = await expectNoHdrSignal(output.buffer);
    expect(metadata.hasProfile).toBe(false);
    expect([metadata.width, metadata.height]).toEqual([inputMetadata.width, inputMetadata.height]);

    const neutral = (await rgbaAt(output.buffer, RAMP_XS, 10)).map(([r]) => r!);
    // 中间调与 macOS 自身 SDR 渲染(sdr-display-p3.png:0.25 → 137, 0.5 → 188)一致;
    // SDR 白保持接近白而不是被整体压暗;高光平滑滚降到 255 而非按 PQ 码值显示成灰色。
    expect(neutral[0]).toBeLessThanOrEqual(2);
    expect(Math.abs(neutral[1]! - 137)).toBeLessThanOrEqual(3);
    expect(Math.abs(neutral[2]! - 188)).toBeLessThanOrEqual(3);
    expect(neutral[3]).toBeGreaterThanOrEqual(238);
    expect(neutral[3]).toBeLessThan(250);
    expect(neutral[5]).toBeGreaterThanOrEqual(252);
    for (let index = 1; index < neutral.length; index++) {
      expect(neutral[index]).toBeGreaterThanOrEqual(neutral[index - 1]! - 1);
    }
    // 暖色行在 SDR 白处保持 R > G > B 的色相(线性 1 : 0.6 : 0.3)。
    const [, , , [r, g, b]] = await rgbaAt(output.buffer, RAMP_XS, 100);
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
    expect(Math.abs(g! - 194)).toBeLessThanOrEqual(8);
  });

  it('reads cICP-only PNGs, honours cLLI, and keeps transparency', async () => {
    const pixels = [
      { nits: [203, 203, 203] as [number, number, number], alpha: 65535 },
      { nits: [600, 600, 600] as [number, number, number], alpha: 32768 },
      { nits: [50, 10, 2] as [number, number, number], alpha: 0 },
    ];
    const input = await syntheticPqPng(pixels);
    expect(pngChunkTypes(input)).toContain('cICP');
    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/png' });
    await expectNoHdrSignal(output.buffer);
    expect(pngChunkTypes(output.buffer)).not.toContain('cICP');
    const [white, bright, dim] = await rgbaAt(output.buffer, [0, 1, 2]);
    expect(white![3]).toBe(255);
    expect(bright![3]).toBe(128);
    expect(dim![3]).toBe(0);
    expect(white![0]).toBeGreaterThanOrEqual(238);
    expect(bright![0]).toBeGreaterThan(white![0]!);

    // 声明的内容峰值更高时,同样 600 nit 会被压得更多(更暗)。
    const brighterMaster = await toSdrAvatarImage({
      buffer: await syntheticPqPng(pixels, { cllNits: 4000 }),
      mimeType: 'image/png',
    });
    const [, brightUnderHigherPeak] = await rgbaAt(brighterMaster.buffer, [0, 1, 2]);
    expect(brightUnderHigherPeak![0]).toBeLessThan(bright![0]!);
  });

  it('bakes EXIF orientation into converted pixels', async () => {
    const input = await syntheticPqPng(
      [
        { nits: [203, 0, 0], alpha: 65535 },
        { nits: [0, 0, 203], alpha: 65535 },
      ],
      { orientation: 6 },
    );
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/png' });
    const metadata = await sharp(output.buffer).metadata();
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([1, 2, undefined]);
    const [[top], [bottom]] = [
      await rgbaAt(output.buffer, [0], 0),
      await rgbaAt(output.buffer, [0], 1),
    ];
    // Orientation 6 = 顺时针 90°:原来最左的红色像素到顶部。
    expect(top![0]).toBeGreaterThan(200);
    expect(bottom![2]).toBeGreaterThan(200);
  });

  it('converts WebP whose ICC profile declares PQ', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hdr-avatar-'));
    try {
      const iccPath = path.join(dir, 'pq.icc');
      await writeFile(iccPath, (await sharp(fixture('pq-bt2100.png')).metadata()).icc!);
      const input = await sharp(Buffer.alloc(16 * 16 * 3, 200), {
        raw: { width: 16, height: 16, channels: 3 },
      })
        .withIccProfile(iccPath)
        .webp({ quality: 95 })
        .toBuffer();
      expect(readIccCicp((await sharp(input).metadata()).icc)?.transfer).toBe(16);
      const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/webp' });
      expect(output.mimeType).toBe('image/webp');
      expect((await expectNoHdrSignal(output.buffer)).hasProfile).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adapts DCI-P3 (primaries 11) from the DCI white point instead of treating it as P3-D65', async () => {
    const pixels = [
      { nits: [100, 100, 100] as [number, number, number], alpha: 65535 },
      { nits: [100, 20, 20] as [number, number, number], alpha: 65535 },
    ];
    const convert = async (primaries: number) =>
      rgbaAt(
        (
          await toSdrAvatarImage({
            buffer: await syntheticPqPng(pixels, { cicp: [primaries, 16, 0, 1] }),
            mimeType: 'image/png',
          })
        ).buffer,
        [0, 1],
      );
    const [[dciNeutral, dciRed], [, p3d65Red]] = [await convert(11), await convert(12)];
    // 色适应后 DCI 白仍映射为中性色;饱和色则因白点不同而与 P3-D65 结果不同。
    expect(
      Math.max(...dciNeutral!.slice(0, 3)) - Math.min(...dciNeutral!.slice(0, 3)),
    ).toBeLessThanOrEqual(1);
    expect(dciRed!.slice(0, 3)).not.toEqual(p3d65Red!.slice(0, 3));
  });

  it('converts every H.273 primaries code it supports with its own gamut and rejects the rest', async () => {
    const pixels = [
      { nits: [100, 100, 100] as [number, number, number], alpha: 65535 },
      { nits: [20, 100, 20] as [number, number, number], alpha: 65535 },
    ];
    const convert = async (primaries: number) =>
      rgbaAt(
        (
          await toSdrAvatarImage({
            buffer: await syntheticPqPng(pixels, { cicp: [primaries, 16, 0, 1] }),
            mimeType: 'image/png',
          })
        ).buffer,
        [0, 1],
      );
    const results = new Map<number, number[][]>();
    for (const code of [1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 22]) {
      const [neutral, green] = await convert(code);
      // 各自白点（含光源 C）适应到 D65 后中性色仍为中性。
      expect(
        Math.max(...neutral!.slice(0, 3)) - Math.min(...neutral!.slice(0, 3)),
      ).toBeLessThanOrEqual(1);
      results.set(code, [neutral!.slice(0, 3), green!.slice(0, 3)]);
    }
    // 未指定(2)按 BT.2020;显式声明的其它原色不再被当作 BT.2020。
    expect(results.get(2)).toEqual(results.get(9));
    for (const code of [5, 6, 22]) expect(results.get(code)![1]).not.toEqual(results.get(9)![1]);
    expect(results.get(6)).toEqual(results.get(7));

    for (const code of [0, 3, 10, 13, 23, 255]) {
      await expect(
        toSdrAvatarImage({
          buffer: await syntheticPqPng(pixels, { cicp: [code, 16, 0, 1] }),
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(/INVALID_PARAMS.*primaries/);
    }
  });

  it('downscales large PQ sources to at most 2048² before tone mapping', async () => {
    const [width, height] = [3000, 1500];
    const raw = new Uint16Array(width * height * 3).fill(Math.round(PQ(203) * 65535));
    const input = insertAfterIhdr(
      await sharp(raw, { raw: { width, height, channels: 3 } }).toColourspace('rgb16').png().toBuffer(),
      pngChunk('cICP', Buffer.from([1, 16, 0, 1])),
    );
    const metadata = await expectNoHdrSignal(
      (await toSdrAvatarImage({ buffer: input, mimeType: 'image/png' })).buffer,
    );
    expect(metadata.width! * metadata.height!).toBeLessThanOrEqual(2048 * 2048);
    expect(Math.abs(metadata.width! / metadata.height! - 2)).toBeLessThan(0.01);
  });

  it('rejects HDR sources whose declared dimensions exceed the limit before decoding', async () => {
    const png = await syntheticPqPng([{ nits: [203, 203, 203], alpha: 65535 }]);
    // 改写 IHDR 宽高(1 亿 / 4 亿像素),文件仍只有几百字节;后者超过 sharp 默认像素上限。
    for (const side of [10_000, 20_000]) {
      const ihdr = Buffer.from(png.subarray(16, 29));
      ihdr.writeUInt32BE(side, 0);
      ihdr.writeUInt32BE(side, 4);
      const inflated = Buffer.concat([
        png.subarray(0, 8),
        pngChunk('IHDR', ihdr),
        png.subarray(33),
      ]);
      await expect(toSdrAvatarImage({ buffer: inflated, mimeType: 'image/png' })).rejects.toThrow(
        /INVALID_PARAMS.*dimensions exceed/,
      );
    }
  });

  it('rejects HDR bytes it cannot decode instead of storing them unchanged', async () => {
    const valid = await syntheticPqPng([{ nits: [203, 203, 203], alpha: 65535 }]);
    const truncated = valid.subarray(0, valid.length - 20);
    await expect(toSdrAvatarImage({ buffer: truncated, mimeType: 'image/png' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('rejects animated HDR instead of flattening it to the first frame, and leaves animated SDR alone', async () => {
    const frames = await Promise.all(
      ['#c80000', '#0000c8'].map((background) =>
        sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer(),
      ),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hdr-avatar-'));
    try {
      const iccPath = path.join(dir, 'pq.icc');
      await writeFile(iccPath, (await sharp(fixture('pq-bt2100.png')).metadata()).icc!);
      const animatedWebp = (withPq: boolean) => {
        const pipeline = sharp(frames, { join: { animated: true } });
        return (withPq ? pipeline.withIccProfile(iccPath) : pipeline).webp().toBuffer();
      };
      const hdrWebp = await animatedWebp(true);
      const hdrWebpMetadata = await sharp(hdrWebp).metadata();
      expect(hdrWebpMetadata.pages).toBe(2);
      expect(readIccCicp(hdrWebpMetadata.icc)?.transfer).toBe(16);
      await expect(toSdrAvatarImage({ buffer: hdrWebp, mimeType: 'image/webp' })).rejects.toThrow(
        /INVALID_PARAMS.*Animated/,
      );
      const sdrWebp = { buffer: await animatedWebp(false), mimeType: 'image/webp' };
      expect(await toSdrAvatarImage(sdrWebp)).toBe(sdrWebp);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // APNG:acTL 声明 2 帧;libvips 只解码默认图像,转换会丢掉其余帧。
    const acTL = pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
    const hdrApng = insertAfterIhdr(
      await syntheticPqPng([{ nits: [203, 203, 203], alpha: 65535 }]),
      acTL,
    );
    expect(readPngHdrChunks(hdrApng).animated).toBe(true);
    await expect(toSdrAvatarImage({ buffer: hdrApng, mimeType: 'image/png' })).rejects.toThrow(
      /INVALID_PARAMS.*Animated/,
    );
    const sdrApng = { buffer: insertAfterIhdr(frames[0]!, acTL), mimeType: 'image/png' };
    expect(await toSdrAvatarImage(sdrApng)).toBe(sdrApng);
  });
});

describe('toSdrAvatarImage — gain maps', () => {
  it('drops an ISO 21496-1 gain map and keeps the SDR base rendition', async () => {
    const input = fixture('iso-gainmap.jpg');
    const inputMetadata = await sharp(input).metadata();
    expect(inputMetadata.gainMap).toBeDefined();
    expect(input.includes('urn:iso:std:iso:ts:21496:-1')).toBe(true);

    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/jpeg' });
    expect(output.mimeType).toBe('image/jpeg');
    const metadata = await expectNoHdrSignal(output.buffer);
    // 主图的 Display P3 ICC 原样保留,SDR 颜色不被改写。
    expect(metadata.icc?.equals(inputMetadata.icc!)).toBe(true);
    expect([metadata.width, metadata.height]).toEqual([inputMetadata.width, inputMetadata.height]);
    const before = await rgbaAt(input, RAMP_XS, 100);
    const after = await rgbaAt(output.buffer, RAMP_XS, 100);
    after.forEach((pixel, index) => {
      pixel.slice(0, 3).forEach((value, channel) => {
        expect(Math.abs(value - before[index]![channel]!)).toBeLessThanOrEqual(6);
      });
    });
  });

  it('treats only a parsed gain-map structure as HDR, not gain-map strings in metadata', async () => {
    const sdr = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#5a5a5a' } })
      .jpeg()
      .toBuffer();
    const segment = (marker: number, text: string) => {
      const body = Buffer.from(text, 'latin1');
      const header = Buffer.alloc(4);
      header.writeUInt16BE(marker, 0);
      header.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([header, body]);
    };
    const withSegment = (marker: number, text: string) =>
      Buffer.concat([sdr.subarray(0, 2), segment(marker, text), sdr.subarray(2)]);
    for (const buffer of [
      // XMP 里声明了 Ultra HDR 命名空间,但没有增益图。
      withSegment(0xffe1, '<x:xmpmeta xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"/>'),
      // JPEG 注释里出现 ISO 21496-1 URN。
      withSegment(0xfffe, 'urn:iso:std:iso:ts:21496:-1'),
      // 末尾附带 Apple 辅助图 XMP,但没有 libvips 可解析的增益图结构。
      await appleGainMapJpeg(8, 8),
    ]) {
      expect((await sharp(buffer).metadata()).gainMap).toBeUndefined();
      const image = { buffer, mimeType: 'image/jpeg' };
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });
});

describe('toSdrAvatarImage — SDR passthrough', () => {
  it('returns SDR inputs byte-for-byte, including wide-gamut and 16-bit PNG', async () => {
    const sdrP3 = fixture('sdr-display-p3.png');
    // ImageIO 自身的 SDR 渲染:16-bit、Display P3、cICP 声明 sRGB 传递函数(13)。
    expect(readPngHdrChunks(sdrP3).cicp).toMatchObject({ primaries: 12, transfer: 13 });
    const oriented = await sharp(Buffer.alloc(4 * 2 * 3, 120), {
      raw: { width: 4, height: 2, channels: 3 },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const transparentWebp = await sharp(Buffer.alloc(4 * 4 * 4, 80), {
      raw: { width: 4, height: 4, channels: 4 },
    })
      .webp()
      .toBuffer();
    for (const [buffer, mimeType] of [
      [sdrP3, 'image/png'],
      [oriented, 'image/jpeg'],
      [transparentWebp, 'image/webp'],
    ] as const) {
      const image = { buffer, mimeType };
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });

  it('rejects unparseable headers only when the bytes themselves carry an HDR signal', async () => {
    // IHDR 宽度为 0(CRC 合法):sharp 读不出头部,但 cICP 块仍可直接从字节读到。
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const ihdr = Buffer.from(png.subarray(16, 29));
    ihdr.writeUInt32BE(0, 0);
    const brokenPng = (transfer: number) =>
      Buffer.concat([
        png.subarray(0, 8),
        pngChunk('IHDR', ihdr),
        pngChunk('cICP', Buffer.from([9, transfer, 0, 1])),
        png.subarray(33),
      ]);
    for (const buffer of [brokenPng(16), brokenPng(18)]) {
      await expect(sharp(buffer).metadata()).rejects.toThrow();
      await expect(toSdrAvatarImage({ buffer, mimeType: 'image/png' })).rejects.toThrow(
        /INVALID_PARAMS/,
      );
    }
    // 增益图只认解析出的结构;读不出头部的 JPEG 即使带增益图字符串也按既有行为放行。
    const xmp = Buffer.from('<x:xmpmeta hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"/>', 'latin1');
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(xmp.length + 2, 2);
    for (const image of [
      { buffer: brokenPng(13), mimeType: 'image/png' },
      { buffer: Buffer.concat([Buffer.from([0xff, 0xd8]), app1, xmp]), mimeType: 'image/jpeg' },
    ]) {
      await expect(sharp(image.buffer).metadata()).rejects.toThrow();
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });

  it('passes through bytes it cannot parse, preserving the existing validation behaviour', async () => {
    for (const buffer of [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('not an image'),
    ]) {
      const image = { buffer, mimeType: 'image/png' };
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });
});
