import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { RemoteAgentFileOps } from '../base-agent.js';

const PREFIX = '<!-- teammate-runtime-context:';
const TAIL_BYTES = 256 * 1024;

/** Native resume config alone does not replace the developer items in a historical thread. */
export function teammateRuntimeInstructionItem(instructions: string) {
  const hash = createHash('sha256').update(instructions).digest('hex');
  const marker = `${PREFIX}${hash} -->`;
  return {
    marker,
    item: {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: `${marker}\nCurrent teammate runtime instructions replace earlier host-provided teammate operating instructions and capability snapshots. Conversation history remains intact.\n\n${instructions}` }],
    },
  };
}

/** 'current' / 'stale' (a later compaction or another generation) / 'unknown' (nothing in the window). */
function tailInstructionState(tail: string, marker: string, truncated: boolean): 'current' | 'stale' | 'unknown' {
  const lines = tail.split('\n');
  if (truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row?.type === 'compacted') return 'stale';
    if (row?.type !== 'response_item' || row.payload?.role !== 'developer') continue;
    if (!Array.isArray(row.payload.content)) continue;
    const text = row.payload.content.map((part: { text?: string } | null) =>
      typeof part?.text === 'string' ? part.text : '').join('\n');
    if (text.startsWith(PREFIX)) return text.startsWith(`${marker}\n`) ? 'current' : 'stale';
  }
  return 'unknown';
}

/** Threads whose delivered marker a process remembers; older ones fall back to the tail check. */
export const DELIVERED_TEAMMATE_INSTRUCTIONS_LIMIT = 256;

/** Remember the marker a process put into a thread, keeping the most recent threads only. Forgetting
 * one only costs a re-delivery when its tail cannot answer, never a skipped guide. */
export function rememberDeliveredTeammateInstructions(delivered: Map<string, string>, threadId: string, marker: string): void {
  delivered.delete(threadId);
  delivered.set(threadId, marker);
  for (const oldest of delivered.keys()) {
    if (delivered.size <= DELIVERED_TEAMMATE_INSTRUCTIONS_LIMIT) break;
    delivered.delete(oldest);
  }
}

/** Bounded dedupe only. A missing/compacted/unreadable marker means re-deliver, never skip the guide.
 * Passing a remote reader (even without tail support) never falls through to the local filesystem.
 * `delivered` is the marker this process itself put into the thread (thread/start or injection); it
 * only answers when the bounded tail shows neither the marker nor a compaction, because one image
 * result is megabytes and a long thread pushes its marker out of the window on every resume.
 */
export async function hasCurrentTeammateInstructions(
  rolloutPath: string | undefined,
  marker: string,
  remote?: Pick<RemoteAgentFileOps, 'readFileTail'>,
  delivered?: string,
): Promise<boolean> {
  if (!rolloutPath) return false;
  let file;
  try {
    let state: 'current' | 'stale' | 'unknown';
    if (remote) {
      if (!remote.readFileTail) return false;
      const tail = await remote.readFileTail(rolloutPath, TAIL_BYTES);
      state = tailInstructionState(tail, marker, Buffer.byteLength(tail, 'utf8') >= TAIL_BYTES);
    } else {
      file = await open(rolloutPath, 'r');
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const bytes = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      state = tailInstructionState(bytes.subarray(0, bytesRead).toString('utf8'), marker, start > 0);
    }
    return state === 'current' || (state === 'unknown' && delivered === marker);
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}
