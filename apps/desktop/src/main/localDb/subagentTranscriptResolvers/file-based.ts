import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { app } from 'electron';

import type {
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import type { TranscriptResolveOptions } from './index.js';

export async function resolveFileTranscript(
  relativePath: string,
  options: TranscriptResolveOptions,
): Promise<SubagentTranscriptPageResponse> {
  const unsupported: SubagentTranscriptPageResponse = { supported: false, entries: [] };

  const fullPath = path.join(app.getPath('userData'), relativePath);

  const normalizedBase = path.resolve(app.getPath('userData'));
  const normalizedTarget = path.resolve(fullPath);
  if (!normalizedTarget.startsWith(normalizedBase + path.sep)) {
    return unsupported;
  }

  let raw: string;
  try {
    raw = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return unsupported;
  }

  let entries: SubagentTranscriptEntry[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return unsupported;
    entries = parsed.flatMap(normalizeEntry);
  } catch {
    return unsupported;
  }

  const limit = options.limit ?? 30;
  const startIndex = options.cursor ? parseInt(options.cursor, 10) : 0;
  if (!Number.isFinite(startIndex) || startIndex < 0) {
    return { supported: true, entries: [] };
  }

  const page = entries.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < entries.length;

  return {
    supported: true,
    entries: page,
    ...(hasMore ? { nextCursor: String(startIndex + limit) } : {}),
  };
}

function normalizeEntry(item: unknown): SubagentTranscriptEntry[] {
  if (!item || typeof item !== 'object') return [];
  const entry = item as Record<string, unknown>;
  if (
    typeof entry.id !== 'string' ||
    typeof entry.sequence !== 'number' ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 0 ||
    (entry.role !== 'parent' && entry.role !== 'subagent' && entry.role !== 'tool') ||
    typeof entry.content !== 'string' ||
    typeof entry.occurredAt !== 'number' ||
    !Number.isSafeInteger(entry.occurredAt) ||
    entry.occurredAt < 0
  ) {
    return [];
  }
  if (entry.role === 'tool') {
    if (typeof entry.toolName !== 'string' || !entry.toolName.trim()) return [];
    const toolName = entry.toolName.trim().slice(0, 240);
    return [
      {
        id: entry.id,
        sequence: entry.sequence,
        role: 'tool',
        content: toolName,
        occurredAt: entry.occurredAt,
        toolName,
      },
    ];
  }
  return [
    {
      id: entry.id,
      sequence: entry.sequence,
      role: entry.role,
      content: entry.content,
      occurredAt: entry.occurredAt,
    },
  ];
}
