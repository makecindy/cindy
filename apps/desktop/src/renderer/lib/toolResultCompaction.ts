export interface ToolResultCompactionMarker {
  type: 'tool_result_compacted';
  version: 1;
  originalBytes: number;
  compactedAt: number;
}

export function parseToolResultCompactionMarker(
  content: string | null | undefined,
): ToolResultCompactionMarker | null {
  if (!content || !content.includes('tool_result_compacted')) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed?.type !== 'tool_result_compacted' ||
      parsed.version !== 1 ||
      typeof parsed.originalBytes !== 'number' ||
      !Number.isFinite(parsed.originalBytes) ||
      parsed.originalBytes < 0 ||
      typeof parsed.compactedAt !== 'number' ||
      !Number.isFinite(parsed.compactedAt) ||
      parsed.compactedAt < 0
    ) {
      return null;
    }
    return {
      type: 'tool_result_compacted',
      version: 1,
      originalBytes: parsed.originalBytes,
      compactedAt: parsed.compactedAt,
    };
  } catch {
    return null;
  }
}
