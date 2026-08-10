import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import type {
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
  SubagentTranscriptRole,
} from '@cindy/maker-shared/subagent-workspace';

import * as os from 'node:os';
import { findClaudeSessionJsonl } from '../../maker-orchestration/claudeTranscriptAnchors.js';

import { getDbClient } from '../client/current.js';
import { sessions } from '../schema.js';
import { eq } from 'drizzle-orm';
import type { RunRowForTranscript, TranscriptResolveOptions } from './index.js';

const MAX_CONTENT_LENGTH = 64 * 1024;

export async function resolveClaudeCodeTranscript(
  row: RunRowForTranscript,
  options: TranscriptResolveOptions,
): Promise<SubagentTranscriptPageResponse> {
  const unsupported: SubagentTranscriptPageResponse = { supported: false, entries: [] };

  const sdkSessionId = extractSdkSessionId(row.providerRunIds);
  if (!sdkSessionId) return unsupported;

  const workingDir = await getSessionWorkingDir(row.sessionId);
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const projectsRoot = path.join(claudeConfigDir, 'projects');
  const jsonlPath = await findClaudeSessionJsonl(
    sdkSessionId,
    workingDir,
    projectsRoot,
  );
  if (!jsonlPath) return unsupported;

  const exists = await fs.stat(jsonlPath).catch(() => null);
  if (!exists?.isFile()) return unsupported;

  const limit = options.limit ?? 30;
  const startLine = options.cursor ? parseInt(options.cursor, 10) : 0;
  if (!Number.isFinite(startLine) || startLine < 0) {
    return { supported: true, entries: [] };
  }

  const entries: SubagentTranscriptEntry[] = [];
  let lineNumber = 0;
  let collected = 0;

  const stream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (lineNumber < startLine) {
        lineNumber++;
        continue;
      }
      if (collected >= limit) break;

      const entry = parseJsonlLine(line, lineNumber);
      if (entry) {
        entries.push(entry);
        collected++;
      }
      lineNumber++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const hasMore = lineNumber < (exists.size > 0 ? Infinity : 0);
  return {
    supported: true,
    entries,
    ...(collected === limit ? { nextCursor: String(lineNumber) } : {}),
  };
}

function parseJsonlLine(line: string, sequence: number): SubagentTranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const role = mapRole(obj.type as string | undefined, obj.role as string | undefined);
    if (!role) return null;

    const content = extractContent(obj);
    if (!content) return null;

    const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : undefined;
    const timestamp = typeof obj.timestamp === 'number' ? obj.timestamp : Date.now();

    return {
      id: `cc-${sequence}`,
      sequence,
      role,
      content: content.length > MAX_CONTENT_LENGTH
        ? content.slice(0, MAX_CONTENT_LENGTH - 1) + '…'
        : content,
      occurredAt: timestamp,
      ...(toolName ? { toolName } : {}),
    };
  } catch {
    return null;
  }
}

function mapRole(type?: string, role?: string): SubagentTranscriptRole | null {
  if (type === 'tool_use' || type === 'tool_result') return 'tool';
  if (type === 'system') return 'system';
  if (role === 'assistant') return 'subagent';
  if (role === 'user') return 'parent';
  if (type === 'assistant' || type === 'text') return 'subagent';
  return null;
}

function extractContent(obj: Record<string, unknown>): string | null {
  if (typeof obj.content === 'string' && obj.content) return obj.content;
  if (typeof obj.text === 'string' && obj.text) return obj.text;
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const part of obj.content) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') parts.push(p.text);
        else if (typeof p.input === 'string') parts.push(p.input);
        else if (p.type === 'tool_use' && typeof p.name === 'string') {
          parts.push(`[tool: ${p.name}]`);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (typeof obj.input === 'string' && obj.input) return obj.input;
  return null;
}

function extractSdkSessionId(providerRunIdsJson: string): string | null {
  try {
    const ids = JSON.parse(providerRunIdsJson) as unknown[];
    if (!Array.isArray(ids)) return null;
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 10 && !id.includes('/')) {
        return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getSessionWorkingDir(sessionId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ workingDir: sessions.workingDir })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.workingDir ?? null;
}
