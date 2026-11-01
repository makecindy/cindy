import { sql, type SQL } from 'drizzle-orm';
import { describeToolUse, createdPathsFromDescriptor } from '@cindy/maker-shared/tool-use-descriptor';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { GHOST_CALL_TOOL_NAMES, isGhostCallToolName } from '@cindy/maker-shared/ghost-command';
import type { HistoryMessageSource } from '@cindy/maker-shared/message-window';
import { extractCommandOutputPathCandidates } from '../../../shared/commandOutputPaths';
import { messages } from '../schema';

/** Read-model headers only. Full content is read by ID after visible items are selected.
 * Candidate artifact results are conservative: the shared parser remains authoritative.
 * Invalid legacy JSON stays intact instead of disappearing from the history.
 * Plain-text tool output (Codex stores most results this way) is folded like a
 * JSON result; otherwise one long turn exhausts the scan budget on outlines alone.
 * Media and card payloads require JSON, so plain text can only carry `xdt-file://`
 * links or a bare `cindy-media://` URL. Real deliveries are short; long logs that
 * merely mention those schemes are folded too.
 */
export function historyOutlineContent(): SQL<string> {
  const body = messages.content;
  return sql<string>`CASE
    WHEN ${messages.role} = 'tool_result' AND NOT json_valid(${body})
      AND NOT (length(${body}) <= 16384
        AND (instr(${body}, 'xdt-file://') > 0 OR instr(${body}, 'cindy-media://') > 0))
      THEN json_quote(CASE WHEN instr(${body}, '<tool_use_error>') > 0 THEN '<tool_use_error>' ELSE '' END)
    WHEN NOT json_valid(${body}) THEN ${body}
    WHEN ${messages.role} = 'thinking' THEN json_object('isRedacted', json(CASE
      WHEN (json_type(${body}, '$') = 'text' AND length(json_extract(${body}, '$')) > 0)
        OR length(json_extract(${body}, '$.text')) > 0 OR json_extract(${body}, '$.isRedacted') = 1
      THEN 'true' ELSE 'false' END),
      'durationMs', json_extract(${body}, '$.durationMs'))
    WHEN ${messages.role} = 'tool_use' AND (
      COALESCE(json_extract(${body}, '$.input.outPath'), json_extract(${body}, '$.input.out_path'),
        json_extract(${body}, '$.input.outputPath'), json_extract(${body}, '$.input.output_path'),
        json_extract(${body}, '$.input.args.outPath'), json_extract(${body}, '$.input.args.out_path'),
        json_extract(${body}, '$.input.args.outputPath'), json_extract(${body}, '$.input.args.output_path')) IS NOT NULL
      ) THEN ${body}
    WHEN ${messages.role} = 'tool_use' AND json_extract(${body}, '$.toolName') IN (${sql.join(GHOST_CALL_TOOL_NAMES.map(name => sql`${name}`), sql`, `)})
      THEN json_object('toolName', json_extract(${body}, '$.toolName'),
        'toolUseId', json_extract(${body}, '$.toolUseId'),
        'input', json(CASE WHEN json_type(${body}, '$.input.namespace') IS NULL
          THEN json_object('ghost_id', json_extract(${body}, '$.input.ghost_id'))
          ELSE json_object('ghost_id', json_extract(${body}, '$.input.ghost_id'),
            'namespace', json_extract(${body}, '$.input.namespace')) END))
    WHEN ${messages.role} = 'tool_use' THEN json_object(
      'toolName', json_extract(${body}, '$.toolName'),
      'toolUseId', json_extract(${body}, '$.toolUseId'),
      'input', CASE WHEN json_extract(${body}, '$.toolName') = 'cindy_mcp_call_tool'
        THEN json_object('server', json_extract(${body}, '$.input.server'), 'tool', json_extract(${body}, '$.input.tool'))
        ELSE json_object('file_path', json_extract(${body}, '$.input.file_path'),
          'path', json_extract(${body}, '$.input.path'),
          'command', json_extract(${body}, '$.input.command'),
          'displayCommand', json_extract(${body}, '$.input.displayCommand'),
          'changes', json(COALESCE((SELECT json_group_array(json_object('path', json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.path'),
            'kind', json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.kind'),
            'move_path', json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.move_path'),
            'movePath', json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.movePath'),
            'diff', CASE WHEN json_type(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.diff') = 'text' THEN '' END))
            FROM json_each(${body}, '$.input.changes')), '[]')))
        END)
    WHEN ${messages.role} = 'tool_result'
      AND instr(${body}, 'xdt_') = 0 AND instr(${body}, 'xdt-file:') = 0 AND instr(${body}, 'cindy-media:') = 0
      THEN json_quote(CASE WHEN instr(${body}, '<tool_use_error>') > 0 OR CASE
        WHEN json_valid(json_extract(${body}, '$')) THEN
          json_extract(json_extract(${body}, '$'), '$.ok') IS 0
          OR json_extract(json_extract(${body}, '$'), '$.success') IS 0
          OR lower(json_extract(json_extract(${body}, '$'), '$.status')) IN ('error', 'failed', 'failure')
        ELSE 0 END THEN '<tool_use_error>' ELSE '' END)
    WHEN ${messages.role} = 'assistant'
      AND length(CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.parentUuid') END) > 0 THEN json_quote('')
    ELSE ${body} END`;
}


