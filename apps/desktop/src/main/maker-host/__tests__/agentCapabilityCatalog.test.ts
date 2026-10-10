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
      .toMatchObject({ ok: false, discovery: 'harness-mcp', errorCode: 'HARNESS_DISCOVERY_UNAVAILABLE' });
    expect(factory).not.toHaveBeenCalled();
  });

  describe('servers the engine connects itself', () => {
    const custom = [{ name: 'custom_omc', toClaudeSdkConfig: vi.fn() }];

    it('lists the tools the caller engine actually holds for the server', async () => {
      const read = vi.fn(async () => ({ state: 'connected' as const, tools: [
        { name: 'search', description: 'x'.repeat(400) }, { name: 'open' },
      ] }));
      const result = await readAgentCapabilityCatalog(custom, context, { server: 'custom_omc' }, undefined, read);
      expect(read).toHaveBeenCalledWith('custom_omc');
      expect(result).toMatchObject({ ok: true, discovery: 'harness-mcp', engineState: 'connected',
        tools: [{ name: 'search' }, { name: 'open' }] });
      expect((result as { tools: Array<{ description?: string }> }).tools[0]!.description).toHaveLength(301);
      expect(custom[0]!.toClaudeSdkConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['not-mounted', '新建任务'],
      ['no-tools', '连接失败'],
      ['failed', '连接此服务失败'],
      ['needs-auth', '授权'],
      ['pending', '仍在连接'],
      ['disabled', '已被停用'],
    ] as const)('names the %s engine state instead of reporting success', async (state, text) => {
      const result = await readAgentCapabilityCatalog(custom, context, { server: 'custom_omc' }, undefined,
        async () => ({ state, tools: [] }));
      expect(result).toMatchObject({ ok: false, errorCode: 'HARNESS_MCP_NOT_READY', engineState: state });
      expect((result as { message: string }).message).toContain(text);
    });

    it('distinguishes an engine without a status entry from a failed read and hides failure text', async () => {
      expect(await readAgentCapabilityCatalog(custom, context, { server: 'custom_omc' }, undefined, async () => null))
        .toMatchObject({ ok: false, errorCode: 'HARNESS_DISCOVERY_UNAVAILABLE' });
      const failed = await readAgentCapabilityCatalog(custom, context, { server: 'custom_omc' }, undefined,
        async () => { throw new Error('HTTP 404 https://omc.example/mcp?token=secret'); });
      expect(failed).toMatchObject({ ok: false, errorCode: 'HARNESS_DISCOVERY_FAILED' });
      expect(JSON.stringify(failed)).not.toContain('secret');
    });

    it('times out a stuck engine read', async () => {
      vi.useFakeTimers();
      try {
        const pending = readAgentCapabilityCatalog(custom, context, { server: 'custom_omc' }, undefined,
          () => new Promise(() => undefined));
        await vi.advanceTimersByTimeAsync(8_000);
        expect(await pending).toMatchObject({ ok: false, errorCode: 'HARNESS_DISCOVERY_FAILED' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not ask the engine about a server the runtime did not mount', async () => {
      const read = vi.fn();
      expect(await readAgentCapabilityCatalog(custom, {
        ...context, vendorOptions: { [RUNTIME_MCP_NAMES_KEY]: [] },
      }, { server: 'custom_omc' }, undefined, read)).toMatchObject({
        ok: false, capability: { reason: 'not-mounted-in-current-runtime' },
      });
      expect(read).not.toHaveBeenCalled();
    });
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
