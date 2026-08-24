import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

const MAX_LOG_STRING_CHARS = 20_000;
const MAX_LOG_DEPTH = 24;
const SENSITIVE_PARAM_NAME =
  /(?:^|[-_.])(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?key(?:[-_]?id)?|private[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|signature|credential|cookie|session)(?:$|[-_.])/i;

function boundedText(value: string): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= MAX_LOG_STRING_CHARS) return redacted;
  return `${redacted.slice(0, MAX_LOG_STRING_CHARS)}...[truncated ${redacted.length - MAX_LOG_STRING_CHARS} chars]`;
}

function dataUrlSummary(value: string): string | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const encoded = match[3].replace(/\s/g, '');
  const bytes = match[2]
    ? Math.max(
        0,
        Math.floor((encoded.length * 3) / 4) -
          (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0),
      )
    : Buffer.byteLength(encoded, 'utf8');
  return `[data URL mime=${mimeType} bytes=${bytes}]`;
}

function urlForLog(rawUrl: string, stripFragment: boolean): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM_NAME.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    if (stripFragment) url.hash = '';
    else if (url.hash) url.hash = boundedText(url.hash);
    return url.toString();
  } catch {
    return boundedText(rawUrl);
  }
}

/** 保留实际请求 URL，只脱敏可能携带凭证的 query 值；fragment 不会发给上游。 */
export function mediaRequestUrlForLog(rawUrl: string): string {
  return urlForLog(rawUrl, true);
}

/**
 * 请求参数日志保留真实结构和值；凭证、data URL、二进制与本地文件内容只留描述，
 * 避免日志泄露密钥或被图片/视频 base64 撑爆。
 */
export function mediaRequestParamsForLog(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (item: unknown, key: string | null, depth: number): unknown => {
    if (key && SENSITIVE_PARAM_NAME.test(key)) return '[REDACTED]';
    if (typeof item === 'string') {
      const dataSummary = dataUrlSummary(item);
      if (dataSummary) return dataSummary;
      if (/^https?:\/\/\S+$/i.test(item)) return urlForLog(item, false);
      return boundedText(item);
    }
    if (
      item === null ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      typeof item === 'undefined'
    ) {
      return item;
    }
    if (typeof item === 'bigint') return item.toString();
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
      return `[binary bytes=${item.byteLength}]`;
    }
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      return `[blob mime=${item.type || 'unknown'} bytes=${item.size}]`;
    }
    if (typeof item !== 'object') return boundedText(String(item));
    if (depth >= MAX_LOG_DEPTH) return '[max depth]';
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (Array.isArray(item)) {
      const result = item.map((child) => visit(child, null, depth + 1));
      seen.delete(item);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(item as Record<string, unknown>)) {
      result[childKey] = visit(child, childKey, depth + 1);
    }
    seen.delete(item);
    return result;
  };

  return visit(value, null, 0);
}
