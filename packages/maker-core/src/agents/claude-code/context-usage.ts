import type { ContextUsageData } from '../../types/context-usage.js';

/**
 * The SDK's per-tool isLoaded flag tracks search-loaded definitions even when
 * ToolSearch is off. Its MCP category uses the runtime search decision (including
 * auto thresholds and compatibility fallback), so require that evidence before
 * presenting an individual tool as deferred. Missing evidence means unknown,
 * not loaded. Token counts and category/total math remain the SDK's own values.
 */
export function normalizeClaudeContextUsage(usage: ContextUsageData): ContextUsageData {
  const hasDeferredMcp = Array.isArray(usage.categories) && usage.categories.some(category => {
    const isMcp = ('id' in category && category.id === 'mcp_tools_deferred')
      || category.name === 'MCP tools (deferred)';
    const kind = 'kind' in category ? category.kind : undefined;
    return isMcp && (kind === 'deferred' || (kind === undefined && category.isDeferred === true));
  });
  if (hasDeferredMcp || !Array.isArray(usage.mcpTools)
    || !usage.mcpTools.some(tool => tool.isLoaded === false)) return usage;
  return {
    ...usage,
    mcpTools: usage.mcpTools.map(tool => tool.isLoaded === false
      ? { ...tool, isLoaded: undefined }
      : tool),
  };
}
