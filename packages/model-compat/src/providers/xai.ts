/** Cindy provider policies, consolidated from codex-proxy-host. Route selection stays in the host. */
import { isPlainObject } from "../object";
import { normalizeXaiResponsesWebSearch } from "../upstream/adapters/xai-web-search";

export const XAI_SUPPORTED_TOOL_TYPES = new Set([
  'function',
  'web_search',
  'x_search',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
]);

export function xaiToolChoiceAfterSanitize(
  toolChoice: unknown,
  tools: readonly unknown[],
): unknown {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return toolChoice;

  const referencesSurvivingTool = (choice: Record<string, unknown>) => tools.some((tool) => {
    if (!isPlainObject(tool) || tool.type !== choice.type) return false;
    if (choice.type !== 'function') return true;
    return typeof choice.name === 'string' && tool.name === choice.name;
  });

  if (toolChoice.type === 'allowed_tools' && Array.isArray(toolChoice.tools)) {
    const allowedTools = toolChoice.tools.filter(
      (choice): choice is Record<string, unknown> => isPlainObject(choice) && referencesSurvivingTool(choice),
    );
    return allowedTools.length > 0 ? { ...toolChoice, tools: allowedTools } : 'none';
  }

  // Fail closed: a forced choice that references a removed tool (e.g. a
  // cache-only web_search that was dropped, or an unsupported namespace tool)
  // must NOT widen into 'auto', which would let the model call surviving tools
  // the caller never authorized. Collapse to 'none' so no tool is callable.
  return referencesSurvivingTool(toolChoice) ? toolChoice : 'none';
}

export function sanitizeXaiTools(
  body: Record<string, unknown>,
  options: { preserveNoneToolChoice?: boolean; preserveSerialToolCalls?: boolean } = {},
): Record<string, unknown> | null {
  // This policy is invoked only after the host selects the xAI dialect, including its
  // explicitly identified gateway route. The vendor predicate remains exact-host scoped.
  const normalized = normalizeXaiResponsesWebSearch(body, { baseUrl: 'https://api.x.ai/v1' });
  const source = isPlainObject(normalized) ? normalized : body;
  let changed = source !== body;
  const declared = Array.isArray(source.tools) ? source.tools : [];
  const tools = declared.filter(tool => isPlainObject(tool)
    && typeof tool.type === 'string' && XAI_SUPPORTED_TOOL_TYPES.has(tool.type));
  changed ||= tools.length !== declared.length;
  const next: Record<string, unknown> = { ...source };
  const loadedTools: unknown[] = [];
  if (Array.isArray(source.input)) {
    const input = source.input.flatMap(item => {
      if (!isPlainObject(item) || item.type !== 'additional_tools' || !Array.isArray(item.tools)) return [item];
      const supported = item.tools.filter(tool => isPlainObject(tool)
        && typeof tool.type === 'string' && XAI_SUPPORTED_TOOL_TYPES.has(tool.type));
      loadedTools.push(...supported);
      if (supported.length === item.tools.length) return [item];
      changed = true;
      return supported.length ? [{ ...item, tools: supported }] : [];
    });
    if (changed) next.input = input;
  }
  const choice = xaiToolChoiceAfterSanitize(source.tool_choice, [...tools, ...loadedTools]);
  changed ||= choice !== source.tool_choice;
  changed ||= tools.length === 0 && loadedTools.length === 0 && (Array.isArray(source.tools) || source.tool_choice !== undefined || source.parallel_tool_calls !== undefined);
  if (!changed) return null;
  if (tools.length > 0 || loadedTools.length > 0) {
    if (tools.length > 0) next.tools = tools; else delete next.tools;
    if (choice !== undefined) next.tool_choice = choice;
  } else {
    delete next.tools;
    // All declared tools were filtered out. When server-side x_search is
    // re-injected afterwards, a tool_choice that *references a removed tool*
    // (an object forced choice, an emptied allowed_tools, or 'required') must
    // collapse to 'none' so the model cannot widen the caller's authorization
    // by auto-calling the injected search. 'auto' does NOT reference a
    // specific tool — it means "choose any available tool" — so it stays,
    // letting Grok use the re-injected x_search as the caller intended; a
    // request that had no tool_choice (or already 'none') is left untouched.
    // When nothing is re-injected (Guardian / cache-only search), drop the
    // control field entirely — a 'none' with no tools is still an invalid xAI
    // request (PR #2444 Codex P1/P2).
    if (options.preserveNoneToolChoice) {
      const choice = next.tool_choice;
      if (
        choice !== undefined
        && choice !== 'none'
        && choice !== 'auto'
      ) {
        next.tool_choice = 'none';
      }
    } else {
      delete next.tool_choice;
    }
    if (!options.preserveSerialToolCalls) {
      delete next.parallel_tool_calls;
    }
  }
  return next;
}

export function hasCacheOnlySearchProhibition(body: Record<string, unknown>): boolean {
  const groups = [body.tools, ...(Array.isArray(body.input) ? body.input.flatMap(item =>
    isPlainObject(item) && item.type === 'additional_tools' ? [item.tools] : []) : [])];
  return groups.some(group => Array.isArray(group) && group.some(tool =>
    isPlainObject(tool) && (tool.type === 'web_search' || tool.type === 'web_search_preview')
      && Object.hasOwn(tool, 'external_web_access') && tool.external_web_access !== true));
}
