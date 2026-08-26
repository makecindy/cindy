import { DocsPathError } from './_paths.js';

type UnicodeTextKind = 'HTML' | '文本表格' | '本地样式表';

const CSS_CHARSET_PREFIX = /^@charset\s+["']([^"']+)["']\s*;/i;

function encodingError(kind: string, encoding: string, hint?: string): DocsPathError {
  return new DocsPathError(
    'UNSUPPORTED_ENCODING',
    `${kind}不是有效的 ${encoding.toUpperCase()} 文本`,
    hint ??
      `请把${kind}保存为 UTF-8、带 BOM 的 UTF-16LE 或带 BOM 的 UTF-16BE 后重试，避免内容乱码。`,
  );
}

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
    throw encodingError(kind, encoding);
  }
}

/** Decode a local stylesheet before rewriting it as UTF-8 and drop stale @charset metadata. */
export function decodeCssText(bytes: Buffer): string {
  const hasUnicodeBom =
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);
  let decoded: string;
  if (hasUnicodeBom) {
    decoded = decodeUnicodeText(bytes, '本地样式表');
  } else {
    const declared = bytes.subarray(0, 256).toString('latin1').match(CSS_CHARSET_PREFIX)?.[1];
    const encoding = declared ?? 'utf-8';
    try {
      decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw encodingError(
        '本地样式表',
        encoding,
        '请把本地样式表保存为 UTF-8、带 BOM 的 UTF-16LE / UTF-16BE，或使用受支持的 @charset 编码声明后重试。',
      );
    }
  }
  return decoded.replace(CSS_CHARSET_PREFIX, '');
}
