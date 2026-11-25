/**
 * Host MCP tool-result backfill helpers for ACP plugin engines.
 *
 * Some ACP engines (including Antigravity CLI `agy acp`) omit `content` and
 * `rawOutput` on `tool_call_update` for MCP tool calls, settling them with empty
 * output even though Cindy's own HTTP MCP bridge executed the call and returned
 * structured tokens (`xdt_card_id`, `xdt_card_turn_end`, `xdt_image_url`, etc.).
 *
 * This module is the single source of truth shared by `codexHttpBridge` (recording
 * Host MCP `tools/call` receipts), `AcpUpdateTranslator` (local ACP backfill), and
 * `startRemote` (device-hosted ACP backfill).
 */

import type { AgentEvent } from '../../types/events.js';
import type {
  McpToolResultQuery,
  McpToolResultReceipt,
  TakeMcpToolResult,
} from '../base-agent.js';

export const ACP_MCP_RECEIPT_MAX_TEXT_CHARS = 200_000;
const DEFAULT_MAX_RECEIPTS = 64;
const DEFAULT_RECEIPT_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_REMOTE_TOOLS = 512;

export interface ParsedAcpMcpToolName {
  serverName: string;
  toolName: string;
}

export interface RecordedMcpToolResult {
  serverName: string;
  toolName: string;
  input?: unknown;
  fullText: string;
  isError: boolean;
}

export interface McpToolResultBucket {
  record(entry: RecordedMcpToolResult): void;
  take: TakeMcpToolResult;
  clear(): void;
  size(): number;
}

export interface CreateMcpToolResultBucketOptions {
  maxEntries?: number;
  ttlMs?: number;
  maxTextChars?: number;
  now?: () => number;
}

function clipText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses an ACP tool display/wire name into `{ serverName, toolName }`.
 *
 * Supports:
 * - `mcp__<server>__<tool>` (Cindy / Claude / normalized Antigravity MCP format)
 * - `mcp:<server>:<tool>`
 * - `mcp_<sanitizedServer>_<tool>` when `serverNames` is provided (un-normalized ACP agents)
 */
export function parseAcpMcpToolName(
  rawName: string,
  serverNames?: readonly string[],
): ParsedAcpMcpToolName | null {
  if (typeof rawName !== 'string' || rawName.length === 0) return null;
  const sortedServers = serverNames?.length
    ? [...new Set(serverNames.filter((s) => typeof s === 'string' && s.length > 0))]
        .sort((a, b) => b.length - a.length)
    : [];

  if (rawName.startsWith('mcp__')) {
    const rest = rawName.slice(5);
    for (const server of sortedServers) {
      const prefix = `${server}__`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        return { serverName: server, toolName: rest.slice(prefix.length) };
      }
    }
    const sep = rest.indexOf('__');
    if (sep > 0 && sep + 2 < rest.length) {
      return { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
    }
    return null;
  }

  if (rawName.startsWith('mcp:')) {
    const rest = rawName.slice(4);
    for (const server of sortedServers) {
      const prefix = `${server}:`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        return { serverName: server, toolName: rest.slice(prefix.length) };
      }
    }
    const sep = rest.indexOf(':');
    if (sep > 0 && sep + 1 < rest.length) {
      return { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 1) };
    }
    return null;
  }

  if (rawName.startsWith('mcp_') && sortedServers.length > 0) {
    for (const server of sortedServers) {
      const prefix = `mcp_${server.replace(/[^A-Za-z0-9_]/g, '_')}_`;
      if (rawName.startsWith(prefix) && rawName.length > prefix.length) {
        return { serverName: server, toolName: rawName.slice(prefix.length) };
      }
    }
  }

  return null;
}

function canonicalizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => (item === undefined ? null : canonicalizeValue(item, seen)));
    }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const prop = record[key];
      if (prop === undefined) continue;
      sorted[key] = canonicalizeValue(prop, seen);
    }
    return sorted;
  } finally {
    seen.delete(value);
  }
}

