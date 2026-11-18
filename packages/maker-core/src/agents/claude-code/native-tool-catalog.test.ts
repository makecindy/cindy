import { describe, expect, it, vi } from 'vitest';
import { callClaudeToolCatalog } from './native-tool-catalog.js';

// Unit: the public SDK catalog must remain native, on-demand, and must not
// return connection config (which may contain tokens). Existing MCP report
// tests cover one-server discovery, not native mutations or API availability.
describe('Claude native tool catalog', () => {
  it('does not query the SDK until called', async () => {
    const mcpServerStatus = vi.fn(async () => [{ name: 'external', status: 'connected',
      config: { headers: { Authorization: 'private' } }, tools: [{ name: 'search' }] }]);
    expect(mcpServerStatus).not.toHaveBeenCalled();
    expect(await callClaudeToolCatalog({ mcpServerStatus }, 'mcpServerStatus', []))
      .toEqual([{ name: 'external', status: 'connected', tools: [{ name: 'search' }] }]);
    expect(mcpServerStatus).toHaveBeenCalledTimes(1);
  });
  it('passes the complete native replacement map without a second registry', async () => {
    const result = { added: ['external'], removed: [], errors: {} };
    const setMcpServers = vi.fn(async () => result);
    const servers = { external: { type: 'http', url: 'http://127.0.0.1:9999/mcp' } };
    expect(await callClaudeToolCatalog({ setMcpServers }, 'setMcpServers', [servers])).toBe(result);
    expect(setMcpServers).toHaveBeenCalledWith(servers);
  });
  it.each(['setActiveTools', 'setMcpServers'])('reports absent native %s as unsupported', async method => {
    await expect(callClaudeToolCatalog({}, method, [])).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  });
});
