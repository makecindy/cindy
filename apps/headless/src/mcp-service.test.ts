import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger, McpProvider } from '@cindy/maker-core';
import { HeadlessMcpService } from './mcp-service.js';

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; },
};

describe('HeadlessMcpService', () => {
  let service: HeadlessMcpService | undefined;

  afterEach(async () => { await service?.stop(); });

  it('uses authenticated loopback Streamable HTTP and emits Codex-safe args', async () => {
    const providers: McpProvider[] = [{
      name: 'cindy_test',
      toClaudeSdkConfig: () => ({ type: 'sdk', name: 'cindy_test', instance: new McpServer({ name: 'test', version: '1.0.0' }) }),
    }];
    service = new HeadlessMcpService(providers, logger);
    await service.start();
    const config = service.prepareCodexExtraSpawnConfig();
    const urlArg = config.extraArgs.find((value) => value.startsWith('mcp_servers.cindy_test.url='));
    expect(urlArg).toBeTruthy();
    const url = JSON.parse(urlArg!.slice('mcp_servers.cindy_test.url='.length)) as string;

    expect((await fetch(url, { method: 'POST' })).status).toBe(401);

    const init = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.extraEnv.CINDY_HEADLESS_MCP_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    expect(await init.text()).toContain('"name":"test"');
  });
});