/**
 * Produces a stable JSON key for matching an ACP `tool_use` input against the
 * HTTP MCP `tools/call` arguments.
 *
 * Strips Antigravity's injected top-level `toolSummary` field (which `agy-mcp.js`
 * strips from ACP `rawInput` while `agy` still sends it over HTTP MCP) and
 * normalizes `undefined`/`null` to `{}`.
 */
export function canonicalizeMcpToolInput(value: unknown): string {
  let root: unknown = value;
  if (root === undefined || root === null) {
    root = {};
  } else if (isPlainRecord(root) && 'toolSummary' in root) {
    const { toolSummary: _summary, ...rest } = root;
    root = rest;
  }
  try {
    return JSON.stringify(canonicalizeValue(root, new WeakSet())) ?? '{}';
  } catch {
    return '';
  }
}

/**
 * Extracts a secondary routing key for gateway tools (`ghost_call`, `call_tool`,
 * `run_tool`, `describe_tool`, `ghost_info`, `ghost_manual`) so minor argument
 * normalization drift still matches safely without cross-matching different targets.
 */
function secondaryTargetKey(toolName: string, input: unknown): string | null {
  if (!isPlainRecord(input)) return null;
  if (toolName === 'ghost_call') {
    const ghostId = typeof input.ghost_id === 'string' ? input.ghost_id : '';
    const innerTool = typeof input.tool === 'string' ? input.tool : '';
    if (!ghostId || !innerTool) return null;
    const ns = input.namespace === null
      ? 'null'
      : typeof input.namespace === 'string'
        ? `s:${input.namespace}`
        : '';
    return `ghost_call:${ghostId}:${ns}:${innerTool}`;
  }
  if (toolName === 'ghost_info' || toolName === 'ghost_manual') {
    const ghostId = typeof input.ghost_id === 'string' ? input.ghost_id : '';
    return ghostId ? `${toolName}:${ghostId}` : null;
  }
  if (toolName === 'call_tool' || toolName === 'run_tool' || toolName === 'describe_tool') {
    const innerName = typeof input.name === 'string' ? input.name : '';
    return innerName ? `${toolName}:${innerName}` : null;
  }
  return null;
}

interface StoredReceipt {
  serverName: string;
  toolName: string;
  inputKey: string;
  targetKey: string | null;
  fullText: string;
  isError: boolean;
  recordedAt: number;
}

/**
 * Bounded, session-scoped FIFO store for Host MCP `tools/call` outputs.
 *
 * Entries expire lazily on `record` / `take` (no timers) and are discarded when
 * the owning ACP session closes.
 */
export function createMcpToolResultBucket(
  opts: CreateMcpToolResultBucketOptions = {},
): McpToolResultBucket {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_RECEIPTS;
  const ttlMs = opts.ttlMs ?? DEFAULT_RECEIPT_TTL_MS;
  const maxTextChars = opts.maxTextChars ?? ACP_MCP_RECEIPT_MAX_TEXT_CHARS;
  const now = opts.now ?? Date.now;
  const entries: StoredReceipt[] = [];

  const prune = (ts: number): void => {
    while (entries.length > 0 && ts - entries[0]!.recordedAt > ttlMs) {
      entries.shift();
    }
  };

  const consumeAt = (index: number): McpToolResultReceipt => {
    const [hit] = entries.splice(index, 1);
    return { fullText: hit!.fullText, isError: hit!.isError };
  };

  return {
    record(entry: RecordedMcpToolResult): void {
      if (!entry.serverName || !entry.toolName) return;
      if (entry.fullText.length === 0 && !entry.isError) return;
      const ts = now();
      prune(ts);
      while (entries.length >= maxEntries) entries.shift();
      entries.push({
        serverName: entry.serverName,
        toolName: entry.toolName,
        inputKey: canonicalizeMcpToolInput(entry.input),
        targetKey: secondaryTargetKey(entry.toolName, entry.input),
        fullText: clipText(entry.fullText, maxTextChars),
        isError: entry.isError,
        recordedAt: ts,
      });
    },
    take(query: McpToolResultQuery): McpToolResultReceipt | null {
      const ts = now();
      prune(ts);
      if (entries.length === 0) return null;
      const inputKey = canonicalizeMcpToolInput(query.input);
      // 1. Exact match on (serverName, toolName, canonical input), oldest first.
      const exactIdx = entries.findIndex(
        (entry) =>
          entry.serverName === query.serverName &&
          entry.toolName === query.toolName &&
          entry.inputKey === inputKey,
      );
      if (exactIdx >= 0) return consumeAt(exactIdx);

      // 2. Gateway target-identity fallback (same ghost_id+tool or inner tool name).
      const targetKey = secondaryTargetKey(query.toolName, query.input);
      if (targetKey !== null) {
        const targetIdx = entries.findIndex(
          (entry) =>
            entry.serverName === query.serverName &&
            entry.toolName === query.toolName &&
            entry.targetKey === targetKey,
        );
        if (targetIdx >= 0) return consumeAt(targetIdx);
        return null;
      }

      // 3. Unambiguous same-tool fallback for non-gateway tools when only one receipt
      // for (serverName, toolName) is pending.
      let candidateIdx = -1;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.serverName !== query.serverName || entry.toolName !== query.toolName) continue;
        if (candidateIdx >= 0) return null;
        candidateIdx = i;
      }
      return candidateIdx >= 0 ? consumeAt(candidateIdx) : null;
    },
    clear(): void {
      entries.length = 0;
    },
    size(): number {
      prune(now());
      return entries.length;
    },
  };
}

