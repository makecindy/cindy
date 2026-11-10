import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

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
  // Admission boundary: model bytes must be recognized without trusting a suffix or MIME.
  it('recognizes model structures and rejects ordinary JSON, XML and ZIP', async () => {
    const stl = new Uint8Array(134);
    new DataView(stl.buffer).setUint32(80, 1, true);
    const fbx = new Uint8Array(32);
    fbx.set(ascii('Kaydara FBX Binary  '));
    fbx[21] = 0x1a;
    const studio = new Uint8Array(12);
    studio.set([0x4d, 0x4d]);
    new DataView(studio.buffer).setUint32(2, 12, true);
    new DataView(studio.buffer).setUint32(8, 6, true);
    const models: Array<[Uint8Array, string]> = [
      [ascii('{"asset":{"version":"2.0"},"scenes":[{}]}'), 'model/gltf+json'],
      [ascii('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'model/obj'],
      [fbx, 'model/fbx'],
      [stl, 'model/stl'],
      [ascii('solid sample\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid sample\n'), 'model/stl'],
      [ascii('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n'), 'model/ply'],
      [ascii('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema"><library_geometries/></COLLADA>'), 'model/vnd.collada+xml'],
      [studio, 'model/3ds'],
    ];
    for (const [bytes, mime] of models) expect(sniffMediaMime(bytes)).toBe(mime);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    zip.file('3D/3dmodel.model', '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>');
    expect(sniffMediaMime(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))).toBe('model/3mf');
    zip.file('3D/3dmodel.model', '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' + ' '.repeat(1_300_000) + '</model>');
    expect(sniffMediaMime(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))).toBe('model/3mf');
    zip.file('3D/3dmodel.model', '<!--' + 'x'.repeat(5000) + '-->' + '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>');
    expect(sniffMediaMime(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }))).toBe('model/3mf');
    zip.file('3D/3dmodel.model', 'hello');
    expect(sniffMediaMime(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))).toBeNull();
    zip.file('3D/3dmodel.model', '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>');
    zip.remove('3D/3dmodel.model');
    expect(sniffMediaMime(await zip.generateAsync({ type: 'uint8array' }))).toBeNull();
    expect(sniffMediaMime(ascii('{"asset":{"version":"2.0"},"status":"processing"}'))).toBeNull();
    for (const invalid of [{ nodes: [null] }, { nodes: [1] }, { scenes: [{ nodes: ['bad'] }] }, { buffers: [{}] }, { meshes: [{}] }]) {
      expect(sniffMediaMime(ascii(JSON.stringify({ asset: { version: '2.0' }, ...invalid })))).toBeNull();
    }
    expect(sniffMediaMime(ascii('<html><COLLADA/></html>'))).toBeNull();
    expect(sniffMediaMime(stl.subarray(0, 100))).toBeNull();
    expect(sniffMediaMime(ascii('solid fake\nfacet normal junk outer loop vertex junk endloop endfacet\nendsolid fake\n'))).toBeNull();
  });
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
