/**
 * 搜索模式：composer「+」菜单里、协同下面的会话级开关。
 *
 * 打开后帮手 / 插件 / 浏览器真挡，启动时不把 skill 列表喂给模型。
 * 说明只进发给模型的 wire 消息，不改用户气泡原文。
 */

export const SEARCH_MODE_PROMPT = [
  '[Cindy search mode]',
  'Use public web search and opened pages only. Helpers, plugins, skills, and browser tools are blocked.',
  'When you can classify the answer, stop and write. Do not page through long lists. Put unverified facts under gaps.',
].join('\n');

const SEARCH_QUERY_TOOLS = new Set(['websearch', 'web_search']);
const SEARCH_FETCH_TOOLS = new Set(['webfetch', 'web_fetch']);

const SEARCH_RITUAL_TOOLS = new Set([
  'task',
  'agent',
  'subagent',
  'skill',
  'enterplanmode',
  'collab:spawn',
  'collab:spawnagent',
]);

const SEARCH_RITUAL_PREFIXES = [
  'mcp__cindy_browser__',
  'mcp__cindy_computer__',
  'mcp__cindy_orca__',
  'mcp__cindy_helper__',
  'mcp__cindy__ghost_',
  'mcp__taptap-maker__',
  'collab:',
];

export function shouldApplySearchMode(enabled: boolean | null | undefined): boolean {
  return enabled === true;
}

export function normalizeSearchToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export function isSearchQueryTool(toolName: string): boolean {
  const name = normalizeSearchToolName(toolName);
  if (SEARCH_QUERY_TOOLS.has(name)) return true;
  return name.includes('websearch') || name.includes('web_search');
}

export function isSearchFetchTool(toolName: string): boolean {
  const name = normalizeSearchToolName(toolName);
  if (SEARCH_FETCH_TOOLS.has(name)) return true;
  return name.includes('webfetch') || name.includes('web_fetch');
}

export function isSearchLookupTool(toolName: string): boolean {
  return isSearchQueryTool(toolName) || isSearchFetchTool(toolName);
}

export function isSearchRitualTool(toolName: string): boolean {
  const name = normalizeSearchToolName(toolName);
  if (SEARCH_RITUAL_TOOLS.has(name)) return true;
  if (SEARCH_RITUAL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (name.startsWith('mcp__') && !isSearchLookupTool(toolName)) return true;
  if (name.includes('get_capabilities') || name.includes('list_tools')) return true;
  return false;
}
