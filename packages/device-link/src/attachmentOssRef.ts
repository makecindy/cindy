/**
 * Device Link 端到端附件 OSS 引用。
 *
 * relay 只转发承载本引用的 InvokePayload.args，不解析其中业务字段；因此契约归属于
 * desktop/mobile 共用的客户端协议包，而不是 relay wire protocol。
 */

export const ATTACH_OSS_SCHEME = 'cindy-oss-attach';
/** 品牌迁移前的旧 scheme；解析面永久保留，混合版本 rollout 期间发送端继续使用。 */
export const LEGACY_ATTACH_OSS_SCHEME = 'xdt-oss-attach';

const SHARED_TASK_MEDIA_KEY_PREFIX = 'cindy/device-link/shared-task/';

/**
 * 共享任务附件的对象 key(服务端按 sharedTaskId 与成员授权)。这类对象只存在于官方存储,
 * 本机中转走自建时也要向官方换取地址。
 */
export function isSharedTaskMediaKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(SHARED_TASK_MEDIA_KEY_PREFIX);
}

const ATTACH_OSS_PREFIX = `${ATTACH_OSS_SCHEME}://m/`;
const LEGACY_ATTACH_OSS_PREFIX = `${LEGACY_ATTACH_OSS_SCHEME}://m/`;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** 发送端对实际上传字节作出的完整性声明；两个字段必须同时存在。 */
export interface AttachmentIntegrity {
  /** 实际上传字节数。 */
  size: number;
  /** 实际上传字节的 SHA-256，小写十六进制。 */
  sha256: string;
}

/**
 * 附件中转引用。size/sha256 可选仅用于兼容旧客户端；新发送端必须同时写入二者。
 */
export interface AttachmentOssRef {
  ossKey: string;
  mimeType?: string;
  originalName?: string;
  size?: number;
  sha256?: string;
}

/** 判断一组可选完整性字段是否是合法的完整声明。 */
export function isValidAttachmentIntegrity(value: {
  size?: unknown;
  sha256?: unknown;
}): value is AttachmentIntegrity {
  return (
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    typeof value.sha256 === 'string' &&
    SHA256_HEX_PATTERN.test(value.sha256)
  );
}

/** 组装 OSS 附件引用串；拒绝半套或非法完整性元数据。 */
export function buildAttachmentOssRef(ref: AttachmentOssRef): string {
  return buildAttachmentOssRefWithScheme(ref, ATTACH_OSS_SCHEME);
}

/** Rollout-safe sender form: old clients only understand xdt-oss-attach. */
export function buildLegacyAttachmentOssRef(ref: AttachmentOssRef): string {
  return buildAttachmentOssRefWithScheme(ref, LEGACY_ATTACH_OSS_SCHEME);
}

function buildAttachmentOssRefWithScheme(ref: AttachmentOssRef, scheme: string): string {
  if (typeof ref.ossKey !== 'string' || ref.ossKey.length === 0) {
    throw new Error('Attachment OSS reference requires a non-empty ossKey');
  }
  const hasSize = ref.size !== undefined;
  const hasSha256 = ref.sha256 !== undefined;
  if (hasSize !== hasSha256 || (hasSize && !isValidAttachmentIntegrity(ref))) {
    throw new Error('Attachment OSS reference requires valid size and sha256 together');
  }
  return `${scheme}://m/${toBase64Url(JSON.stringify(ref))}`;
}

/** 判断字符串是否使用附件 OSS 引用 scheme。 */
export function isAttachmentOssRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith(`${ATTACH_OSS_SCHEME}://`) ||
      value.startsWith(`${LEGACY_ATTACH_OSS_SCHEME}://`))
  );
}

/**
 * 解析附件引用。旧引用（没有 size/sha256）继续接受；半套或非法完整性声明返回 null。
 */
export function parseAttachmentOssRef(value: string): AttachmentOssRef | null {
  const prefix = value.startsWith(ATTACH_OSS_PREFIX)
    ? ATTACH_OSS_PREFIX
    : value.startsWith(LEGACY_ATTACH_OSS_PREFIX)
      ? LEGACY_ATTACH_OSS_PREFIX
      : null;
  if (!prefix) return null;
  const segment = value.slice(prefix.length).split('/')[0];
  if (!segment) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(segment)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.ossKey !== 'string' || record.ossKey.length === 0) return null;

    const hasSize = record.size !== undefined;
    const hasSha256 = record.sha256 !== undefined;
    if (hasSize !== hasSha256) return null;
    const integrity = hasSize ? { size: record.size, sha256: record.sha256 } : null;
    if (integrity && !isValidAttachmentIntegrity(integrity)) {
      return null;
    }

    return {
      ossKey: record.ossKey,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      originalName: typeof record.originalName === 'string' ? record.originalName : undefined,
      ...(integrity ?? {}),
    };
  } catch {
    return null;
  }
}

function toBase64Url(input: string): string {
  return base64Encode(utf8Bytes(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return utf8String(base64Decode(padded));
}

/** React Native/Hermes 也可用的 UTF-8 编码，避免依赖 TextEncoder 全局对象。 */
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

/** React Native/Hermes 也可用的 UTF-8 解码，输入只来自本模块生成的合法引用。 */
function utf8String(bytes: Uint8Array): string {
  return decodeURIComponent(
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  );
}

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b1 = bytes[index];
    const b2 = bytes[index + 1];
    const b3 = bytes[index + 2];
    out += BASE64_ALPHABET[b1 >> 2];
    out += BASE64_ALPHABET[((b1 & 0x03) << 4) | ((b2 ?? 0) >> 4)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[((b2 & 0x0f) << 2) | ((b3 ?? 0) >> 6)];
    out += b3 === undefined ? '=' : BASE64_ALPHABET[b3 & 0x3f];
  }
  return out;
}

function base64Decode(input: string): Uint8Array {
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
  if (!char) throw new Error('Invalid base64url attachment reference');
  const index = BASE64_ALPHABET.indexOf(char);
  if (index < 0) throw new Error('Invalid base64url attachment reference');
  return index;
}
