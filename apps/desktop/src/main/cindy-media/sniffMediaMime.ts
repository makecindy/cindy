/**
 * sniffMediaMime.ts — 媒体总仓支持类型的保守魔数识别。
 * ---------------------------------------------------------------------------
 * 供主机在媒体入仓前核验外部响应的真实类型；Content-Type 只作为线索，不能
 * 单独决定落仓 MIME。识别范围必须与 blobStore 当前白名单保持一致，识别不出返回 null。
 */

/** ASCII bytes at an exact offset. */
function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || bytes.byteLength < offset + value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

/** ISO BMFF ftyp brand → the subset accepted by cindy-media. */
function sniffIsoBmffMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 16 || !asciiAt(bytes, 4, 'ftyp')) return null;
  const declaredSize =
    (((bytes[0] << 24) >>> 0) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
  // A normal ftyp box contains size, type, major_brand and minor_version.
  // Reject short or truncated boxes instead of treating arbitrary bytes as brands.
  // Compatible brands area must be 4-byte aligned to reject malformed/forged sizes.
  if (declaredSize < 16 || declaredSize > bytes.byteLength || (declaredSize - 16) % 4 !== 0) return null;
  const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  const brands = [majorBrand];
  for (let offset = 16; offset + 4 <= declaredSize; offset += 4) {
    brands.push(String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]));
  }
  if (brands.includes('qt  ')) return 'video/quicktime';
  if (brands.some((brand) => ['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B '].includes(brand))) {
    return 'audio/mp4';
  }
  if (
    brands.some((brand) => [
      '3gp4', '3gp5', '3gp6', '3gp7', '3gp8', '3gp9', 'avc1', 'av01', 'dash',
      'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9', 'isom', 'M4V ',
      'mmp4', 'MP4 ', 'mp41', 'mp42', 'MSNV',
    ].includes(brand))
  ) {
    return 'video/mp4';
  }
  return null;
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0
  );
}

function looksLikeDeclaredQuickTime(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const size = readUint32Be(bytes, 0);
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (!['moov', 'mdat', 'free', 'skip', 'wide'].includes(type)) return false;
  if (size === 0) return true;
  if (size === 1) {
    if (bytes.byteLength < 16) return false;
    const high = readUint32Be(bytes, 8);
    const low = readUint32Be(bytes, 12);
    return high > 0 || low >= 16;
  }
  return size >= 8;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function looksLikeGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12 || !asciiAt(bytes, 0, 'glTF')) return false;
  const version = readUint32Le(bytes, 4);
  const length = readUint32Le(bytes, 8);
  // GLB v2's total length includes this header and is four-byte aligned. The
  // complete payload may be beyond the 4 KiB sniff probe, so do not require it
  // to fit in the probe itself.
  return version === 2 && length >= 12 && length % 4 === 0;
}

function looksLikeWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || !asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) return false;
  const declaredSize = readUint32Le(bytes, 4);
  if (declaredSize < 8 || declaredSize % 2 !== 0) return false;
  return asciiAt(bytes, 12, 'VP8 ') || asciiAt(bytes, 12, 'VP8L') || asciiAt(bytes, 12, 'VP8X');
}

function looksLikeWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20 || !asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WAVE')) return false;
  const declaredSize = readUint32Le(bytes, 4);
  if (declaredSize < 12 || declaredSize % 2 !== 0) return false;
  const scanEnd = Math.min(bytes.byteLength, declaredSize + 8);
  for (let offset = 12; offset + 8 <= scanEnd;) {
    const chunkSize = readUint32Le(bytes, offset + 4);
    if (asciiAt(bytes, offset, 'fmt ')) return chunkSize >= 16 && chunkSize <= 40;
    const nextOffset = offset + 8 + chunkSize + (chunkSize & 1);
    if (nextOffset <= offset || nextOffset > scanEnd) return false;
    offset = nextOffset;
  }
  return false;
}

