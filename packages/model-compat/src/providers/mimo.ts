import { isPlainObject } from '../object';
import { resolveProviderCompatibilityProfile, type CompatibilityRoute } from '../profiles';

const HOSTED_SEARCH_TYPES = new Set(['web_search', 'web_search_preview']);
const isHostedSearch = (value: unknown): boolean =>
  isPlainObject(value) && typeof value.type === 'string' && HOSTED_SEARCH_TYPES.has(value.type);

/** Channel capability policy shared by ordinary and frozen Codex Responses routes. */
export function normalizeUnsupportedCodexWebSearch(body: Record<string, unknown>, route: CompatibilityRoute): Record<string, unknown> {
  if (route.harness !== 'codex' || route.protocol !== 'openai-responses') return body;
  const profile = resolveProviderCompatibilityProfile(route);
  return profile?.id === 'xiaomi-mimo' || profile?.id === 'mimo'
    ? normalizeMimoResponsesWebSearch(body) : body;
}

/**
 * MiMo's Responses gateway rejects hosted search; its separately billed search plugin is
 * Chat Completions only. Apply only after resolving the actual endpoint and protocol.
 * https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search
 */
function normalizeMimoResponsesWebSearch(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;
  const change = (): Record<string, unknown> => next === body ? (next = { ...body }) : next;
  const tools = Array.isArray(body.tools) ? body.tools.filter(tool => !isHostedSearch(tool)) : undefined;
  const choice = body.tool_choice;
  if (isHostedSearch(choice)) throw new Error('MiMo Responses does not support tool_choice.web_search');
  if (tools && tools.length !== (body.tools as unknown[]).length) {
    if (choice === 'required' && tools.length === 0) {
      throw new Error('MiMo Responses cannot satisfy required hosted web search');
    }
    if (tools.length) change().tools = tools;
    else {
      delete change().tools;
      delete change().parallel_tool_calls;
      delete change().tool_choice;
    }
  }
  if (isPlainObject(choice) && choice.type === 'allowed_tools' && Array.isArray(choice.tools)) {
    const allowed = choice.tools.filter(tool => !isHostedSearch(tool));
    if (allowed.length !== choice.tools.length) {
      if (allowed.length) change().tool_choice = { ...choice, tools: allowed };
      else if (choice.mode === 'auto') change().tool_choice = 'none';
      else throw new Error('MiMo Responses cannot satisfy allowed hosted web search');
    }
  }
  if (Array.isArray(body.input)) {
    let changed = false;
    const input = body.input.map(item => {
      if (!isPlainObject(item) || item.type !== 'web_search_call') return item;
      // Preserve completed evidence as history, without pretending an unfinished search ran.
      if (item.status !== 'completed' || !isPlainObject(item.action) || typeof item.action.type !== 'string') {
        throw new Error('MiMo Responses cannot replay an incomplete web_search_call');
      }
      changed = true;
      return { type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: '[completed web search]\n' + JSON.stringify(item.action) },
      ] };
    });
    if (changed) change().input = input;
  }
  return next;
}
