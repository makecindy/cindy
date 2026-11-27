import type { RecoveryRule } from '@cindy/anthropic-compat-proxy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Use the legacy hosted-search name only after the upstream advertises it in a schema rejection. */
export function createCodexWebSearchDialectRecoveryRule(): RecoveryRule {
  return {
    id: 'responses_web_search_preview_dialect',
    enabled: () => true,
    matches: (errorText) => {
      const rejection = /\btools\[\d+\]\.type:\s*unknown variant `web_search`,\s*expected one of ([^"\r\n]{1,256})/.exec(errorText);
      return rejection?.[1]?.includes('`web_search_preview`') === true;
    },
    strip: (body) => {
      let request: unknown;
      try { request = JSON.parse(body.toString('utf8')); } catch { return null; }
      if (!isRecord(request) || !Array.isArray(request.tools)) return null;
      if ('messages' in request || !(typeof request.input === 'string' || Array.isArray(request.input))) return null;
      if (!request.tools.some(tool => isRecord(tool) && tool.type === 'web_search')) return null;

      const asPreview = (tool: unknown): unknown => isRecord(tool) && tool.type === 'web_search'
        ? { ...tool, type: 'web_search_preview' }
        : tool;
      return Buffer.from(JSON.stringify({
        ...request,
        tools: request.tools.map(asPreview),
        ...(isRecord(request.tool_choice) ? { tool_choice: asPreview(request.tool_choice) } : {}),
      }));
    },
    applyOnUnmatchedRetry: false,
    allowExtraRules: false,
  };
}
