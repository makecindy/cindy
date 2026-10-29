export interface ToolResultCompactionMarker {
  type: 'tool_result_compacted';
  version: 1;
  originalBytes: number;
  compactedAt: number;
}

export function parseToolResultCompactionMarker(
  content: unknown,
): ToolResultCompactionMarker | null {
  let parsed = content;
  if (typeof parsed === 'string') {
    if (!parsed.includes('tool_result_compacted')) return null;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    record.type !== 'tool_result_compacted' ||
    record.version !== 1 ||
    typeof record.originalBytes !== 'number' ||
    !Number.isFinite(record.originalBytes) ||
    record.originalBytes < 0 ||
    typeof record.compactedAt !== 'number' ||
    !Number.isFinite(record.compactedAt) ||
    record.compactedAt < 0
  ) {
    return null;
  }
  return {
    type: 'tool_result_compacted',
    version: 1,
    originalBytes: record.originalBytes,
    compactedAt: record.compactedAt,
  };
}

const COMPACTED_BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatToolResultCompactionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  // 先取整字节数,再交替换档位:1048575 B 属于 MB 档,不该停在 KB 档被四舍五入成
  // "1024 KB" —— 那一档的合法最大值是 1023,超过就该升到下一档。
  let value = Math.round(bytes);
  let unit = 0;
  while (value >= 1024 && unit < COMPACTED_BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  for (;;) {
    // 展示值也可能因为取整跨过 1024(1023.6 KB → "1024"),此时同样要升档。
    // 各档原有精度保持不变:KB 小于 10 保留一位小数、其余取整;MB 与 GB 始终一位小数。
    const text =
      unit === 0
        ? `${value}`
        : unit === 1
          ? value < 10
            ? value.toFixed(1)
            : `${Math.round(value)}`
          : value.toFixed(1);
    if (Number(text) < 1024 || unit === COMPACTED_BYTE_UNITS.length - 1) {
      return `${text} ${COMPACTED_BYTE_UNITS[unit]}`;
    }
    value = Number(text) / 1024;
    unit += 1;
  }
}

