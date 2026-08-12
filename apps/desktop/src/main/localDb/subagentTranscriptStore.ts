/**
 * Durable storage for Subagent child-session content.
 *
 * Content is replaced at complete-message boundaries in a Cindy-owned file keyed
 * by the durable run id. Keeping it out of the row avoids unbounded growth in a
 * table that is read on every sidebar refresh, while the file layout stays under
 * Cindy's control rather than any harness's on-disk format.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { app } from 'electron';

import type { SubagentTranscriptEntryInput } from '@cindy/maker-shared/agent-task';
import type { SubagentTranscriptEntry } from '@cindy/maker-shared/subagent-workspace';

import { createLogger } from '../logger';

const log = createLogger('subagent-transcript');

const TRANSCRIPTS_DIR = 'subagent-transcripts';

/** Relative to userData so the stored pointer survives a userData relocation. */
export function transcriptRelativePath(runId: string): string {
  return path.join(TRANSCRIPTS_DIR, `${sanitizeRunId(runId)}.json`);
}

/**
 * Writes the captured content and returns the relative path to store on the row.
 * Returns null when nothing was captured or the write failed — persistence of
 * the run itself must never depend on transcript I/O.
 */
export async function writeSubagentTranscript(
  runId: string,
  entries: SubagentTranscriptEntryInput[],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const relative = transcriptRelativePath(runId);
  const absolute = path.join(app.getPath('userData'), relative);
  const sequenced: SubagentTranscriptEntry[] = entries.map((entry, index) => ({
    id: `${runId}-${index}`,
    sequence: index,
    role: entry.role,
    content: entry.content,
    occurredAt: entry.occurredAt,
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
  }));

  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a half-parsed file
    // behind a row that already advertises it.
    const temp = `${absolute}.tmp`;
    await fs.writeFile(temp, JSON.stringify(sequenced), 'utf-8');
    await fs.rename(temp, absolute);
    return relative;
  } catch (error) {
    log.warn('Subagent transcript write failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Best-effort cleanup for cleared/rewound/deleted runs. */
export async function deleteSubagentTranscript(relativePath: string): Promise<void> {
  const base = path.resolve(app.getPath('userData'));
  const absolute = path.resolve(path.join(base, relativePath));
  if (!absolute.startsWith(base + path.sep)) return;
  await fs.rm(absolute, { force: true }).catch(() => {
    // A leftover file is harmless; it is unreachable once the row is gone.
  });
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}
