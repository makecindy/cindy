/**
 * 自建中转的设备签名:让中转(哪怕所在服务器被人控制)无法冒充你的设备发消息。
 *
 * - 每台设备有自己的 Ed25519 签名密钥;主人电脑用「主人密钥」给每台设备签发证书
 *   (中转 ID + 设备 ID + 设备公钥)。主人公钥随加入链接 / 二维码交给新设备,不经中转。
 * - 加入时新设备用链接里的一次性配对秘密(同样不经中转)对自己的公钥做 HMAC,主人电脑核对后
 *   才签发证书:中转换不掉新设备的公钥。
 * - 经中转转发的每条对端消息都带 `auth`:时间戳 + 双方启动标识 + 递增计数 + 签名,签名覆盖
 *   中转 ID、收发设备、类型、请求 ID 与完整内容。收到方核对证书、签名、时间与计数,任一不符即丢弃。
 *
 * 本模块不依赖任何加密库:Desktop 注入 node:crypto,Mobile 注入 @noble。方案见
 * docs/self-hosted-relay-plan.md §16。
 */

export const RELAY_CERT_VERSION = 1;
/** 时间戳允许的误差:设备时钟差太多时消息会被拒绝。 */
export const RELAY_FRAME_MAX_SKEW_MS = 10 * 60 * 1000;

const CERT_CONTEXT = 'cindy-relay-cert/1';
const FRAME_CONTEXT = 'cindy-relay-frame/2';
const PAIR_CONTEXT = 'cindy-relay-pair/1';
const KEY_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const BOOT_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;
const MAX_ID_LENGTH = 256;
/** 仅自建中转使用，客户端验签后直接消费，不进入业务分发或远控授权。 */
export const RELAY_AUTH_CHANNEL = 'device-link:relay-auth';

export function relayAuthHandshake(frame: RelaySignableFrame): 'request' | 'response' | null {
  if (frame.kind !== 'push' || !isShortId(frame.id) || !frame.payload || typeof frame.payload !== 'object') return null;
  const payload = frame.payload as Record<string, unknown>;
  if (payload.channel !== RELAY_AUTH_CHANNEL || Object.keys(payload).length !== 2 ||
    !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) return null;
  const body = payload.payload as Record<string, unknown>;
  return Object.keys(body).length === 1 && (body.type === 'request' || body.type === 'response') ? body.type : null;
}

export interface RelayAuthCrypto {
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** 由 32 字节私钥种子推出公钥。 */
  ed25519PublicKey(seed: Uint8Array): Uint8Array;
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array;
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
  randomBytes(size: number): Uint8Array;
  /** 可选的原生 UTF-8 编码(Node 的 Buffer 更快);缺省用纯 JS 实现。 */
  utf8?(text: string): Uint8Array;
}

export type RelayDeviceRole = 'owner' | 'member';

export interface RelayDeviceCert {
  v: typeof RELAY_CERT_VERSION;
  relayId: string;
  deviceId: string;
  /** Ed25519 公钥,base64url(32 字节)。 */
  publicKey: string;
  role: RelayDeviceRole;
  issuedAt: number;
  /** 主人密钥对以上字段的签名,base64url(64 字节)。 */
  signature: string;
}

export interface RelayFrameAuth {
  /** 发送时刻(毫秒)。 */
  t: number;
  /** 本次启动的随机标识。 */
  b: string;
  /** 接收端本次启动挑战；仅认证挑战请求允许为空。 */
  r: string;
  /** 本次启动内严格递增的计数。 */
  c: number;
  /** 签名,base64url。 */
  s: string;
}

// ─── 编码 ────────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALPHABET_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_INDEX[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}

export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let index = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const digit = code < 128 ? ALPHABET_INDEX[code] : -1;
    if (digit < 0) return null;
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >> bits) & 0xff;
    }
  }
  // 拒绝非规范编码(末尾多余的位不为 0),保证同一字节串只有一种写法。
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

