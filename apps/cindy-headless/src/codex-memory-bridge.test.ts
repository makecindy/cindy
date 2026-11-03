import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger, McpProvider } from '@cindy/maker-core';
import { startCodexMemoryBridge } from './codex-memory-bridge.js';

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

describe('Codex Maker Memory bridge', () => {
  it('requires the per-run token and accepts a stateful MCP initialize', async () => {
    const provider: McpProvider = {
      name: 'cindy_memory',
      toClaudeSdkConfig: () => ({ type: 'sdk', name: 'cindy_memory', instance: new McpServer({ name: 'cindy_memory', version: '0.1.0' }) }),
    };
    const bridge = await startCodexMemoryBridge({ provider, workingDir: process.cwd(), logger });
    try {
      const url = `http://127.0.0.1:${bridge.port}/mcp/cindy_memory`;
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      };
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) });
      expect(unauthorized.status).toBe(401);
      const token = bridge.extraEnv.CINDY_HEADLESS_MCP_TOKEN;
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(init),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    } finally {
      await bridge.shutdown();
    }
  });
});
