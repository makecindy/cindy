import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { app } from 'electron';

import type {
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import type { TranscriptResolveOptions } from './index.js';

const TRANSCRIPTS_DIR = 'subagent-transcripts';

export function getTranscriptsDir(): string {
  return path.join(app.getPath('userData'), TRANSCRIPTS_DIR);
}

export function transcriptFilePath(runId: string): string {
  return path.join(getTranscriptsDir(), `${runId}.json`);
}

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
    entries = parsed.filter(isValidEntry);
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

function isValidEntry(item: unknown): item is SubagentTranscriptEntry {
  if (!item || typeof item !== 'object') return false;
  const entry = item as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sequence === 'number' &&
    typeof entry.role === 'string' &&
    typeof entry.content === 'string' &&
    typeof entry.occurredAt === 'number'
  );
}