function encodeText(crypto: RelayAuthCrypto, text: string): Uint8Array {
  return crypto.utf8 ? crypto.utf8(text) : utf8Bytes(text);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isShortId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

// ─── 密钥 ────────────────────────────────────────────────────────────────────

export interface RelaySigningKey {
  /** 32 字节私钥种子,base64url。只存安全存储。 */
  seed: string;
  publicKey: string;
}

export function createRelaySigningKey(crypto: RelayAuthCrypto): RelaySigningKey {
  const seed = crypto.randomBytes(32);
  return { seed: encodeBase64Url(seed), publicKey: encodeBase64Url(crypto.ed25519PublicKey(seed)) };
}

export function relayPublicKeyOf(crypto: RelayAuthCrypto, seed: string): string | null {
  const bytes = KEY_32_PATTERN.test(seed) ? decodeBase64Url(seed) : null;
  return bytes ? encodeBase64Url(crypto.ed25519PublicKey(bytes)) : null;
}

export function isRelayPublicKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_32_PATTERN.test(value) && decodeBase64Url(value) !== null;
}

/** 一次性配对秘密:只写进加入链接,不发给中转。 */
export function createRelayPairSecret(crypto: RelayAuthCrypto): string {
  return encodeBase64Url(crypto.randomBytes(32));
}

// ─── 加入时的公钥绑定 ─────────────────────────────────────────────────────────

/** 新设备证明「这把公钥是拿着加入链接的那台设备生成的」。 */
export function computeRelayPairProof(
  crypto: RelayAuthCrypto,
  pairSecret: string,
  input: { relayId: string; deviceId: string; publicKey: string },
): string {
  const key = decodeBase64Url(pairSecret);
  if (!key || key.length !== 32) throw new Error('invalid pairing secret');
  const message = JSON.stringify([PAIR_CONTEXT, input.relayId, input.deviceId, input.publicKey]);
  return encodeBase64Url(crypto.hmacSha256(key, encodeText(crypto, message)));
}

export function verifyRelayPairProof(
  crypto: RelayAuthCrypto,
  pairSecret: string,
  input: { relayId: string; deviceId: string; publicKey: string; proof: unknown },
): boolean {
  if (typeof input.proof !== 'string') return false;
  const actual = decodeBase64Url(input.proof);
  if (!actual) return false;
  let expected: Uint8Array;
  try {
    expected = decodeBase64Url(computeRelayPairProof(crypto, pairSecret, input))!;
  } catch {
    return false;
  }
  return constantTimeEqual(actual, expected);
}

// ─── 设备证书 ────────────────────────────────────────────────────────────────

function certMessage(crypto: RelayAuthCrypto, cert: Omit<RelayDeviceCert, 'signature' | 'v'>): Uint8Array {
  return encodeText(
    crypto,
    JSON.stringify([CERT_CONTEXT, cert.relayId, cert.deviceId, cert.publicKey, cert.role, cert.issuedAt]),
  );
}

export function issueRelayDeviceCert(
  crypto: RelayAuthCrypto,
  ownerSeed: string,
  input: { relayId: string; deviceId: string; publicKey: string; role: RelayDeviceRole; issuedAt: number },
): RelayDeviceCert {
  const seed = decodeBase64Url(ownerSeed);
  if (!seed || seed.length !== 32) throw new Error('invalid owner key');
  if (!isShortId(input.relayId) || !isShortId(input.deviceId) || !isRelayPublicKey(input.publicKey)) {
    throw new Error('invalid certificate fields');
  }
  const body = {
    relayId: input.relayId,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    role: input.role,
    issuedAt: input.issuedAt,
  };
  return {
    v: RELAY_CERT_VERSION,
    ...body,
    signature: encodeBase64Url(crypto.ed25519Sign(seed, certMessage(crypto, body))),
  };
}

/** 形状正确时返回证书对象;不校验签名(中转只做这一步)。 */
export function parseRelayDeviceCert(value: unknown): RelayDeviceCert | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    v.v !== RELAY_CERT_VERSION ||
    !isShortId(v.relayId) ||
    !isShortId(v.deviceId) ||
    !isRelayPublicKey(v.publicKey) ||
    (v.role !== 'owner' && v.role !== 'member') ||
    typeof v.issuedAt !== 'number' ||
    !Number.isSafeInteger(v.issuedAt) ||
    typeof v.signature !== 'string' ||
    !SIGNATURE_PATTERN.test(v.signature)
  ) {
    return null;
  }
  return {
    v: RELAY_CERT_VERSION,
    relayId: v.relayId,
    deviceId: v.deviceId,
    publicKey: v.publicKey,
    role: v.role,
    issuedAt: v.issuedAt,
    signature: v.signature,
  };
}

