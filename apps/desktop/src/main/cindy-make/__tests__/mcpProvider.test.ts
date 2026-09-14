import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProviderContext } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CINDY_MAKE_MCP_SERVER_NAME,
  CINDY_MAKE_REPORT_COMPLETE_TOOL,
  CINDY_MAKE_VENDOR_OPTION_KEY,
} from '../../../shared/cindyMakeSession';
import { createCindyMakeMcpProvider, isCindyMakeServerVisible } from '../mcpProvider';

const logger = { info: vi.fn(), warn: vi.fn() };

function marked(sessionId = 'make-1'): McpProviderContext {
  return {
    agentKind: 'claude-code',
    workingDir: 'C:\\cindy-make\\source',
    sessionId,
    vendorOptions: { [CINDY_MAKE_VENDOR_OPTION_KEY]: true },
  };
}

async function callReportComplete(
  ctx: McpProviderContext,
  reportCompletion: (sessionId: string) => Promise<void> = vi.fn(async () => undefined),
) {
  const provider = createCindyMakeMcpProvider({ reportCompletion, logger });
  const config = provider.toClaudeSdkConfig?.(ctx) as { instance: McpServer } | null;
  if (!config) throw new Error('server not registered');
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cindy-make-test', version: '0.0.0' });
  await Promise.all([config.instance.connect(serverTx), client.connect(clientTx)]);
  try {
    const tools = await client.listTools();
    const result = await client.callTool({ name: CINDY_MAKE_REPORT_COMPLETE_TOOL, arguments: {} });
    return { result, tools, reportCompletion };
  } finally {
    await client.close();
    await config.instance.close();
  }
}

describe('cindy_make provider visibility', () => {
  it('registers for Claude only when the session carries the marker', () => {
    expect(isCindyMakeServerVisible(marked())).toBe(true);
    expect(
      isCindyMakeServerVisible({
        agentKind: 'claude-code',
        workingDir: 'C:\\repo',
        sessionId: 's',
      }),
    ).toBe(false);
    expect(
      isCindyMakeServerVisible({
        agentKind: 'claude-code',
        workingDir: 'C:\\cindy-make\\source',
        vendorOptions: { [CINDY_MAKE_VENDOR_OPTION_KEY]: 'yes' },
      }),
    ).toBe(false);
  });

  it('stays registered on the anonymous Codex and Pi bridge contexts only', () => {
    expect(
      isCindyMakeServerVisible({ agentKind: 'codex', workingDir: '', vendorOptions: {} }),
    ).toBe(true);
    expect(isCindyMakeServerVisible({ agentKind: 'pi', workingDir: '', vendorOptions: {} })).toBe(
      true,
    );
    expect(isCindyMakeServerVisible({ agentKind: 'codex', workingDir: 'C:\\repo' })).toBe(false);
    const provider = createCindyMakeMcpProvider({ reportCompletion: vi.fn(), logger });
    expect(provider.name).toBe(CINDY_MAKE_MCP_SERVER_NAME);
    expect(
      provider.toClaudeSdkConfig?.({ agentKind: 'claude-code', workingDir: 'C:\\repo' }),
    ).toBeNull();
  });
});

describe('cindy_make report_complete', () => {
  it('exposes a single parameterless tool and registers the completion for a marked session', async () => {
    const { result, tools, reportCompletion } = await callReportComplete(marked());
    expect(tools.tools.map((tool) => tool.name)).toEqual([CINDY_MAKE_REPORT_COMPLETE_TOOL]);
    expect(tools.tools[0]?.inputSchema.properties ?? {}).toEqual({});
    expect(reportCompletion).toHaveBeenCalledWith('make-1');
    expect(result.isError).toBeFalsy();
    const [first] = result.content as Array<{ text: string }>;
    expect(JSON.parse(first.text)).toMatchObject({ ok: true });
  });

  it('fails closed when the runtime context is not a Cindy Make task', async () => {
    const reportCompletion = vi.fn(async () => undefined);
    const bridgeCtx: McpProviderContext = {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        sessionId: 'plain-1',
        vendorOptions: {},
      }),
    };
    const { result } = await callReportComplete(bridgeCtx, reportCompletion);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('NOT_CINDY_MAKE_TASK');
    expect(reportCompletion).not.toHaveBeenCalled();
  });

  it('resolves the bridge runtime session rather than the factory context', async () => {
    const reportCompletion = vi.fn(async () => undefined);
    const bridgeCtx: McpProviderContext = {
      agentKind: 'pi',
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => marked('make-pi'),
    };
    const { result } = await callReportComplete(bridgeCtx, reportCompletion);
    expect(result.isError).toBeFalsy();
    expect(reportCompletion).toHaveBeenCalledWith('make-pi');
  });

  it('reports a registration failure instead of claiming success', async () => {
    const reportCompletion = vi.fn(async () => {
      throw new Error('db closed');
    });
    const { result } = await callReportComplete(marked(), reportCompletion);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('REPORT_FAILED');
  });
});
