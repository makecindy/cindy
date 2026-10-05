import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
/** Bounded UTF-8 helpers work without TextEncoder/TextDecoder on Hermes. */
export function oauthUtf8Bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value),
    bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(encoded.charCodeAt(i));
  }
  return Uint8Array.from(bytes);
}
function oauthUtf8Text(bytes: Uint8Array): string {
  return decodeURIComponent(
    Array.from(bytes, (byte) => "%" + byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  );
}

export interface PluginOauthCrypto {
  random(size: number): Uint8Array;
  encrypt(
    key: Uint8Array,
    iv: Uint8Array,
    body: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array>;
  decrypt(
    key: Uint8Array,
    combined: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array>;
}
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function encodeOauthBytes(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1],
      c = bytes[i + 2];
    result += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) result += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) result += alphabet[c & 63];
  }
  return result;
}
export function decodeOauthBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("OAUTH_BRIDGE_INVALID");
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0,
    accumulated = 0,
    at = 0;
  for (const c of value) {
    accumulated = (accumulated << 6) | alphabet.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (accumulated >> bits) & 255;
    }
  }
  if (encodeOauthBytes(bytes) !== value)
    throw new Error("OAUTH_BRIDGE_INVALID");
  return bytes;
}
const xPrefix = new Uint8Array([48, 42, 48, 5, 6, 3, 43, 101, 110, 3, 33, 0]);
const edPrefix = new Uint8Array([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0]);
function rawPublic(value: string, prefix: Uint8Array) {
  const bytes = decodeOauthBytes(value);
  if (bytes.length !== 44 || prefix.some((b, i) => bytes[i] !== b))
    throw new Error("OAUTH_BRIDGE_INVALID");
  return bytes.subarray(prefix.length);
}
export function verifyOauthSignature(
  publicKey: string,
  signature: string,
  transcript: string,
): boolean {
  try {
    return ed25519.verify(
      decodeOauthBytes(signature),
      oauthUtf8Bytes(transcript),
      rawPublic(publicKey, edPrefix),
      { zip215: false },
    );
  } catch {
    return false;
  }
}
/** Same wire format as the desktop OauthBox. Secure randomness and AES come from the platform. */
export class MobileOauthBox {
  private privateKey: Uint8Array;
  readonly publicKey: string;
  private disposed = false;
  constructor(private readonly crypto: PluginOauthCrypto) {
    this.privateKey = crypto.random(32);
    this.publicKey = encodeOauthBytes(
      new Uint8Array([...xPrefix, ...x25519.getPublicKey(this.privateKey)]),
    );
  }
  dispose() {
    this.disposed = true;
    this.privateKey.fill(0);
  }
  private key(peer: string, id: string, direction: "offer" | "callback") {
    if (this.disposed) throw new Error("OAUTH_BRIDGE_INVALID");
    const shared = x25519.getSharedSecret(
      this.privateKey,
      rawPublic(peer, xPrefix),
    );
    try {
      return hkdf(
        sha256,
        shared,
        oauthUtf8Bytes(id),
        oauthUtf8Bytes(`cindy-plugin-oauth-v1:${direction}`),
        32,
      );
    } finally {
      shared.fill(0);
    }
  }
  async seal(
    peer: string,
    id: string,
    direction: "offer" | "callback",
    value: unknown,
  ): Promise<string> {
    const key = this.key(peer, id, direction),
      body = oauthUtf8Bytes(JSON.stringify(value));
    try {
      if (body.length > 32000) throw new Error("OAUTH_BRIDGE_INVALID");
      return encodeOauthBytes(
        await this.crypto.encrypt(
          key,
          this.crypto.random(12),
          body,
          oauthUtf8Bytes(`cindy-plugin-oauth-v1:${id}:${direction}`),
        ),
      );
    } finally {
      key.fill(0);
      body.fill(0);
    }
  }
  async open(
    peer: string,
    id: string,
    direction: "offer" | "callback",
    box: string,
  ): Promise<unknown> {
    let key: Uint8Array | undefined, body: Uint8Array | undefined;
    try {
      if (!/^[A-Za-z0-9_-]{40,48000}$/.test(box)) throw 0;
      key = this.key(peer, id, direction);
      body = await this.crypto.decrypt(
        key,
        decodeOauthBytes(box),
        oauthUtf8Bytes(`cindy-plugin-oauth-v1:${id}:${direction}`),
      );
      if (body.length > 32000) throw 0;
      return JSON.parse(oauthUtf8Text(body));
    } catch {
      throw new Error("OAUTH_BRIDGE_INVALID");
    } finally {
      key?.fill(0);
      body?.fill(0);
    }
  }
}
