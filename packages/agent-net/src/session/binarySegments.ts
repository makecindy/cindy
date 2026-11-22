/**
 * Session v2 bodies (lanes.ts): long strings that are exactly canonical base64 (file blocks, remote-task upload chunks, results that
 * carry bytes) travel as the bytes they encode, a quarter fewer than their text. The receiver rebuilds the identical string, so the
 * business sees no change. Portable: Node's `Buffer` on the Desktop and Node Host, `atob`/`btoa` or a table on the phone.
 */

/** Strings shorter than this stay in the JSON: below it the saving does not pay for the extra pass. */
export const BINARY_MIN_CHARS = 16 * 1024;
/** Segments one body may carry; more is a broken frame. */
export const MAX_BINARY_SEGMENTS = 4096;
/**
 * In a body with segments, a string that starts with this is the body's own: `#` and an index stands for a segment, `=` and the rest
 * is a string of the message that happened to start with it (escaped, so every string comes back exactly).
 */
const MARK = '\u0000\u0001b';
const SEGMENT = MARK + '#', ESCAPED = MARK + '=';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const INDEX = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index++) INDEX[ALPHABET.charCodeAt(index)] = index;
/** A run this long of base64 characters somewhere in the JSON: the only case worth the replacer's pass. */
const CANDIDATE = new RegExp(`[A-Za-z0-9+/]{${BINARY_MIN_CHARS}}`);
const CANONICAL = /^[A-Za-z0-9+/]*={0,2}$/;

interface NodeBuffer { from(value: string | Uint8Array, encoding?: string): Uint8Array & { toString(encoding: string): string } }
/** What the platform has: Node's `Buffer` (Desktop, Node Host), `atob`/`btoa` (newer React Native), or neither. */
export interface Base64Platform { Buffer?: NodeBuffer; atob?: (text: string) => string; btoa?: (text: string) => string }

/** The codec for `platform`; this module uses the one for the running platform. */
export function base64Codec(platform: Base64Platform) {
  const { Buffer: NodeBuffer, atob: atobFn, btoa: btoaFn } = platform;
  /** The bytes of `text` if it is base64 in its one canonical form (standard alphabet, padded, unused bits zero); otherwise null. */
  const canonicalBase64Bytes = (text: string): Uint8Array | null => {
    if (text.length % 4 !== 0 || !CANONICAL.test(text)) return null;
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    if (padding) {
      const last = INDEX[text.charCodeAt(text.length - padding - 1)];
      if ((last & (padding === 2 ? 15 : 3)) !== 0) return null;
    }
    if (NodeBuffer) {
      const bytes = NodeBuffer.from(text, 'base64');
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    const length = text.length / 4 * 3 - padding, out = new Uint8Array(length);
    if (atobFn) {
      const binary = atobFn(text);
      for (let index = 0; index < length; index++) out[index] = binary.charCodeAt(index);
      return out;
    }
    for (let at = 0, offset = 0; at < text.length; at += 4) {
      const value = (INDEX[text.charCodeAt(at)] << 18) | (INDEX[text.charCodeAt(at + 1)] << 12)
        | ((INDEX[text.charCodeAt(at + 2)] & 63) << 6) | (INDEX[text.charCodeAt(at + 3)] & 63);
      out[offset++] = value >> 16;
      if (offset < length) out[offset++] = (value >> 8) & 255;
      if (offset < length) out[offset++] = value & 255;
    }
    return out;
  };
  /** Canonical base64 of `bytes`. */
  const base64Of = (bytes: Uint8Array): string => {
    if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64');
    if (btoaFn) {
      const parts: string[] = [];
      for (let at = 0; at < bytes.length; at += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(at, at + 8192) as unknown as number[]));
      return btoaFn(parts.join(''));
    }
    const parts: string[] = [], codes: number[] = [];
    for (let at = 0; at < bytes.length; at += 3) {
      const a = bytes[at], b = bytes[at + 1], c = bytes[at + 2];
      codes.push(ALPHABET.charCodeAt(a >> 2), ALPHABET.charCodeAt(((a & 3) << 4) | ((b ?? 0) >> 4)),
        b === undefined ? 61 : ALPHABET.charCodeAt(((b & 15) << 2) | ((c ?? 0) >> 6)), c === undefined ? 61 : ALPHABET.charCodeAt(c & 63));
      if (codes.length >= 8192) { parts.push(String.fromCharCode(...codes)); codes.length = 0; }
    }
    if (codes.length) parts.push(String.fromCharCode(...codes));
    return parts.join('');
  };
  return { canonicalBase64Bytes, base64Of };
}

const { canonicalBase64Bytes, base64Of } = base64Codec(globalThis as Base64Platform);

/**
 * `json` (the message as JSON) with its long base64 strings taken out as bytes; `segments` empty when there are none (the JSON is then
 * `json` itself, read without the reviver).
 */
export function extractSegments(message: unknown, json: string): { json: string; segments: Uint8Array[] } {
  if (json.length < BINARY_MIN_CHARS || !CANDIDATE.test(json)) return { json, segments: [] };
  const segments: Uint8Array[] = [];
  const out = JSON.stringify(message, (_key, value: unknown) => {
    if (typeof value !== 'string') return value;
    if (value.length >= BINARY_MIN_CHARS && segments.length < MAX_BINARY_SEGMENTS) {
      const bytes = canonicalBase64Bytes(value);
      if (bytes) { segments.push(bytes); return SEGMENT + (segments.length - 1); }
    }
    return value.startsWith(MARK) ? ESCAPED + value : value;
  });
  return segments.length ? { json: out, segments } : { json, segments: [] };
}

/** The message a body with segments carries; throws on a reference to a segment it does not have, or a stray mark. */
export function restoreSegments(json: string, segments: readonly Uint8Array[]): unknown {
  return JSON.parse(json, (_key, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(MARK)) return value;
    if (value.startsWith(ESCAPED)) return value.slice(ESCAPED.length);
    const index = value.startsWith(SEGMENT) ? Number(value.slice(SEGMENT.length)) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= segments.length || String(index) !== value.slice(SEGMENT.length)) {
      throw new Error('AGENT_NET_SESSION_FRAME_INVALID');
    }
    return base64Of(segments[index]);
  });
}
