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

export function formatToolResultCompactionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
