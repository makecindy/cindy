import { DocsPathError } from './_paths.js';

type UnicodeTextKind = 'HTML' | '文本表格';

/** Decode UTF-8 or BOM-marked UTF-16 without silently replacing malformed input. */
export function decodeUnicodeText(bytes: Buffer, kind: UnicodeTextKind): string {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  }

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new DocsPathError(
      'UNSUPPORTED_ENCODING',
      `${kind}不是有效的 ${encoding.toUpperCase()} 文本`,
      `请把${kind}保存为 UTF-8、带 BOM 的 UTF-16LE 或带 BOM 的 UTF-16BE 后重试，避免内容乱码。`,
    );
  }
}
