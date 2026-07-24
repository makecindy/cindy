import { describe, expect, it } from 'vitest';

import { sniffMediaMime } from '../sniffMediaMime';

function ascii(value: string, total = value.length): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}

function id3(version: number, flags = 0, tagSize = 0): Uint8Array {
  const footer = version === 4 && (flags & 0x10) !== 0
    ? new Uint8Array(10)
    : new Uint8Array();
  return new Uint8Array([
    0x49, 0x44, 0x33, version, 0x00, flags,
    (tagSize >>> 21) & 0x7f,
    (tagSize >>> 14) & 0x7f,
    (tagSize >>> 7) & 0x7f,
    tagSize & 0x7f,
    ...new Uint8Array(tagSize),
    ...footer,
    0xff, 0xfb, 0x90, 0x64,
  ]);
}

function riff(
  format: 'WEBP' | 'WAVE',
  chunks: Array<{ id: string; size: number }>,
  declaredSize?: number,
): Uint8Array {
  const bodySize = chunks.reduce((total, chunk) => total + 8 + chunk.size + (chunk.size & 1), 4);
  const size = declaredSize ?? bodySize;
  const bytes = new Uint8Array(8 + bodySize);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set([
    size & 0xff,
    (size >>> 8) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 24) & 0xff,
  ], 4);
  bytes.set(new TextEncoder().encode(format), 8);
  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(new TextEncoder().encode(chunk.id), offset);
    bytes.set([
      chunk.size & 0xff,
      (chunk.size >>> 8) & 0xff,
      (chunk.size >>> 16) & 0xff,
      (chunk.size >>> 24) & 0xff,
    ], offset + 4);
    offset += 8 + chunk.size + (chunk.size & 1);
  }
  return bytes;
}

function ftyp(brand: string, compatibleBrands: string[] = [], minorVersion = 0): Uint8Array {
  const bytes = new Uint8Array(16 + compatibleBrands.length * 4);
  bytes.set([0, 0, 0, bytes.length], 0);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  bytes.set([
    (minorVersion >>> 24) & 0xff,
    (minorVersion >>> 16) & 0xff,
    (minorVersion >>> 8) & 0xff,
    minorVersion & 0xff,
  ], 12);
  for (const [index, compatible] of compatibleBrands.entries()) {
    bytes.set(new TextEncoder().encode(compatible), 16 + index * 4);
  }
  return bytes;
}

function atom(type: string, size = 8): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 8));
  bytes.set([
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
  ], 0);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

function glb(version = 2, length = 12): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode('glTF'), 0);
  bytes.set([
    version & 0xff,
    (version >>> 8) & 0xff,
    (version >>> 16) & 0xff,
    (version >>> 24) & 0xff,
    length & 0xff,
    (length >>> 8) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 24) & 0xff,
  ], 4);
  return bytes;
}

describe('sniffMediaMime', () => {
  it('recognizes the cindy-media image formats', () => {
    expect(sniffMediaMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMediaMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaMime(ascii('GIF89a'))).toBe('image/gif');
    const webp = riff('WEBP', [{ id: 'VP8X', size: 10 }], 10_000);
    expect(sniffMediaMime(webp)).toBe('image/webp');
  });

  it('recognizes valid ID3v2 headers and MPEG audio frame headers', () => {
    expect(sniffMediaMime(id3(2))).toBe('audio/mpeg');
    expect(sniffMediaMime(id3(3))).toBe('audio/mpeg');
    expect(sniffMediaMime(id3(4))).toBe('audio/mpeg');
    expect(sniffMediaMime(id3(4, 0x10))).toBe('audio/mpeg');
    expect(sniffMediaMime(id3(4, 0, 5))).toBe('audio/mpeg');
    expect(sniffMediaMime(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg');
  });

  it('rejects ID3 lookalikes, malformed headers and reserved MPEG fields', () => {
    expect(sniffMediaMime(ascii('ID3 status: ready'))).toBeNull();
    expect(sniffMediaMime(ascii('ID3\x04\x00'))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 5, 1, 2, 3, 4, 5]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0xff, 0xe0, 0x00, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0xff, 0xf8, 0xf0, 0x00]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]))).toBeNull();
  });

  it('recognizes OGG container (audio/ogg)', () => {
    expect(sniffMediaMime(ascii('OggS', 32))).toBe('audio/ogg');
  });

  it('recognizes WAV, ISO BMFF video/audio, WebM and GLB', () => {
    expect(sniffMediaMime(riff('WAVE', [{ id: 'fmt ', size: 16 }], 10_000))).toBe('audio/wav');
    expect(sniffMediaMime(riff('WAVE', [
      { id: 'JUNK', size: 3 },
      { id: 'fmt ', size: 16 },
    ]))).toBe('audio/wav');
    expect(sniffMediaMime(ftyp('isom'))).toBe('video/mp4');
    expect(sniffMediaMime(ftyp('iso9'))).toBe('video/mp4');
    expect(sniffMediaMime(ftyp('zzzz', ['isom']))).toBe('video/mp4');
    expect(sniffMediaMime(ftyp('M4A '))).toBe('audio/mp4');
    expect(sniffMediaMime(ftyp('qt  '))).toBe('video/quicktime');
    for (const type of ['moov', 'mdat', 'free', 'skip', 'wide']) {
      expect(sniffMediaMime(atom(type), 'video/quicktime')).toBe('video/quicktime');
      expect(sniffMediaMime(atom(type))).toBeNull();
    }
    expect(sniffMediaMime(atom('evil'), 'video/quicktime')).toBeNull();
    expect(sniffMediaMime(new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    ]))).toBe('video/webm');
    expect(sniffMediaMime(glb())).toBe('model/gltf-binary');
  });

  it('fails closed for text, zip, unknown brands and short inputs', () => {
    expect(sniffMediaMime(ascii('{"status":"processing"}'))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
    expect(sniffMediaMime(new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61,
    ]))).toBeNull();
    expect(sniffMediaMime(ftyp('zzzz'))).toBeNull();
    expect(sniffMediaMime(ftyp('zzzz', [], 0x69736f6d))).toBeNull();
    expect(sniffMediaMime(ascii('RIFF0000WEBP'))).toBeNull();
    expect(sniffMediaMime(ascii('RIFF0000WAVE'))).toBeNull();
    expect(sniffMediaMime(riff('WEBP', [{ id: 'NOPE', size: 10 }]))).toBeNull();
    expect(sniffMediaMime(riff('WAVE', [{ id: 'JUNK', size: 16 }]))).toBeNull();
    expect(sniffMediaMime(riff('WAVE', [{ id: 'fmt ', size: 4 }]))).toBeNull();
    expect(sniffMediaMime(ascii('glTF'))).toBeNull();
    expect(sniffMediaMime(glb(1))).toBeNull();
    expect(sniffMediaMime(glb(2, 10))).toBeNull();
    expect(sniffMediaMime(new Uint8Array())).toBeNull();
    expect(sniffMediaMime(new Uint8Array([0xff]))).toBeNull();
  });
});
