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

function tailHasCurrentInstructions(tail: string, marker: string, truncated: boolean): boolean {
  const lines = tail.split('\n');
  if (truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row?.type === 'compacted') return false;
    if (row?.type !== 'response_item' || row.payload?.role !== 'developer') continue;
    if (!Array.isArray(row.payload.content)) continue;
    const text = row.payload.content.map((part: { text?: string } | null) =>
      typeof part?.text === 'string' ? part.text : '').join('\n');
    if (text.startsWith(PREFIX)) return text.startsWith(`${marker}\n`);
  }
  return false;
}

/** Bounded dedupe only. A missing/compacted/unreadable marker means re-deliver, never skip the guide.
 * Passing a remote reader (even without tail support) never falls through to the local filesystem.
 */
export async function hasCurrentTeammateInstructions(
  rolloutPath: string | undefined,
  marker: string,
  remote?: Pick<RemoteAgentFileOps, 'readFileTail'>,
): Promise<boolean> {
  if (!rolloutPath) return false;
  let file;
  try {
    if (remote) {
      if (!remote.readFileTail) return false;
      const tail = await remote.readFileTail(rolloutPath, TAIL_BYTES);
      return tailHasCurrentInstructions(tail, marker, Buffer.byteLength(tail, 'utf8') >= TAIL_BYTES);
    }
    file = await open(rolloutPath, 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const bytes = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    return tailHasCurrentInstructions(bytes.subarray(0, bytesRead).toString('utf8'), marker, start > 0);
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}
