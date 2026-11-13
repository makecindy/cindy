import { hasVisibleHistoryResult, isHistoryDetailTool } from '@cindy/maker-shared/message-window';
import { extractToolResultDiagnostics } from '@cindy/maker-shared/tool-result-compaction';
import { CONTROLLER_CAPABILITY_TOOL_RESULT_LIVE_LIMIT_V1 } from '@cindy/device-link';

/**
 * Live limit for ordinary tool results (tool-result-live-limit-v1), the same 256 KB T3 uses
 * for an on-demand body read. Only the live event is limited: the persisted row is already
 * 8 KB and history reads are unchanged. Like the persisted copy (toolResultPersistCap) it
 * keeps the head, then the diagnostics footer (status / error code / failure flag taken from
 * the whole text), then a marker in the Mobile preview's wording.
 */
export const TOOL_RESULT_LIVE_LIMIT_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** UTF-8 head plus footer and marker within `limit` bytes (limit ≥ 1 KB); never splits a character. */
export function limitLiveToolResultText(text: string, limit = TOOL_RESULT_LIVE_LIMIT_BYTES): string {
  if (text.length * 3 <= limit || Buffer.byteLength(text, 'utf8') <= limit) return text;
  const diagnostics = extractToolResultDiagnostics(text);
  const marker = `\n\n[remote content truncated: live result shows first ${Math.floor(limit / 1024)}KB]`;
  const footer = diagnostics ? `\n\n[tool result diagnostics: ${JSON.stringify(diagnostics)}]` : '';
  const suffix = `${footer}${marker}`;
  // Only the head is needed: encode at most `limit` code units (each is ≥ 1 UTF-8 byte).
  const bytes = Buffer.from(text.slice(0, limit), 'utf8');
  let cut = Math.max(0, Math.min(bytes.byteLength, limit - Buffer.byteLength(suffix, 'utf8')));
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return `${bytes.subarray(0, cut).toString('utf8')}${suffix}`;
}

const overLimit = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length * 3 > limit && Buffer.byteLength(value, 'utf8') > limit;

/**
 * One `maker:event` tool_result / tool_result_full push, limited once per distinct base
 * payload for the controllers that declared the capability. Each body copy is limited on
 * its own (a controller that also declared tool-result-event-text-optional-v1 keeps only
 * `resolvedContent`). Eligibility is decided on the first declaring controller, once:
 * - every tool the result answers is an ordinary (detail) tool the Host knows by name;
 * - no copy of the body carries cards, media or files, or process media (the Desktop row
 *   parses those whole); an MCP App flag on the event also keeps it whole.
 */
export function createToolResultLiveLimiter(channel: string, payload: unknown,
  toolName: (sessionId: string, toolUseId: string) => string, limit = TOOL_RESULT_LIVE_LIMIT_BYTES) {
  const push = record(payload);
  const event = channel === 'maker:event' ? record(push?.event) : null;
  const data = record(event?.data);
  const keep = (base: unknown, _supports: (capability: string) => boolean): unknown => base;
  if (!push || !event || !data || (event.type !== 'tool_result' && event.type !== 'tool_result_full')) return keep;
  const bodies = [push.resolvedContent, data.fullText, data.summary];
  if (!bodies.some((body) => overLimit(body, limit))) return keep;
  let eligible: boolean | undefined;
  const isEligible = (): boolean => {
    if (eligible !== undefined) return eligible;
    const sessionId = push.sessionId;
    const ids = typeof data.toolUseId === 'string' ? [data.toolUseId]
      : Array.isArray(data.toolUseIds) ? data.toolUseIds.filter((id): id is string => typeof id === 'string') : [];
    const distinct = [...new Set(bodies.filter((body): body is string => typeof body === 'string'))];
    eligible = typeof sessionId === 'string' && ids.length > 0
      && ids.every((id) => isHistoryDetailTool(toolName(sessionId, id)))
      && !record(event.agentMeta)?.mcpApp
      && !distinct.some((body) => body.includes('cindy_process_media') || hasVisibleHistoryResult(body));
    return eligible;
  };
  const texts = new Map<string, string>();
  const limitText = (text: string) => {
    let limited = texts.get(text);
    if (limited === undefined) texts.set(text, limited = limitLiveToolResultText(text, limit));
    return limited;
  };
  const limited = new Map<unknown, unknown>();
  return (base: unknown, supports: (capability: string) => boolean): unknown => {
    if (!supports(CONTROLLER_CAPABILITY_TOOL_RESULT_LIVE_LIMIT_V1) || !isEligible()) return base;
    if (!limited.has(base)) limited.set(base, limitPush(base, limit, limitText));
    return limited.get(base);
  };
}

function limitPush(base: unknown, limit: number, limitText: (text: string) => string): unknown {
  const push = record(base);
  const event = record(push?.event);
  const data = record(event?.data);
  if (!push || !event || !data) return base;
  const nextData = { ...data };
  for (const key of ['fullText', 'summary'] as const) {
    const value = nextData[key];
    if (overLimit(value, limit)) nextData[key] = limitText(value);
  }
  const resolved = push.resolvedContent;
  return {
    ...push,
    ...(overLimit(resolved, limit) ? { resolvedContent: limitText(resolved) } : {}),
    event: { ...event, data: nextData },
  };
}
