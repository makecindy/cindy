import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { AppConnection } from '../connection.js';
import { McpAppsHost } from '../host.js';
import { createAppServerProxy } from '../serverProxy.js';
import { setMcpAppsHost, registerAppServer, clearAppServerConfigs } from '../runtime.js';

const cleanup: Array<() => Promise<void>> = [];
const tool = {
  name: 'form',
  inputSchema: { type: 'object' as const },
  _meta: { ui: { resourceUri: 'ui://form' } },
};

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearAppServerConfigs();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  let owner = {};
  const cards = new Map<string, McpAppRecord>();
  const writeCard = vi.fn(async (_session: string, id: string, record: McpAppRecord) => {
    cards.set(id, record);
  });
  const tools = vi.spyOn(AppConnection.prototype, 'tools').mockResolvedValue([tool]);
  const result = { content: [{ type: 'text' as const, text: 'complete' }] };
  const callTool = vi.fn(async () => result);
  vi.spyOn(AppConnection.prototype, 'getClient').mockResolvedValue({
    getServerCapabilities: () => ({ tools: {} }),
    getInstructions: () => undefined,
    callTool,
  } as unknown as Client);
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async (_session, id) => {
      const card = cards.get(id);
      if (!card) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return card;
    },
    writeCard,
    authorizeTool: async () => {},
    sendMessage: async () => {},
  });
  setMcpAppsHost(host);
  registerAppServer(config.id, () => config);
  const facade = createAppServerProxy(() => config, {
    agentKind: 'codex',
    sessionId: 'task',
    workingDir: '',
  });
  const client = new Client({ name: 'Pre-call fixture', version: '1' });
  cleanup.push(async () => {
    await client.close();
    await facade.close();
    await host.reset();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await facade.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    tools,
    cards,
    writeCard,
    callTool,
    result,
    revoke(kind: 'owner' | 'server' | 'config') {
      if (kind === 'owner') owner = {};
      if (kind === 'server') clearAppServerConfigs();
      if (kind === 'config')
        registerAppServer(config.id, () => ({ ...config, url: 'https://changed.example.invalid' }));
    },
  };
}

describe('MCP App pre-call validation and card finalization', () => {
  it.each(['owner', 'server', 'config'] as const)(
    'discards the model tool list after %s revocation during discovery',
    async (kind) => {
      const f = await fixture();
      const discovery = deferred();
      f.tools.mockImplementationOnce(async () => {
        await discovery.promise;
        return [tool];
      });
      const rejected = expect(f.client.listTools()).rejects.toThrow('MCP_APP_');
      await vi.waitFor(() => expect(f.tools).toHaveBeenCalledOnce());
      f.revoke(kind);
      discovery.resolve();
      await rejected;
      expect(f.tools).toHaveBeenCalledOnce();
      expect(f.writeCard).not.toHaveBeenCalled();
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );

  it('returns the model tool list once after slow discovery while still authorized', async () => {
    const f = await fixture();
    const discovery = deferred();
    f.tools.mockImplementationOnce(async () => {
      await discovery.promise;
      return [tool];
    });
    const pending = f.client.listTools();
    await vi.waitFor(() => expect(f.tools).toHaveBeenCalledOnce());
    discovery.resolve();
    await expect(pending).resolves.toEqual({ tools: [tool] });
    expect(f.tools).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'server', 'config'] as const)(
    'does not create a pending card after %s revocation during tool discovery',
    async (kind) => {
      const f = await fixture();
      const discovery = deferred();
      f.tools.mockImplementationOnce(async () => {
        await discovery.promise;
        return [tool];
      });
      const rejected = expect(f.client.callTool({ name: tool.name })).rejects.toThrow('MCP_APP_');
      await vi.waitFor(() => expect(f.tools).toHaveBeenCalledOnce());
      f.revoke(kind);
      discovery.resolve();
      await rejected;
      expect(f.writeCard).not.toHaveBeenCalled();
      expect(f.cards.size).toBe(0);
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );

  it.each(['server', 'config'] as const)(
    'finalizes the pending card after %s revocation while it is being stored',
    async (kind) => {
      const f = await fixture();
      const persistence = deferred();
      f.writeCard.mockImplementationOnce(async (_session, id, record) => {
        f.cards.set(id, record);
        await persistence.promise;
      });
      const rejected = expect(f.client.callTool({ name: tool.name })).rejects.toThrow(
        'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(f.writeCard).toHaveBeenCalledOnce());
      f.revoke(kind);
      persistence.resolve();
      await rejected;
      expect(f.callTool).not.toHaveBeenCalled();
      expect(f.writeCard).toHaveBeenCalledTimes(2);
      expect([...f.cards.values()]).toEqual([
        expect.objectContaining({
          result: {
            isError: true,
            content: [{ type: 'text', text: 'MCP App tool execution failed' }],
          },
        }),
      ]);
    },
  );

  it('records cancellation during the initial card write without calling or replaying the tool', async () => {
    const f = await fixture();
    const persistence = deferred();
    f.writeCard.mockImplementationOnce(async (_session, id, record) => {
      f.cards.set(id, record);
      await persistence.promise;
    });
    const abort = new AbortController();
    const rejected = expect(
      f.client.callTool({ name: tool.name }, CallToolResultSchema, { signal: abort.signal }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(f.writeCard).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    persistence.resolve();
    await vi.waitFor(() => expect(f.writeCard).toHaveBeenCalledTimes(2));
    expect([...f.cards.values()]).toEqual([
      expect.objectContaining({ cancelled: 'Tool execution cancelled' }),
    ]);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it('executes once and records the result after a slow authorized card write', async () => {
    const f = await fixture();
    const persistence = deferred();
    f.writeCard.mockImplementationOnce(async (_session, id, record) => {
      f.cards.set(id, record);
      await persistence.promise;
    });
    const pending = f.client.callTool({ name: tool.name });
    await vi.waitFor(() => expect(f.writeCard).toHaveBeenCalledOnce());
    expect(f.callTool).not.toHaveBeenCalled();
    persistence.resolve();
    await expect(pending).resolves.toEqual(f.result);
    expect(f.callTool).toHaveBeenCalledOnce();
    expect(f.writeCard).toHaveBeenCalledTimes(2);
    expect([...f.cards.values()]).toEqual([expect.objectContaining({ result: f.result })]);
  });
});
