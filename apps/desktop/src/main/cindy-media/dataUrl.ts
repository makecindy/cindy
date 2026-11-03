/**
 * 结构性解析 data URL（#5081）。
 *
 * 参考图展开成 base64 后单段可达数百万字符。#5081 报告单张约 3MiB（base64 ≈ 2^22 字符）
 * 在组装阶段抛 `RangeError: Maximum call stack size exceeded`；为避免把整段载荷交给
 * 带捕获组/贪婪量词的正则回溯，这里只做前缀判断与 `indexOf(',')` 切分，对载荷本身
 * 不跑任何正则，成本与长度线性。
 */
export interface ParsedDataUrl {
  /** 已小写的 MIME 类型（`data:` 与首个 `;`/`,` 之间）。 */
  mimeType: string;
  /** header 段是否声明 `;base64`。 */
  base64: boolean;
  /** 逗号之后的原始载荷（未去空白）。 */
  payload: string;
}

export function parseDataUrl(value: string): ParsedDataUrl | null {
  if (value.length < 6 || value.slice(0, 5).toLowerCase() !== 'data:') return null;
  const comma = value.indexOf(',');
  if (comma < 5) return null;
  const header = value.slice(5, comma);
  const segments = header.split(';');
  const mimeType = segments[0].trim().toLowerCase();
  if (!mimeType) return null;
  const base64 = segments.slice(1).some((segment) => segment.trim().toLowerCase() === 'base64');
  return { mimeType, base64, payload: value.slice(comma + 1) };
}

/**
 * 校验 base64 载荷只含 `A-Za-z0-9+/=` 与 CR/LF，返回去掉换行后的字符串；
 * 非法字符返回 null。逐字符扫描，不用正则。
 */
export function normalizeBase64Payload(payload: string): string | null {
  let hasLineBreak = false;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x2b || code === 0x2f || code === 0x3d // + / =
    ) continue;
    if (code === 0x0d || code === 0x0a) { hasLineBreak = true; continue; }
    return null;
  }
  if (!hasLineBreak) return payload;
  let cleaned = '';
  let start = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 0x0d || code === 0x0a) {
      if (index > start) cleaned += payload.slice(start, index);
      start = index + 1;
    }
  }
  if (start < payload.length) cleaned += payload.slice(start);
  return cleaned;
}

/** 统计去掉空白后的 base64 字符数对应的解码字节数（不解码、不分配）。 */
export function base64DecodedByteLength(payload: string): number {
  let chars = 0;
  let padding = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0x0b) continue;
    chars += 1;
    if (code === 0x3d) padding += 1;
    else padding = 0;
  }
  return Math.max(0, Math.floor((chars * 3) / 4) - Math.min(padding, 2));
}
