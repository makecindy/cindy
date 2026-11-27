import { parseMcpAppHistory, projectMcpAppContent, isExceptionalPluginSource } from '@cindy/maker-shared/mcp-apps';
import { uiText } from '../uiText.js';

/** Public provenance is a creation-time snapshot, never a new View grant. */
export function projectMcpAppHistory(content: unknown, marked = false): unknown {
  const projected = projectMcpAppContent(content, marked);
  if (!marked) return projected;
  const history = parseMcpAppHistory(projected)!;
  const source = history.plugin?.source;
  const title = history.plugin ? history.plugin.name + (source && isExceptionalPluginSource(source)
    ? ` · ${uiText(`mcpApps.source.${source.kind}`, source.kind)}` : '') : history.customMcp && history.customMcp !== true
      ? `${history.customMcp.name} · ${uiText('mcpApps.customMcp', 'Custom MCP')}` : history.title;
  return { mcpAppHistory: { version: 1, ...history, title } };
}