/** 用主人公钥核对证书;不属于这个中转或签名不对时返回 null。 */
export function verifyRelayDeviceCert(
  crypto: RelayAuthCrypto,
  ownerPublicKey: string,
  relayId: string,
  value: unknown,
): RelayDeviceCert | null {
  const cert = parseRelayDeviceCert(value);
  if (!cert || cert.relayId !== relayId) return null;
  const owner = decodeBase64Url(ownerPublicKey);
  const signature = decodeBase64Url(cert.signature);
  if (!owner || owner.length !== 32 || !signature) return null;
  try {
    return crypto.ed25519Verify(owner, certMessage(crypto, cert), signature) ? cert : null;
  } catch {
    return null;
  }
}

// ─── 消息签名 ────────────────────────────────────────────────────────────────

/** 经中转转发的帧里参与签名的字段(与 wire envelope 同名)。 */
export interface RelaySignableFrame {
  kind: string;
  id?: string;
  src?: string;
  dst?: string;
  payload?: unknown;
}

export type RelayFrameVerdict =
  | 'ok'
  | 'unsigned'
  | 'malformed'
  | 'wrong-target'
  | 'wrong-session'
  | 'unknown-signer'
  | 'stale'
  | 'replayed'
  | 'bad-signature';

interface BootWindow {
  lastCounter: number;
  lastSentAt: number;
}

export interface RelayFrameAuthenticatorOptions {
  crypto: RelayAuthCrypto;
  relayId: string;
  /** 本机在这个中转上的设备 ID(证书里的 deviceId)。 */
  deviceId: string;
  /** 本机签名密钥种子。 */
  seed: string;
  /** 加入时从链接取得(或本机即主人)的主人公钥;所有证书都用它核对。 */
  ownerPublicKey: string;
  now?: () => number;
  /** 收到不认识的设备发来的消息时调用,宿主据此刷新证书列表。 */
  onUnknownSigner?: (deviceId: string) => void;
}

export class RelayFrameAuthenticator {
  readonly relayId: string;
  readonly deviceId: string;
  readonly ownerPublicKey: string;
  private readonly crypto: RelayAuthCrypto;
  private readonly seed: Uint8Array;
  private readonly now: () => number;
  private readonly onUnknownSigner?: (deviceId: string) => void;
  private readonly bootId: string;
  private counter = 0;
  private signers = new Map<string, { publicKey: Uint8Array; cert: RelayDeviceCert }>();
  private readonly windows = new Map<string, Map<string, BootWindow>>();
  private readonly peerBoots = new Map<string, { boot: string; ready: boolean }>();
  private verifiedSinceSweep = 0;

  constructor(options: RelayFrameAuthenticatorOptions) {
    const seed = decodeBase64Url(options.seed);
    if (!seed || seed.length !== 32) throw new Error('invalid signing key');
    if (!isRelayPublicKey(options.ownerPublicKey)) throw new Error('invalid owner public key');
    this.crypto = options.crypto;
    this.relayId = options.relayId;
    this.deviceId = options.deviceId;
    this.ownerPublicKey = options.ownerPublicKey;
    this.seed = seed;
    this.now = options.now ?? Date.now;
    this.onUnknownSigner = options.onUnknownSigner;
    this.bootId = encodeBase64Url(options.crypto.randomBytes(12));
  }

  /** 用主人公钥逐个核对后替换证书列表;返回被拒绝的数量。 */
  setCertificates(certs: readonly unknown[]): { accepted: number; rejected: number } {
    const next = new Map<string, { publicKey: Uint8Array; cert: RelayDeviceCert }>();
    let rejected = 0;
    for (const raw of certs) {
      const cert = verifyRelayDeviceCert(this.crypto, this.ownerPublicKey, this.relayId, raw);
      const publicKey = cert ? decodeBase64Url(cert.publicKey) : null;
      if (!cert || !publicKey) {
        rejected++;
        continue;
      }
      next.set(cert.deviceId, { publicKey, cert });
    }
    for (const [deviceId, previous] of this.signers) {
      if (next.get(deviceId)?.cert.publicKey !== previous.cert.publicKey) this.peerBoots.delete(deviceId);
    }
    this.signers = next;
    return { accepted: next.size, rejected };
  }

  hasSigner(deviceId: string): boolean {
    return this.signers.has(deviceId);
  }

  peerChallenge(deviceId: string): 'ready' | 'needed' | 'unknown' {
    if (!this.signers.has(deviceId)) return 'unknown';
    return this.peerBoots.get(deviceId)?.ready ? 'ready' : 'needed';
  }

