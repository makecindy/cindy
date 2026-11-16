import { decodeBase64Url, encodeBase64Url, utf8Bytes } from '@cindy/device-link';
export function fromBase64Url(text: string): Uint8Array {
  const result = decodeBase64Url(text);
  if (result === null) throw new Error('INVALID_BASE64URL');
  return result;
}
export const toBase64Url = encodeBase64Url;
export const utf8 = (text: string): Uint8Array =>
  typeof TextEncoder === 'function' ? new TextEncoder().encode(text) : utf8Bytes(text);
export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const chunks: string[] = [], units: number[] = [];
  const continuation = (offset: number): number => {
    const value = bytes[offset];
    if (value === undefined || (value & 0xc0) !== 0x80) throw new Error('INVALID_UTF8');
    return value & 63;
  };
  for (let at = 0; at < bytes.length;) {
    const first = bytes[at++];
    let code: number;
    if (first < 0x80) code = first;
    else if (first >= 0xc2 && first <= 0xdf) {
      code = ((first & 31) << 6) | continuation(at++);
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(at++), third = continuation(at++);
      code = ((first & 15) << 12) | (second << 6) | third;
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) throw new Error('INVALID_UTF8');
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = ((first & 7) << 18) | (continuation(at++) << 12) | (continuation(at++) << 6) | continuation(at++);
      if (code < 0x10000 || code > 0x10ffff) throw new Error('INVALID_UTF8');
    } else throw new Error('INVALID_UTF8');
    if (code <= 0xffff) units.push(code);
    else { code -= 0x10000; units.push(0xd800 | (code >>> 10), 0xdc00 | (code & 1023)); }
    if (units.length >= 4096) { chunks.push(String.fromCharCode(...units)); units.length = 0; }
  }
  if (units.length) chunks.push(String.fromCharCode(...units));
  return chunks.join('');
}
export const keyHex = (text: string): string => Array.from(fromBase64Url(text), byte => byte.toString(16).padStart(2, '0')).join('');
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
