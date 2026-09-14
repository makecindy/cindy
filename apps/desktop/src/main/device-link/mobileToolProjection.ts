import { isAgentTaskToolName } from '@cindy/maker-shared/agent-task';
import { isAgentPlanToolName } from '@cindy/maker-shared/message-render';
import { isOrcaCommunicationTool } from '@cindy/maker-shared/message-normalize';
import {
  extractPayloadToolResultMedia,
  formatPayloadToolUseSummary,
} from '@cindy/maker-shared/payload-summary';

export const MOBILE_TOOL_INPUT_BYTES = 4 * 1024;
export const MOBILE_TOOL_RESULT_BYTES = 8 * 1024;
export const MOBILE_HISTORY_PAGE_BYTES = 256 * 1024;
const TRUNCATION_SUFFIX = '\n\n[remote content truncated: payload too large]';
const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** UI models still derive plans, child agents, diffs and approvals from full input. */
function canProjectInput(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && toolName.length > 0
    && !['AskUserQuestion', 'ExitPlanMode', 'Edit', 'Write', 'MultiEdit', 'edit', 'write'].includes(toolName)
    && !isAgentTaskToolName(toolName) && !isAgentPlanToolName(toolName)
    && !/(?:^|:|__)(?:create_worker|create_workers|send_to_worker)$/.test(toolName)
    && !isOrcaCommunicationTool(toolName);
}

function exceedsInputBudget(input: unknown): boolean {
  try {
    const serialized = JSON.stringify(input);
    return serialized !== undefined && encoder.encode(serialized).byteLength > MOBILE_TOOL_INPUT_BYTES;
  } catch {
    // A malformed live payload must not break the host's local broadcast through its tap.
    return false;
  }
}

/** Preserve structured results and all media/file references until a typed detail projection
 * exists. Cutting JSON or a reference-bearing string would silently remove artifacts. */
export function projectMobileToolResult(content: unknown): unknown {
  if (typeof content !== 'string' || encoder.encode(content).byteLength <= MOBILE_TOOL_RESULT_BYTES) return content;
  // Keep structured media payloads intact because truncating them can drop an artifact
  // reference. Plain URLs, action markers, errors, and arbitrary JSON remain bounded.
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && extractPayloadToolResultMedia(content).length > 0) {
      return content;
    }
  } catch { /* Plain tool output is the only format shortened in this phase. */ }
  const bytes = encoder.encode(content);
  let cut = MOBILE_TOOL_RESULT_BYTES - encoder.encode(TRUNCATION_SUFFIX).byteLength;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return new TextDecoder().decode(bytes.subarray(0, cut)) + TRUNCATION_SUFFIX;
}

/** Pure, per-controller wire projection. Never changes the host row or agent transcript.
 * Reuse Mobile's existing radius-0 detail reference rather than marking input irretrievable. */
export function projectMobileToolMessage(message: unknown): unknown {
  const row = record(message);
  if (!row) return message;
  const meta = record(row.agentMeta);
  if (row.role === 'tool_use') {
    const content = record(row.content);
    const toolName = content?.toolName;
    const toolUseId = row.toolUseId || content?.toolUseId;
    if (!content || !canProjectInput(toolName) || typeof row.id !== 'string' || !row.id
      || typeof toolUseId !== 'string' || !toolUseId || row.mobileToolInputProjection
      || meta?.remoteContentTruncated === true || !exceedsInputBudget(content.input)) return message;
    return {
      ...row,
      content: { ...content, input: null, mobilePayloadProjected: true },
      mobileToolInputProjection: {
        projected: true,
        version: 1,
        summary: formatPayloadToolUseSummary(toolName, content.input).slice(0, 480),
        toolName,
        toolUseId,
        toolUseMessageId: row.id,
      },
    };
  }
  if (row.role !== 'tool_result') return message;
  const content = projectMobileToolResult(row.content);
  // A current result preview must replace an earlier summary of the same row.
  // remoteContentTruncated is reserved for transport fallback: Mobile deliberately
  // refuses that content when it already has a usable row. Preserve a pre-existing
  // fallback flag, but never set it merely because we generated a bounded preview.
  return content === row.content ? message : {
    ...row, content, agentMeta: { ...meta, mobileToolResultProjected: true },
  };
}

/** Keep event ordering/identity and status signals. Mobile obtains ordinary tool rows from
 * messages:created; resolvedContent is the Desktop renderer's duplicate result body. */
export function projectMobileToolPush(channel: string, payload: unknown): unknown {
  const push = record(payload);
  if (!push) return payload;
  if (channel === 'local-db:messages:created') {
    const message = projectMobileToolMessage(push.message);
    return message === push.message ? payload : { ...push, message };
  }
  if (channel !== 'maker:event') return payload;
  const event = record(push.event);
  const data = record(event?.data);
  if (!event || !data || !['tool_use', 'tool_result', 'tool_result_full'].includes(String(event.type))) return payload;
  let projectedData = data;
  if (event.type === 'tool_use') {
    if (canProjectInput(data.toolName) && exceedsInputBudget(data.input)) {
      projectedData = { ...data, input: null };
    }
  } else {
    for (const key of ['fullText', 'summary']) {
      const preview = projectMobileToolResult(data[key]);
      if (preview !== data[key]) projectedData = { ...projectedData, [key]: preview };
    }
  }
  if (projectedData === data && !('resolvedContent' in push)) return payload;
  const { resolvedContent: _, ...rest } = push;
  return { ...rest, event: { ...event, data: projectedData } };
}

/** Soft byte budget: one intact row always progresses, even for a large assistant reply.
 * `after` pages are returned descending by the IPC despite selecting the oldest delta first. */
export function projectMobileMessagePage(messages: unknown[], options: unknown): unknown[] {
  const rows = messages.map(projectMobileToolMessage);
  const opts = record(options);
  const forward = typeof opts?.after === 'string' && !!opts.after && !opts.before && opts.beforeTs == null;
  const ordered = forward ? rows.slice().reverse() : rows;
  let bytes = 1024; // Envelope and trimmed-window metadata allowance.
  let keep = 0;
  for (const row of ordered) {
    const size = encoder.encode(JSON.stringify(row)).byteLength + 256;
    if (keep > 0 && bytes + size > MOBILE_HISTORY_PAGE_BYTES) break;
    bytes += size;
    keep += 1;
  }
  if (keep === rows.length) return rows;
  const selected = forward ? rows.slice(-keep) : rows.slice(0, keep);
  return selected.map((row) => {
    const value = record(row);
    return value ? {
      ...value,
      agentMeta: { ...record(value.agentMeta), remoteRowsTrimmed: true, remoteOriginalRowCount: rows.length },
    } : row;
  });
}
