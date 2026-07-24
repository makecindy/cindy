
import { sha256 } from '@noble/hashes/sha256';
import { i18n } from '@/i18n';

const HASH_CHUNK_BYTES = 1024 * 1024;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 可注入的分块文件读取器；返回指定字节区间的 base64。 */
export type MobileAttachmentChunkReader = (
  uri: string,
  position: number,
  length: number,
) => Promise<string>;

/**
 * 以固定大小分块计算本地文件 SHA-256，避免把完整附件加载进 Hermes 堆。
 */
export async function sha256MobileAttachmentFile(
  uri: string,
  expectedSize: number,
  options: {
    readChunk?: MobileAttachmentChunkReader;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  assertExpectedSize(expectedSize);
  const readChunk = options.readChunk ?? readFileChunkBase64;
  const hash = sha256.create();
  for (let position = 0; position < expectedSize; position += HASH_CHUNK_BYTES) {
    if (options.signal?.aborted) throw new Error(i18n.t('composer.upload.cancelled'));
    const length = Math.min(HASH_CHUNK_BYTES, expectedSize - position);
    const encoded = await readChunk(uri, position, length);
    const bytes = decodeBase64(encoded);
    if (bytes.byteLength !== length) {
      throw new Error(i18n.t('composer.upload.incompleteRead', { expected: length, actual: bytes.byteLength }));
    }
    hash.update(bytes);
  }
  return toHex(hash.digest());
}
/** 对内存上传 body 分块计算同语义摘要。 */
export async function sha256MobileAttachmentBody(
  body: BodyInit,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<string> {
  assertExpectedSize(expectedSize);
  const hash = sha256.create();
  let seen = 0;

  if (body instanceof Blob) {
    for (let position = 0; position < body.size; position += HASH_CHUNK_BYTES) {
      if (signal?.aborted) throw new Error(i18n.t('composer.upload.cancelled'));
      const bytes = new Uint8Array(
        await body.slice(position, position + HASH_CHUNK_BYTES).arrayBuffer(),
      );
      seen += bytes.byteLength;
      hash.update(bytes);
    }
  } else if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    seen = bytes.byteLength;
    hash.update(bytes);
  } else if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    seen = bytes.byteLength;
    hash.update(bytes);
  } else if (typeof body === 'string') {
    const bytes = utf8Bytes(body);
    seen = bytes.byteLength;
    hash.update(bytes);
  } else {
    throw new Error(i18n.t('composer.upload.integrityUnavailable'));
  }

  if (seen !== expectedSize) {
    throw new Error(i18n.t('composer.upload.sizeChanged', { expected: expectedSize, actual: seen }));
  }
  return toHex(hash.digest());
}

async function readFileChunkBase64(uri: string, position: number, length: number): Promise<string> {
  const FileSystem = await import('expo-file-system/legacy');
  // Expo legacy readAsStringAsync defines position/length in raw file bytes, even when Base64 is returned.
  // The decoded-length check above also guards adapters with different offset semantics.
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position,
    length,
  });
}

function assertExpectedSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(i18n.t('composer.upload.invalidSize'));
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Hermes 兼容的 UTF-8 编码，避免附件上传依赖 TextEncoder 全局对象。 */
function utf8Bytes(input: string): Uint8Array {
  const escaped = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index += 1) {
    const char = escaped[index];
    if (char === '%') {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/\s/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const c1 = decodeBase64Char(clean[index]);
    const c2 = decodeBase64Char(clean[index + 1]);
    const c3 = clean[index + 2] === '=' ? -1 : decodeBase64Char(clean[index + 2]);
    const c4 = clean[index + 3] === '=' ? -1 : decodeBase64Char(clean[index + 3]);
    bytes.push((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) bytes.push(((c2 & 0x0f) << 4) | (c3 >> 2));
    if (c4 >= 0) bytes.push(((c3 & 0x03) << 6) | c4);
  }
  return Uint8Array.from(bytes);
}

function decodeBase64Char(char: string | undefined): number {
  if (!char) throw new Error(i18n.t('composer.upload.invalidBase64'));
  const index = BASE64_ALPHABET.indexOf(char);
  if (index < 0) throw new Error(i18n.t('composer.upload.invalidBase64'));
  return index;
}
