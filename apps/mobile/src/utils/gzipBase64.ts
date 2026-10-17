/**
 * gzip + base64 文本解码，无业务依赖：文件浏览 readFile 与 device-link invoke
 * 结果传输编码共用。
 */
import { Inflate, ungzip } from 'pako';

/** readFile 返回 contentEncoding:'gzip' 时的解码(base64 → gunzip → utf8)。 */
export function decodeGzipBase64Text(contentBase64: string): string {
  return ungzip(base64ToUint8Array(contentBase64), { to: 'string' });
}

/** 带输出上限的解码：边解边计数，超过 maxChars 立即中止，不先整段展开。 */
export function decodeGzipBase64TextBounded(contentBase64: string, maxChars: number): string {
  const inflator = new Inflate({ to: 'string' });
  const chunks: string[] = [];
  let length = 0;
  // `to: 'string'` delivers text chunks at runtime; @types/pako only declares binary data.
  inflator.onData = (chunk: unknown) => {
    if (typeof chunk !== 'string') throw new TypeError('unexpected binary chunk');
    const text = chunk;
    length += text.length;
    if (length > maxChars) throw new RangeError('decompressed text exceeds limit');
    chunks.push(text);
  };
  inflator.push(base64ToUint8Array(contentBase64), true);
  if (inflator.err) throw new Error(inflator.msg || 'gzip decode failed');
  return chunks.join('');
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(base64) : decodeBase64Fallback(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Hermes 老版本无全局 atob 的兜底(实现对齐 mobileRealtimeAudio 的做法)。 */
function decodeBase64Fallback(base64: string): string {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  let output = '';
  let i = 0;
  while (i < clean.length) {
    const enc1 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc2 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc3 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc4 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const chr1 = (enc1 << 2) | (enc2 >> 4);
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    const chr3 = ((enc3 & 3) << 6) | enc4;
    output += String.fromCharCode(chr1);
    // `=` 填充位 indexOf 返回 -1;字母表只有 64 个字符,索引恒在 0-63。
    if (enc3 !== -1) output += String.fromCharCode(chr2);
    if (enc4 !== -1) output += String.fromCharCode(chr3);
  }
  return output;
}
