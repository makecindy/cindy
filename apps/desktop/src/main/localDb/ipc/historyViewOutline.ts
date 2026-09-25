import { sql, type SQL } from 'drizzle-orm';
import { describeToolUse, createdPathsFromDescriptor } from '@cindy/maker-shared/tool-use-descriptor';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { HistoryMessageSource } from '@cindy/maker-shared/message-window';
import { extractCommandOutputPathCandidates } from '../../../shared/commandOutputPaths';
import { messages } from '../schema';

/** Read-model headers only. Full content is read by ID after visible items are selected.
 * Candidate artifact results are conservative: the shared parser remains authoritative.
 * Invalid legacy JSON stays intact instead of disappearing from the history.
 */
export function historyOutlineContent(): SQL<string> {
  const body = messages.content;
  return sql<string>`CASE
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


/** File content/patches never cross the outline query; commands yield only paths on the wire. */
export function withHistoryArtifacts<T extends HistoryMessageSource>(row: T): T & Pick<HistoryMessageSource, 'historyArtifacts'> {
  if (row.role !== 'tool_use') return row;
  const tool = parseMessageToolUse(row);
  const descriptor = describeToolUse(tool.toolName, tool.input);
  const paths = descriptor.kind === 'command'
    ? extractCommandOutputPathCandidates(descriptor.command) : createdPathsFromDescriptor(descriptor);
  const exclusions = descriptor.kind === 'file' && descriptor.action === 'edit'
    ? [{ path: descriptor.filePath, exclude: 'command' as const }]
    : descriptor.kind === 'fileChange' ? descriptor.changes.filter((change) => change.action !== 'add')
      .map((change) => ({ path: change.path, exclude: change.action === 'delete' || change.action === 'move' ? 'all' as const : 'command' as const })) : [];
  if (!paths.length && !exclusions.length) return row;
  return { ...row, historyArtifacts: [...paths.map((path) => ({ path,
    source: descriptor.kind === 'command' ? 'command' : 'tool',
    createdAt: row.createdAt, toolUseId: tool.toolUseId,
  } as const)), ...exclusions.map((file) => ({ ...file, source: 'tool' as const, createdAt: row.createdAt, toolUseId: tool.toolUseId }))] };
}