/**
 * Command artifact inference is CPU work on the main thread, repeated for every
 * outline page of the same immutable tool_use row (切换伙伴即重算, #5503). Cache the
 * inferred paths per row; the key carries the command length and a content hash so
 * a re-used id with different text never serves stale paths.
 */
const COMMAND_ARTIFACT_CACHE_LIMIT = 2048;
const commandArtifactCache = new Map<string, readonly string[]>();

function commandArtifactCacheKey(id: string, command: string): string {
  let hash = 2166136261;
  for (let index = 0; index < command.length; index += 1) {
    hash ^= command.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${id}\u0000${command.length}\u0000${hash >>> 0}`;
}

function cachedCommandArtifacts(id: string, command: string): readonly string[] {
  const key = commandArtifactCacheKey(id, command);
  const hit = commandArtifactCache.get(key);
  if (hit) {
    // Refresh recency so hot sessions stay cached while old pages age out.
    commandArtifactCache.delete(key);
    commandArtifactCache.set(key, hit);
    return hit;
  }
  const paths = extractCommandOutputPathCandidates(command);
  if (commandArtifactCache.size >= COMMAND_ARTIFACT_CACHE_LIMIT) {
    const oldest = commandArtifactCache.keys().next().value;
    if (oldest !== undefined) commandArtifactCache.delete(oldest);
  }
  commandArtifactCache.set(key, paths);
  return paths;
}

/** Test seam: cache occupancy, and a reset so individual tests start cold. */
export function commandArtifactCacheSize(): number {
  return commandArtifactCache.size;
}
export function resetCommandArtifactCache(): void {
  commandArtifactCache.clear();
}

/**
 * An approximate fact that changes when a hidden body is rewritten in place (a later full
 * tool result, a background completion). The outline already reads every body, so length
 * and tail add CPU but no IO; grouping revisions hash it, and it never reaches the wire.
 * A rewrite with the same length and the same last 24 characters is not detected.
 * Keep that character-length contract: byte length would miss edits whose UTF-8 byte
 * count stays constant while their character count changes. A 96-byte suffix covers
 * the maximum UTF-8 span of the legacy 24-character suffix; hex keeps a truncated
 * leading code point opaque but comparable. Embedded NUL needs the legacy path because
 * SQLite text functions deliberately stop there.
 */
export function historyOutlineContentStamp(): SQL<string> {
  return sql<string>`CASE
    WHEN typeof(${messages.content}) <> 'text'
      OR instr(CAST(${messages.content} AS BLOB), x'00') > 0
      THEN length(${messages.content}) || ':' || substr(${messages.content}, -24)
    ELSE length(${messages.content}) || ':' || hex(
      substr(CAST(${messages.content} AS BLOB), -96))
    END`;
}

/** File content/patches never cross the outline query; commands yield only paths on the wire. */
export function withHistoryArtifacts<T extends HistoryMessageSource>(row: T): T & Pick<HistoryMessageSource, 'historyArtifacts'> {
  // SDK routing/usage bookkeeping is repeated on thousands of hidden child rows.
  // It has no grouping meaning, but used to exhaust the scan's byte budget before
  // reaching their Agent header. Full bodies and metadata still come from hydrate.
  if (row.agentMeta) {
    const { uuid: _uuid, sdkSessionId: _sdkSessionId, requestId: _requestId,
      replyToClientId: _replyToClientId, usage: _usage, ...agentMeta } = row.agentMeta as Record<string, unknown>;
    row = { ...row, agentMeta };
    // Folded plugin rows are not hydrated until expanded. Preserve only the
    // ownership link needed by their summary, alongside the small outline input.
    if (row.role === 'tool_use' && isGhostCallToolName(parseMessageToolUse(row).toolName) && _replyToClientId) {
      row = { ...row, agentMeta: { ...agentMeta, replyToClientId: _replyToClientId } };
    }
  }
  if (row.role !== 'tool_use') return row;
  const tool = parseMessageToolUse(row);
  const descriptor = describeToolUse(tool.toolName, tool.input);
  const paths = descriptor.kind === 'command'
    ? [...cachedCommandArtifacts(String(row.id), descriptor.command)] : createdPathsFromDescriptor(descriptor);
  const exclusions = descriptor.kind === 'file' && descriptor.action === 'edit'
    ? [{ path: descriptor.filePath, exclude: 'command' as const }]
    : descriptor.kind === 'fileChange' ? descriptor.changes.filter((change) => change.action !== 'add')
      .map((change) => ({ path: change.path, exclude: change.action === 'delete' || change.action === 'move' ? 'all' as const : 'command' as const })) : [];
  // Extract from the complete command first: output paths may occur after a
  // long script/heredoc. Only the bounded outline enters the scan budget/cache;
  // visible messages and expanded details are hydrated from the original row.
  const outlined = descriptor.kind === 'command' ? { ...row, content: {
    ...row.content as object,
    input: Object.fromEntries(Object.entries((tool.input ?? {}) as Record<string, unknown>).map(([key, value]) =>
      [key, (key === 'command' || key === 'displayCommand') && typeof value === 'string'
        ? value.slice(0, 256) : value])),
  } } : row;
  if (!paths.length && !exclusions.length) return outlined;
  return { ...outlined, historyArtifacts: [...paths.map((path) => ({ path,
    source: descriptor.kind === 'command' ? 'command' : 'tool',
    createdAt: row.createdAt, toolUseId: tool.toolUseId,
  } as const)), ...exclusions.map((file) => ({ ...file, source: 'tool' as const, createdAt: row.createdAt, toolUseId: tool.toolUseId }))] };
}
