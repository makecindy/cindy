import { sql, type SQL } from 'drizzle-orm';
import { describeToolUse, createdPathsFromDescriptor } from '@cindy/maker-shared/tool-use-descriptor';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { HistoryMessageSource } from '@cindy/maker-shared/message-window';
import { messages } from '../schema';
import { inferHistoryCommandArtifacts, type HistoryCommand } from './historyCommandArtifacts';

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
      -- A send_to_session receipt stays readable: the teammate chat lists the task it started.
      AND NOT (length(${body}) <= 16384 AND instr(${body}, '"target_session_id"') > 0 AND instr(${body}, '"wake_kind"') > 0)
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

type OutlinedRow<T> = T & Pick<HistoryMessageSource, 'historyArtifacts'>;

interface PendingCommand {
  input: HistoryCommand;
  setPaths(paths: readonly string[]): void;
}

function prepareHistoryArtifactRow<T extends HistoryMessageSource>(row: T, commands: PendingCommand[]): OutlinedRow<T> {
  // SDK routing/usage bookkeeping is repeated on thousands of hidden child rows.
  // It has no grouping meaning, but used to exhaust the scan's byte budget before
  // reaching their Agent header. Full bodies and metadata still come from hydrate.
  if (row.agentMeta) {
    const { uuid: _uuid, sdkSessionId: _sdkSessionId, requestId: _requestId,
      replyToClientId: _replyToClientId, usage: _usage, ...agentMeta } = row.agentMeta as Record<string, unknown>;
    row = { ...row, agentMeta };
  }
  if (row.role !== 'tool_use') return row;
  const tool = parseMessageToolUse(row);
  const artifacts = (paths: readonly string[], source: 'command' | 'tool') => paths.map((path) => ({
    path, source, createdAt: row.createdAt, toolUseId: tool.toolUseId,
  }));
  if (tool.toolName === 'Bash' || tool.toolName === 'bash' || tool.toolName === 'exec') {
    const input = tool.input as Record<string, unknown> | null;
    const { command, displayCommand } = input ?? {};
    // Send the full command for inference; only the compact copy enters the
    // scan budget. Full details are hydrated independently from the source.
    const outlined: OutlinedRow<T> = { ...row, content: {
      ...row.content as object,
      input: Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) =>
        [key, (key === 'command' || key === 'displayCommand') && typeof value === 'string'
          ? value.slice(0, 256) : value])),
    } };
    commands.push({
      input: { id: String(row.id), toolName: tool.toolName, input: {
        command: typeof command === 'string' ? command : undefined,
        displayCommand: tool.toolName === 'exec' && typeof displayCommand === 'string' ? displayCommand : undefined,
      } },
      setPaths: (paths) => { if (paths.length) outlined.historyArtifacts = artifacts(paths, 'command'); },
    });
    return outlined;
  }
  const descriptor = describeToolUse(tool.toolName, tool.input);
  const paths = createdPathsFromDescriptor(descriptor);
  const exclusions = descriptor.kind === 'file' && descriptor.action === 'edit'
    ? [{ path: descriptor.filePath, exclude: 'command' as const }]
    : descriptor.kind === 'fileChange' ? descriptor.changes.filter((change) => change.action !== 'add')
      .map((change) => ({ path: change.path, exclude: change.action === 'delete' || change.action === 'move' ? 'all' as const : 'command' as const })) : [];
  if (!paths.length && !exclusions.length) return row;
  return { ...row, historyArtifacts: [...artifacts(paths, 'tool'),
    ...exclusions.map((file) => ({ ...file, source: 'tool' as const, createdAt: row.createdAt, toolUseId: tool.toolUseId }))] };
}

/** File content/patches never cross the outline query; commands yield only paths on the wire. */
export async function withHistoryArtifacts<T extends HistoryMessageSource>(rows: readonly T[]): Promise<OutlinedRow<T>[]> {
  const commands: PendingCommand[] = [];
  const outlined = rows.map((row) => prepareHistoryArtifactRow(row, commands));
  if (commands.length) {
    const paths = await inferHistoryCommandArtifacts(commands.map(({ input }) => input));
    commands.forEach(({ setPaths }, index) => setPaths(paths[index]));
  }
  return outlined;
}