  sign(frame: RelaySignableFrame): RelayFrameAuth {
    const t = this.now();
    const c = ++this.counter;
    const r = relayAuthHandshake(frame) === 'request' ? '' : this.peerBoots.get(frame.dst ?? '')?.boot ?? '';
    const digest = this.digest(frame, this.deviceId, frame.dst ?? '', t, this.bootId, r, c);
    return { t, b: this.bootId, r, c, s: encodeBase64Url(this.crypto.ed25519Sign(this.seed, digest)) };
  }

  /** 入参是刚解析出的 wire 帧(任意形状),字段类型在这里逐个核对。 */
  verify(frame: Readonly<Record<string, unknown>>): RelayFrameVerdict {
    const src = frame.src;
    const kind = frame.kind;
    const id = frame.id;
    if (!isShortId(src) || typeof kind !== 'string' || (id !== undefined && typeof id !== 'string')) return 'malformed';
    // 自建中转上没有跨账号范围的帧;出现即视为伪造。
    if (frame.sharedTask !== undefined || frame.providerShare !== undefined) return 'unsigned';
    const auth = frame.auth as Partial<RelayFrameAuth> | undefined;
    if (!auth || typeof auth !== 'object') return 'unsigned';
    if (
      typeof auth.t !== 'number' ||
      !Number.isSafeInteger(auth.t) ||
      typeof auth.b !== 'string' ||
      !BOOT_PATTERN.test(auth.b) ||
      typeof auth.r !== 'string' ||
      (auth.r !== '' && !BOOT_PATTERN.test(auth.r)) ||
      typeof auth.c !== 'number' ||
      !Number.isSafeInteger(auth.c) ||
      auth.c <= 0 ||
      typeof auth.s !== 'string' ||
      !SIGNATURE_PATTERN.test(auth.s)
    ) {
      return 'malformed';
    }
    if (frame.dst !== this.deviceId) return 'wrong-target';
    const signer = this.signers.get(src);
    if (!signer) {
      this.onUnknownSigner?.(src);
      return 'unknown-signer';
    }
    const now = this.now();
    if (Math.abs(now - auth.t) > RELAY_FRAME_MAX_SKEW_MS) return 'stale';
    const boots = this.windows.get(src);
    const window = boots?.get(auth.b);
    if (window && auth.c <= window.lastCounter) return 'replayed';
    const signature = decodeBase64Url(auth.s);
    if (!signature) return 'malformed';
    let valid = false;
    try {
      valid = this.crypto.ed25519Verify(
        signer.publicKey,
        this.digest({ kind, id, payload: frame.payload }, src, this.deviceId, auth.t, auth.b, auth.r, auth.c),
        signature,
      );
    } catch {
      valid = false;
    }
    if (!valid) return 'bad-signature';
    const handshake = relayAuthHandshake({ kind, id: typeof id === 'string' ? id : undefined, payload: frame.payload });
    // 只有已验签的专用认证请求可引导挑战；普通建链、查询、推送和写操作一律绑定接收端。
    if (handshake !== 'request' && auth.r !== this.bootId) {
      this.peerBoots.delete(src);
      return 'wrong-session';
    }
    const previous = this.peerBoots.get(src);
    this.peerBoots.set(src, { boot: auth.b, ready: handshake !== 'request' || (previous?.boot === auth.b && previous.ready) });
    const perSource = boots ?? new Map<string, BootWindow>();
    perSource.set(auth.b, { lastCounter: auth.c, lastSentAt: Math.max(window?.lastSentAt ?? 0, auth.t) });
    this.windows.set(src, perSource);
    if (++this.verifiedSinceSweep >= 1000) this.sweep(now);
    return 'ok';
  }

  /** 一次启动的最后一条消息也过期后,它的计数窗口就不再需要:之后的重放都会因过期被拒。 */
  private sweep(now: number): void {
    this.verifiedSinceSweep = 0;
    for (const [src, boots] of this.windows) {
      for (const [boot, window] of boots) {
        if (now - window.lastSentAt > 2 * RELAY_FRAME_MAX_SKEW_MS) boots.delete(boot);
      }
      if (boots.size === 0) this.windows.delete(src);
    }
  }

  private digest(frame: RelaySignableFrame, src: string, dst: string, t: number, b: string, r: string, c: number): Uint8Array {
    const header = JSON.stringify([FRAME_CONTEXT, this.relayId, src, dst, frame.kind, frame.id ?? null, t, b, r, c]);
    const body = frame.payload === undefined ? '' : JSON.stringify(frame.payload);
    return this.crypto.sha256(encodeText(this.crypto, `${header}\n${body}`));
  }
}