function parseId3FrameOffset(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 10 || !asciiAt(bytes, 0, 'ID3')) return null;
  const majorVersion = bytes[3];
  const revision = bytes[4];
  const flags = bytes[5];
  if (majorVersion < 2 || majorVersion > 4 || revision !== 0) return null;
  const allowedFlags = majorVersion === 2 ? 0x00 : majorVersion === 3 ? 0xe0 : 0xf0;
  if ((flags & ~allowedFlags) !== 0) return null;
  for (let i = 6; i < 10; i++) {
    if ((bytes[i] & 0x80) !== 0) return null;
  }
  const tagSize =
    (bytes[6] << 21) |
    (bytes[7] << 14) |
    (bytes[8] << 7) |
    bytes[9];
  const footerSize = majorVersion === 4 && (flags & 0x10) !== 0 ? 10 : 0;
  return 10 + tagSize + footerSize;
}

/**
 * Upper bound for ID3 tag size we're willing to probe past. Prevents a forged
 * tag from causing us to buffer arbitrarily large data just to reach the first
 * MPEG frame. 2 MiB covers virtually all real-world embedded artwork tags.
 */
const MAX_ID3_TAG_BYTES = 2 * 1024 * 1024;

/** Return the byte count needed to inspect the first MPEG frame after ID3. */
export function additionalMp3BytesNeeded(bytes: Uint8Array): number | null {
  const frameOffset = parseId3FrameOffset(bytes);
  if (frameOffset === null || frameOffset > MAX_ID3_TAG_BYTES) return null;
  return frameOffset + 4;
}

/** Validate an ID3v2 header and require an MPEG frame after the tag. */
function looksLikeId3v2(bytes: Uint8Array): boolean {
  const frameOffset = parseId3FrameOffset(bytes);
  return frameOffset !== null && frameOffset <= MAX_ID3_TAG_BYTES &&
    frameOffset + 4 <= bytes.byteLength &&
    looksLikeMpegAudioFrame(bytes.subarray(frameOffset));
}

/** Validate enough MPEG audio header fields to avoid accepting any ff-prefixed bytes. */
function looksLikeMpegAudioFrame(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[1] >> 3) & 0x03;
  const layer = (bytes[1] >> 1) & 0x03;
  const bitrate = (bytes[2] >> 4) & 0x0f;
  const sampleRate = (bytes[2] >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

function looksLikeWebm(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 11 ||
    bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3
  ) {
    return false;
  }
  // EBML is also the Matroska container. Require DocType(id 0x4282) = "webm"
  // instead of treating the shared four-byte EBML header as sufficient.
  const limit = Math.min(bytes.byteLength - 6, 4096);
  for (let i = 4; i <= limit; i++) {
    if (
      bytes[i] === 0x42 && bytes[i + 1] === 0x82 && bytes[i + 2] === 0x84 &&
      asciiAt(bytes, i + 3, 'webm')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Infer a canonical MIME from bytes without consulting a filename or URL.
 * The returned value is always one of blobStore's currently supported MIME values.
 */
export function sniffMediaMime(bytes: Uint8Array, declaredMime = ''): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;

  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.byteLength >= 6 && (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a'))) {
    return 'image/gif';
  }
  if (looksLikeWebp(bytes)) return 'image/webp';
  if (looksLikeWav(bytes)) return 'audio/wav';
  if (bytes.byteLength >= 4 && asciiAt(bytes, 0, 'OggS')) return 'audio/ogg';
  if (looksLikeId3v2(bytes)) return 'audio/mpeg';
  if (looksLikeMpegAudioFrame(bytes)) return 'audio/mpeg';

  const isoMime = sniffIsoBmffMime(bytes);
  if (isoMime) return isoMime;
  if (declaredMime === 'video/quicktime' && looksLikeDeclaredQuickTime(bytes)) {
    return 'video/quicktime';
  }

  if (looksLikeWebm(bytes)) return 'video/webm';
  if (looksLikeGlb(bytes)) return 'model/gltf-binary';
  return null;
}
