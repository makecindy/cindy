import { createHash } from 'node:crypto';

/** Codex 0.167 native MCP hooks. Trust only these session-flag handlers. */
export function codexToolHookConfig(server: string, tool: string, timeoutSeconds: number): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  for (const [event, key] of [['PreToolUse', 'pre_tool_use'], ['PostToolUse', 'post_tool_use']] as const) {
    const input: Record<string, unknown> = {
      hook_event_name: '${hook_event_name}',
      tool_name: '${tool_name}',
      tool_input: '${tool_input}',
      tool_use_id: '${tool_use_id}',
      ...(event === 'PostToolUse' ? { tool_response: '${tool_response}' } : {}),
    };
    const handler = { type: 'mcp_tool', server, tool, input: { name: 'native_tool_hook', args: input }, timeout: timeoutSeconds };
    const group = { hooks: [handler] };
    config[`hooks.${event}`] = [group];
    // Native discovery hashes the normalized identity as recursively sorted JSON
    // (codex-rs/config/src/fingerprint.rs). No bypass_hook_trust or user config write.
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, item]) => [name, sort(item)])) : value;
    const hash = createHash('sha256').update(JSON.stringify(sort({ event_name: key, ...group }))).digest('hex');
    // Native synthetic_layer_path resolves against C:\ on Windows, not cwd.
    const source = process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
    state[`${source}:${key}:0:0`] = { trusted_hash: `sha256:${hash}` };
  }
  config['hooks.state'] = state;
  return config;
}
