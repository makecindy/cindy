import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLiziMcpProviders } from '@cindy/mcps';
import { readAgentCapabilityCatalog, RUNTIME_MCP_NAMES_KEY } from '../agentCapabilityCatalog';

const context = { agentKind: 'pi' as const, workingDir: '/repo', sessionId: 'task' };

describe('shared runtime capability discovery', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('does not advertise the retired simulator in the %s provider catalog', async (agentKind) => {
    const providers = createLiziMcpProviders({
      android: {} as never, browser: {} as never, computer: {} as never,
      feishuBot: {} as never, wechatBot: {} as never, slackHook: {} as never,
      scheduler: {} as never, ssh: {} as never, memory: {} as never,
      contacts: {} as never, docs: {} as never, xdtHelper: {} as never,
      orca: {} as never, lsp: {} as never,
    });
    const runtime = { ...context, agentKind };
    const result = await readAgentCapabilityCatalog(providers, runtime, {});
    expect(JSON.stringify(result)).not.toMatch(/ios.?simulator/i);
    expect(result).toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ server: 'cindy_android' }),
      expect.objectContaining({ server: 'cindy_browser' }),
      expect.objectContaining({ server: 'cindy_contacts' }),
    ]) });
    expect(await readAgentCapabilityCatalog(providers, runtime, { server: 'cindy_ios_simulator' }))
      .toMatchObject({ ok: false, errorCode: 'UNKNOWN_CAPABILITY' });
  });

  it('uses registrations, includes future providers and does not construct servers for the index', async () => {
    const factory = vi.fn();
    const result = await readAgentCapabilityCatalog([
      { name: 'future', toClaudeSdkConfig: factory },
      { name: 'disabled', isEnabled: () => false, toClaudeSdkConfig: factory },
    ], context, {});
    expect(result).toMatchObject({ capabilities: [
      { server: 'future', status: 'registered' },
      { server: 'disabled', status: 'unavailable', reason: 'provider-not-enabled-for-session' },
    ] });
    expect(factory).not.toHaveBeenCalled();
  });

  it('reads real schemas and builtin progressive metadata without executing business tools', async () => {
    const execute = vi.fn();
    const factory = () => {
      const server = new McpServer({ name: 'fixture', version: '1' });
      server.registerTool('write_file', { inputSchema: { path: z.string() } }, execute);
      server.registerTool('list_tools', { inputSchema: { category: z.string().optional() } }, async ({ category }) => ({
        content: [{ type: 'text', text: JSON.stringify({ category, tools: ['write_file'] }) }],
      }));
      return { instance: server };
    };
    const result = await readAgentCapabilityCatalog([{ name: 'fixture',
      capability: { title: 'Fixture', description: 'Test', source: 'builtin' },
      toClaudeSdkConfig: factory,
    }], context, { server: 'fixture', category: 'files' });
    expect(result).toMatchObject({ ok: true, tools: expect.arrayContaining([
      expect.objectContaining({ name: 'write_file', inputSchema: expect.objectContaining({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) }),
    ]), discovery: { content: [{ type: 'text', text: JSON.stringify({ category: 'files', tools: ['write_file'] }) }] } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports an explicitly unmounted capability and never starts custom transports', async () => {
    const factory = vi.fn(() => { throw new Error('secret'); });
    const providers = [{ name: 'custom', toClaudeSdkConfig: factory }];
    expect(await readAgentCapabilityCatalog(providers, {
      ...context, vendorOptions: { [RUNTIME_MCP_NAMES_KEY]: [] },
    }, { server: 'custom' })).toMatchObject({ ok: false, capability: { reason: 'not-mounted-in-current-runtime' } });
    expect(await readAgentCapabilityCatalog(providers, context, { server: 'custom' }))
      .toMatchObject({ ok: true, discovery: 'harness-mcp' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('returns an explicit discovery failure without leaking factory errors', async () => {
    const result = await readAgentCapabilityCatalog([{ name: 'broken',
      capability: { title: 'Broken', description: '', source: 'builtin' },
      toClaudeSdkConfig: () => { throw new Error('secret'); },
    }], context, { server: 'broken' });
    expect(result).toMatchObject({ ok: false, errorCode: 'CAPABILITY_DISCOVERY_FAILED' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
