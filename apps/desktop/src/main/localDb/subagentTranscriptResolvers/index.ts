import type {
  SubagentProvider,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { getDbClient } from '../client/current.js';
import { subagentRunAliases, subagentRuns } from '../schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { resolveClaudeCodeTranscript } from './claude-code.js';
import { resolveFileTranscript } from './file-based.js';

export interface TranscriptResolveOptions {
  cursor?: string;
  limit?: number;
}

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 30;

export async function resolveSubagentTranscript(
  sessionId: string,
  provider: SubagentProvider,
  runIdOrAlias: string,
  options?: TranscriptResolveOptions,
): Promise<SubagentTranscriptPageResponse> {
  const unsupported: SubagentTranscriptPageResponse = { supported: false, entries: [] };
  const row = await findRunRow(sessionId, provider, runIdOrAlias);
  if (!row) return unsupported;

  const limit = Math.min(
    Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  if (provider === 'claude-code') {
    return resolveClaudeCodeTranscript(row, { cursor: options?.cursor, limit });
  }

  if (row.transcriptFile) {
    return resolveFileTranscript(row.transcriptFile, { cursor: options?.cursor, limit });
  }

  return unsupported;
}

async function findRunRow(
  sessionId: string,
  provider: SubagentProvider,
  runIdOrAlias: string,
): Promise<RunRowForTranscript | null> {
  const db = getDbClient().drizzle;

  const [direct] = await db
    .select({
      id: subagentRuns.id,
      sessionId: subagentRuns.sessionId,
      provider: subagentRuns.provider,
      providerRunIds: subagentRuns.providerRunIds,
      transcriptFile: subagentRuns.transcriptFile,
    })
    .from(subagentRuns)
    .where(
      and(
        eq(subagentRuns.sessionId, sessionId),
        eq(subagentRuns.provider, provider),
        eq(subagentRuns.id, runIdOrAlias),
        isNull(subagentRuns.rewindAt),
        isNull(subagentRuns.deletedAt),
      ),
    )
    .limit(1);

  if (direct) return direct;

  const [aliased] = await db
    .select({
      id: subagentRuns.id,
      sessionId: subagentRuns.sessionId,
      provider: subagentRuns.provider,
      providerRunIds: subagentRuns.providerRunIds,
      transcriptFile: subagentRuns.transcriptFile,
    })
    .from(subagentRunAliases)
    .innerJoin(subagentRuns, eq(subagentRunAliases.runId, subagentRuns.id))
    .where(
      and(
        eq(subagentRunAliases.alias, runIdOrAlias),
        eq(subagentRuns.sessionId, sessionId),
        eq(subagentRuns.provider, provider),
        isNull(subagentRuns.rewindAt),
        isNull(subagentRuns.deletedAt),
      ),
    )
    .limit(1);

  return aliased ?? null;
}

export interface RunRowForTranscript {
  id: string;
  sessionId: string;
  provider: SubagentProvider;
  providerRunIds: string;
  transcriptFile: string | null;
}
