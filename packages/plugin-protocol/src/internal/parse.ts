/** plugin-protocol 包内共享的响应解析原语；仅供包内模块使用，不进入对外导出面。 */

/** Plugin HTTP 响应违反共享契约时由解析器抛出的错误。 */
export class PluginProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginProtocolError';
  }
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginProtocolError(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, path: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PluginProtocolError(`${path} 必须是 1–${max} 字符的字符串`);
  }
  return value;
}

export function isoDate(value: unknown, path: string): string {
  const text = string(value, path, 64);
  const parsed = new Date(text);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== text
  ) {
    throw new PluginProtocolError(`${path} 必须是 ISO 8601 UTC 时间`);
  }
  return text;
}

export function sha256(value: unknown, path: string): string {
  const text = string(value, path, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new PluginProtocolError(`${path} 必须是 64 位小写十六进制`);
  }
  return text;
}

export function httpsUrl(value: unknown, path: string, max = 8_192): string {
  const text = string(value, path, max);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new PluginProtocolError(`${path} 必须是 HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new PluginProtocolError(`${path} 必须是 HTTPS URL`);
  }
  return text;
}

/** 列表接口的不透明分页游标：非空、有界，客户端原样回传，不解析内部结构。 */
export function nextCursor(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new PluginProtocolError(`${path} 必须是 1–4096 字符的字符串或 null`);
  }
  return value;
}
