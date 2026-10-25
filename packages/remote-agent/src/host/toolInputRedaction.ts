import { parseBrowserProxyServer } from '@cindy/browser-control-runtime';

const REDACTED_PROXY_SERVER = '[REDACTED]';

function redactProxyServerInput(value: unknown): unknown {
  if (typeof value !== 'string') return REDACTED_PROXY_SERVER;
  try {
    // The parser rejects any userinfo (authenticated proxies are unsupported),
    // so a value that parses is a clean, credential-free proxy URL — safe to
    // keep verbatim for legibility. Anything with credentials or otherwise
    // malformed throws and is redacted whole.
    parseBrowserProxyServer(value);
    return value;
  } catch {
    return REDACTED_PROXY_SERVER;
  }
}

function redactBrowserCallArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return args.includes('proxyServer') ? REDACTED_PROXY_SERVER : args;
    }
    const redacted = redactBrowserCallArgs(parsed);
    return redacted === parsed ? args : JSON.stringify(redacted);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'proxyServer')) return args;
  const proxyServer = redactProxyServerInput(record.proxyServer);
  return proxyServer === record.proxyServer ? args : { ...record, proxyServer };
}

/**
 * Tool names that can carry a browser `proxyServer`: the browser MCP tool
 * itself and the Pi gateway that wraps it. Anything else — `apply_patch`, a
 * shell command, a free-form dynamic tool — is passed through untouched.
 *
 * Without this gate the non-JSON string fallback below redacts an ENTIRE input
 * that merely contains the text `proxyServer`, so editing a file that mentions
 * the identifier would blank that tool call in the live UI, the persisted
 * record, and the rehydrated history.
 *
 * Matched EXACTLY, never as a substring. A custom MCP id may contain `__`
 * (the id regex allows underscores), so a third-party server registered as
 * `cindy_browser__evil` produces `mcp__cindy_browser__evil__call_tool` — which
 * a substring test reads as the first-party browser. `mcp-tool-target.ts`
 * documents that exact name as the reason attribution must not be naive.
 * There the consequence is inheriting first-party trust; here it is having an
 * unrelated tool's input blanked in the UI and history. Same root cause.
 */
const PROXY_SERVER_CARRYING_TOOLS = new Set([
  'browser',
  'cindy_browser',
  'cindy_mcp_call_tool',
  // Claude Code's MCP tool id form...
  'mcp__cindy_browser__call_tool',
  // ...and Codex's, which its translator builds as `mcp:${server}:${tool}`
  // (agents/codex/translator.ts). Missing this form meant a local Codex
  // session's browser call skipped redaction entirely, so a credential-bearing
  // proxyServer was persisted and broadcast before the browser tool rejected it.
  'mcp:cindy_browser:call_tool',
  // Codex's APPROVAL identity is a third form: the elicitation path names the
  // server alone, with no tool suffix (agents/codex/index.ts), and nests the
  // real call under `toolParams`. Without it an Ask-mode permission request
  // carries the credential into the Desktop / device-link / IM card.
  'mcp:cindy_browser',
]);

function mayCarryProxyServer(toolName: string): boolean {
  return PROXY_SERVER_CARRYING_TOOLS.has(toolName);
}

/** Remove proxy userinfo before tool inputs cross a persistence or UI boundary. */
export function redactToolInputForUntrustedBoundary(toolName: string, input: unknown): unknown {
  // An empty name marks an internal recursive call on an already-identified
  // browser input; only top-level calls carry a real tool name to check.
  if (toolName !== '' && !mayCarryProxyServer(toolName)) return input;
  if (typeof input === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return input.includes('proxyServer') ? REDACTED_PROXY_SERVER : input;
    }
    const redacted = redactToolInputForUntrustedBoundary('', parsed);
    return redacted === parsed ? input : JSON.stringify(redacted);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  let redacted: Record<string, unknown> = record;
  if (Object.prototype.hasOwnProperty.call(record, 'proxyServer')) {
    const proxyServer = redactProxyServerInput(record.proxyServer);
    if (proxyServer !== record.proxyServer) redacted = { ...redacted, proxyServer };
  }
  // Codex MCP approval envelope: `{ serverName, message, toolName, toolParams,
  // toolParamsDisplay }`. The browser arguments live one level down under
  // `toolParams`, with a rendered copy under `toolParamsDisplay`; neither is
  // reached by the checks above. Safe to recurse with an empty name here — the
  // top-level tool name already identified this as a browser envelope.
  for (const field of ['toolParams', 'toolParamsDisplay'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const redactedField = redactToolInputForUntrustedBoundary('', record[field]);
    if (redactedField !== record[field]) redacted = { ...redacted, [field]: redactedField };
  }
  if (record.name === 'browser') {
    const redactedArgs = redactBrowserCallArgs(record.args);
    if (redactedArgs !== record.args) redacted = { ...redacted, args: redactedArgs };
  } else if (record.server === 'cindy_browser' && record.tool === 'call_tool') {
    // Pi MCP gateway envelope: call_tool({server, tool, args}) wraps the real
    // tool input one level deeper than a direct call_tool({name, args}).
    // Match the exact server/tool, not merely their types: recursing with an
    // empty name re-enters past the mayCarryProxyServer gate, so a shape-only
    // check would let any unrelated MCP call have an `args.proxyServer` field
    // rewritten — blanking that tool call in the live UI and persisted record.
    const redactedArgs = redactToolInputForUntrustedBoundary('', record.args);
    if (redactedArgs !== record.args) redacted = { ...redacted, args: redactedArgs };
  }
  return redacted;
}

