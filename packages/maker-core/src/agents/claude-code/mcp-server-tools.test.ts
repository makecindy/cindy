import { describe, expect, it } from 'vitest';
import { claudeMcpServerToolsReport } from './mcp-server-tools.js';

describe('Claude MCP server tools report', () => {
  it('returns the connected server tools as declared', () => {
    expect(claudeMcpServerToolsReport([
      { name: 'other', status: 'connected', tools: [{ name: 'x' }] },
      { name: 'custom_omc', status: 'connected', tools: [{ name: 'search', description: 'Search' }, { name: 'open' }] },
    ], 'custom_omc')).toEqual({
      state: 'connected',
      tools: [{ name: 'search', description: 'Search' }, { name: 'open' }],
    });
  });

  it.each(['failed', 'needs-auth', 'pending', 'disabled'] as const)('reports %s without tools', (status) => {
    expect(claudeMcpServerToolsReport([{ name: 'custom_omc', status, tools: [{ name: 'stale' }] }], 'custom_omc'))
      .toEqual({ state: status, tools: [] });
  });

  it('reports an unknown server as not mounted and an unknown state by its tools', () => {
    expect(claudeMcpServerToolsReport([], 'custom_omc')).toEqual({ state: 'not-mounted', tools: [] });
    expect(claudeMcpServerToolsReport([{ name: 'custom_omc', status: 'reconnecting' }], 'custom_omc'))
      .toEqual({ state: 'no-tools', tools: [] });
  });
});