/**
 * Stateful `AgentEvent` mapper used on the controller side of a device-hosted ACP
 * session: remembers open `tool_use` inputs and backfills empty `tool_result_full`
 * payloads from the task owner's Host MCP receipt bucket.
 */
export function createAcpMcpResultBackfiller(opts: {
  takeMcpToolResult: TakeMcpToolResult;
  serverNames?: readonly string[];
  maxTextChars?: number;
}): (event: AgentEvent) => AgentEvent {
  const maxTextChars = opts.maxTextChars ?? ACP_MCP_RECEIPT_MAX_TEXT_CHARS;
  const openTools = new Map<string, { toolName: string; input: unknown }>();
  const failedByBackfill = new Set<string>();

  return (event: AgentEvent): AgentEvent => {
    const data = isPlainRecord(event.data) ? event.data : null;
    if (!data) return event;

    if (event.type === 'tool_use') {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : '';
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      if (toolUseId && toolName) {
        if (openTools.size >= MAX_TRACKED_REMOTE_TOOLS && !openTools.has(toolUseId)) {
          const oldest = openTools.keys().next().value;
          if (oldest !== undefined) openTools.delete(oldest);
        }
        openTools.set(toolUseId, { toolName, input: data.input });
      }
      return event;
    }

    if (event.type === 'tool_result_full') {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : '';
      const tracked = toolUseId ? openTools.get(toolUseId) : undefined;
      if (toolUseId) openTools.delete(toolUseId);
      if (!tracked || typeof data.fullText !== 'string' || data.fullText.length > 0) {
        return event;
      }
      const parsed = parseAcpMcpToolName(tracked.toolName, opts.serverNames);
      if (!parsed) return event;
      const receipt = opts.takeMcpToolResult({
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        input: tracked.input,
      });
      if (!receipt) return event;
      const nextIsError = data.isError === true || receipt.isError;
      if (receipt.isError && data.isError !== true) {
        if (failedByBackfill.size >= MAX_TRACKED_REMOTE_TOOLS) {
          const oldest = failedByBackfill.values().next().value;
          if (oldest !== undefined) failedByBackfill.delete(oldest);
        }
        failedByBackfill.add(toolUseId);
      }
      return {
        ...event,
        data: {
          ...data,
          fullText: clipText(receipt.fullText, maxTextChars),
          isError: nextIsError,
        },
      };
    }

    if (event.type === 'tool_result' && failedByBackfill.size > 0) {
      const ids = Array.isArray(data.toolUseIds)
        ? data.toolUseIds.filter((id): id is string => typeof id === 'string')
        : [];
      let flipped = false;
      for (const id of ids) {
        if (failedByBackfill.delete(id)) flipped = true;
      }
      if (flipped && data.summary === 'done') {
        return { ...event, data: { ...data, summary: 'failed' } };
      }
    }

    return event;
  };
}
