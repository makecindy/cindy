import type { RecoveryRule } from '@cindy/anthropic-compat-proxy';

const RESPONSES_WEB_SEARCH_TYPES = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A Responses gateway can route a Claude model to Bedrock, which rejects the
 * translated hosted-search declaration before generation. Repair only that
 * explicit rejection; accepted routes keep native search and no provider/model
 * capability is inferred or cached across requests.
 */
export function createCodexBedrockSearchCompatibilityRule(): RecoveryRule {
  return {
    id: 'bedrock_unsupported_web_search',
    enabled: () => true,
    matches: (errorText) => {
      // Codex may embed an escaped JSON error inside its error envelope.
      const text = errorText.replace(/\\+(?=["'])/g, '');
      return /\bBedrockException\b[\s\S]{0,256}\btool type ['"]web_search_20250305['"] is not supported for this model\b/.test(text);
    },
    strip: (body) => {
      let request: unknown;
      try { request = JSON.parse(body.toString('utf8')); } catch { return null; }
      if (!isRecord(request) || !Array.isArray(request.tools)) return null;
      // This rule belongs to the Codex Responses path, never a dedicated
      // Messages search request whose sole purpose would be lost by stripping.
      if ('messages' in request || !(typeof request.input === 'string' || Array.isArray(request.input))) return null;
      if (request.tool_choice !== undefined && request.tool_choice !== 'auto' && request.tool_choice !== 'none') return null;

      const tools = request.tools.filter((tool) =>
        !isRecord(tool) || typeof tool.type !== 'string' || !RESPONSES_WEB_SEARCH_TYPES.has(tool.type),
      );
      // Do not turn a search-only request into an apparent successful answer.
      if (tools.length === 0 || tools.length === request.tools.length) return null;
      return Buffer.from(JSON.stringify({ ...request, tools }));
    },
    // Removing an optional tool is safe only after its own explicit rejection;
    // do not combine it with unrelated encrypted-history or dialect repairs.
    applyOnUnmatchedRetry: false,
    allowExtraRules: false,
  };
}
