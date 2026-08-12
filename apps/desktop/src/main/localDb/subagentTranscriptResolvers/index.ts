/**
 * Reads back the child-session content captured for one durable Subagent run.
 *
 * All three harnesses capture during the run and hand bounded snapshots to
 * Cindy, so there is a single read path here. Reading a harness's
 * own on-disk format was considered and rejected: the subagent observation
 * frames carry no handle into those files, and the formats belong to upstream.
 */

import type {
  SubagentProvider,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { getVisibleSubagentTranscriptFile } from '../subagentRuns.js';
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
  const transcriptFile = await getVisibleSubagentTranscriptFile(sessionId, provider, runIdOrAlias);
  // A run with no file yet is still "supported": content lands on the terminal
  // frame, so a running child legitimately has nothing to show.
  if (!transcriptFile) return { supported: false, entries: [] };

  const limit = Math.min(Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const page = await resolveFileTranscript(transcriptFile, { cursor: options?.cursor, limit });
  // Clear/rewind can race the async file read. Re-authorize before returning
  // user-authored content and require the row to still point at the same file.
  const stillVisible = await getVisibleSubagentTranscriptFile(sessionId, provider, runIdOrAlias);
  return stillVisible === transcriptFile ? page : { supported: false, entries: [] };
}
