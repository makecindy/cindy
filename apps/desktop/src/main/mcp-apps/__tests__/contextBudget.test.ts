import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AppConnection } from '../connection.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { McpAppsHost, appServerRevision } from '../host.js';

type ContextParams = { structuredContent: { draft: string } };
const hosts: McpAppsHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
});

function sizedContext(bytes: number, unit = '汉'): ContextParams {
  const empty = { structuredContent: { draft: '' } };
  const available = bytes - Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const unitBytes =
    Buffer.byteLength(JSON.stringify({ structuredContent: { draft: unit } }), 'utf8') -
    Buffer.byteLength(JSON.stringify(empty), 'utf8');
  return {
    structuredContent: {
      draft: unit.repeat(Math.floor(available / unitBytes)) + 'x'.repeat(available % unitBytes),
    },
  };
}

function contextValue(params: ContextParams) {
  return { app: 'example', resourceUri: 'ui://form', ...params };
}

function contextJson(text: string) {
  return text.split('\n')[2];
}

function fixture() {
  let owner = {};
  let visible = true;
  let enabled = true;
  const cards = new Map<string, McpAppRecord>();
  const archived = new Set<string>();
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const tool = {
    name: 'form',
    inputSchema: { type: 'object' as const },
    _meta: { ui: { resourceUri: 'ui://form' } },
  };
  const record = {
    version: 1 as const,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: 'ui://form',
    tool,
    arguments: {},
  };
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({}) }),
    tools: async () => [tool],
    resource: async () => ({
      result: {
        contents: [{ uri: 'ui://form', mimeType: 'text/html;profile=mcp-app', text: '' }],
      },
    }),
    listen: () => () => {},
    close: async () => {},
  } as unknown as AppConnection;
  const outgoing: JSONRPCMessage[] = [];
  const connect = AppBridge.prototype.connect;
  vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(function (
    this: AppBridge,
    transport,
  ) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      outgoing.push(message);
      await send(message, options);
    };
    return connect.call(this, transport);
  });
  // Context budgeting does not exercise the separate teardown handshake.
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const readCard = vi.fn(async (sessionId: string, clientId: string) => {
    if (!visible) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    if (archived.has(sessionId)) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    const card = cards.get(`${sessionId}:${clientId}`);
    if (!card) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    return card;
  });
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => (enabled ? config : undefined),
    readCard,
    writeCard: async () => {},
    authorizeTool: async () => {},
    sendMessage: async () => {},
    connection: () => connection,
  });
  hosts.push(host);
  let requestId = 0;
  return {
    host,
    readCard,
    cards,
    archived,
    changeOwner() {
      owner = {};
    },
    revoke(kind: 'card' | 'owner' | 'server' | 'config') {
      if (kind === 'card') visible = false;
      if (kind === 'owner') owner = {};
      if (kind === 'server') enabled = false;
      if (kind === 'config') config.url = 'https://changed.example.invalid';
    },
    async open(clientId: string, sessionId = 'task') {
      cards.set(`${sessionId}:${clientId}`, {
        ...record,
        serverRevision: appServerRevision(config),
      });
      const document = await host.open('renderer:1', sessionId, clientId, {});
      const request = async (method: string, params: Record<string, unknown>) => {
        const id = ++requestId;
        await host.dispatch('renderer:1', sessionId, document.viewId, {
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
        await vi.waitFor(() => expect(outgoing).toContainEqual(expect.objectContaining({ id })), {
          interval: 1,
        });
        return outgoing.find((message) => 'id' in message && message.id === id)!;
      };
      await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'Context budget fixture', version: '1' },
        appCapabilities: {},
      });
      await host.dispatch('renderer:1', sessionId, document.viewId, {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      });
      return Object.assign((params: ContextParams) => request('ui/update-model-context', params), {
        close: () => host.teardown('renderer:1', sessionId, document.viewId),
      });
    },
  };
}

describe('MCP App UTF-8 model-context budgets', () => {
  it.each(['removed', 'replaced'] as const)(
    'reclaims aggregate bytes from a %s card without waiting for another model turn',
    async (kind) => {
      const f = fixture();
      const large = sizedContext(127_800);
      for (let index = 0; index < 4; index++) {
        const update = await f.open(`card-${index}`);
        expect(await update(large)).toHaveProperty('result');
        await update.close();
      }
      if (kind === 'removed') f.cards.delete('task:card-0');
      else
        f.cards.set('task:card-0', { ...f.cards.get('task:card-0')!, serverRevision: 'obsolete' });
      const update = await f.open('new-card');
      expect(await update(large)).toHaveProperty('result');
      expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual(
        Array.from({ length: 4 }, () => contextValue(large)),
      );
    },
  );

  it.each(['replacement', 'requesting-card', 'budget-refilled'] as const)(
    'revalidates %s after aggregate-byte cleanup awaits another card',
    async (race) => {
      const f = fixture();
      const large = sizedContext(127_800);
      for (let index = 0; index < 4; index++) {
        const update = await f.open(`card-${index}`);
        expect(await update(large)).toHaveProperty('result');
        await update.close();
      }
      const replace = await f.open('card-0');
      const update = await f.open('new-card');
      f.cards.delete('task:card-1');
      const read = f.readCard.getMockImplementation()!;
      let finish!: () => void;
      let paused = false;
      f.readCard.mockImplementation(async (...args) => {
        if (args[1] === 'card-0' && !paused) {
          paused = true;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (race === 'replacement') throw new Error('MCP_APP_CARD_UNAVAILABLE');
        }
        return read(...args);
      });
      const pending = update(large);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (race === 'replacement') {
        expect(await replace({ structuredContent: { draft: 'replacement' } })).toHaveProperty(
          'result',
        );
      } else if (race === 'requesting-card') {
        f.cards.delete('task:new-card');
      } else {
        const refill = await f.open('refill');
        expect(await refill(large)).toHaveProperty('result');
      }
      finish();
      if (race === 'replacement') {
        expect(await pending).toHaveProperty('result');
        expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))[0]).toEqual(
          contextValue({ structuredContent: { draft: 'replacement' } }),
        );
      } else {
        const error =
          race === 'requesting-card' ? 'MCP_APP_CARD_UNAVAILABLE' : 'MCP_APP_CONTEXT_TOO_LARGE';
        expect(await pending).toHaveProperty('error.message', expect.stringContaining(error));
        expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toHaveLength(
          race === 'budget-refilled' ? 4 : 3,
        );
      }
    },
  );

  it.each(['card', 'session', 'config', 'owner'] as const)(
    'reclaims the global context cap after %s revocation without another turn in the old tasks',
    async (kind) => {
      const f = fixture();
      for (let index = 0; index < 256; index++) {
        const update = await f.open('card', `task-${index}`);
        expect(await update({ structuredContent: { draft: `draft-${index}` } })).toHaveProperty(
          'result',
        );
        await update.close();
      }
      if (kind === 'card') f.cards.delete('task-0:card');
      if (kind === 'session') f.archived.add('task-0');
      if (kind === 'config') f.revoke('config');
      if (kind === 'owner') f.revoke('owner');
      const update = await f.open('new-card', 'new-task');
      expect(await update({ structuredContent: { draft: 'new draft' } })).toHaveProperty('result');
      expect(JSON.parse(contextJson((await f.host.modelContext('new-task')).text))).toEqual([
        contextValue({ structuredContent: { draft: 'new draft' } }),
      ]);
      if (kind === 'card' || kind === 'session') {
        expect(JSON.parse(contextJson((await f.host.modelContext('task-1')).text))).toEqual([
          contextValue({ structuredContent: { draft: 'draft-1' } }),
        ]);
      }
    },
    20_000,
  );

  it('preserves valid contexts at the global cap and still allows their replacement', async () => {
    const f = fixture();
    for (let index = 0; index < 256; index++) {
      const update = await f.open('card', `task-${index}`);
      expect(await update({ structuredContent: { draft: `draft-${index}` } })).toHaveProperty(
        'result',
      );
      await update.close();
    }
    const overflow = await f.open('new-card', 'new-task');
    expect(await overflow({ structuredContent: { draft: 'overflow' } })).toHaveProperty(
      'error.message',
      expect.stringContaining('MCP_APP_CONTEXT_LIMIT'),
    );
    const replace = await f.open('card', 'task-0');
    expect(await replace({ structuredContent: { draft: 'replacement' } })).toHaveProperty('result');
    expect(JSON.parse(contextJson((await f.host.modelContext('task-0')).text))).toEqual([
      contextValue({ structuredContent: { draft: 'replacement' } }),
    ]);
  }, 20_000);

  it.each(['replacement', 'requesting-card'] as const)(
    'revalidates %s after the context-cap cleanup reads other cards',
    async (race) => {
      const f = fixture();
      for (let index = 0; index < 256; index++) {
        const update = await f.open('card', `task-${index}`);
        expect(await update({ structuredContent: { draft: `draft-${index}` } })).toHaveProperty(
          'result',
        );
        await update.close();
      }
      const replace = await f.open('card', 'task-0');
      const update = await f.open('new-card', 'new-task');
      f.cards.delete('task-1:card');
      const read = f.readCard.getMockImplementation()!;
      let finish!: () => void;
      let paused = false;
      f.readCard.mockImplementation(async (...args) => {
        if (args[0] === 'task-0' && !paused) {
          paused = true;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        }
        return read(...args);
      });
      const pending = update({ structuredContent: { draft: 'new draft' } });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (race === 'replacement') {
        expect(await replace({ structuredContent: { draft: 'replacement' } })).toHaveProperty(
          'result',
        );
      } else {
        f.cards.delete('new-task:new-card');
      }
      finish();
      if (race === 'replacement') {
        expect(await pending).toHaveProperty('result');
        expect(JSON.parse(contextJson((await f.host.modelContext('task-0')).text))).toEqual([
          contextValue({ structuredContent: { draft: 'replacement' } }),
        ]);
      } else {
        expect(await pending).toHaveProperty(
          'error.message',
          expect.stringContaining('MCP_APP_CARD_UNAVAILABLE'),
        );
        expect((await f.host.modelContext('new-task')).text).toBe('');
      }
    },
    20_000,
  );

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'rejects a captured context after %s revocation',
    async (kind) => {
      const f = fixture();
      const update = await f.open('card');
      expect(await update({ structuredContent: { draft: 'private draft' } })).toHaveProperty(
        'result',
      );
      const snapshot = await f.host.modelContext('task');
      f.revoke(kind);
      await expect(snapshot.assertCurrent()).rejects.toThrow('MCP_APP_');
    },
  );

  it.each(['owner', 'server', 'config'] as const)(
    'rejects %s revocation while the final context validation is reading its cards',
    async (kind) => {
      const f = fixture();
      const update = await f.open('card');
      expect(await update({ structuredContent: { draft: 'private draft' } })).toHaveProperty(
        'result',
      );
      const snapshot = await f.host.modelContext('task');
      const read = f.readCard.getMockImplementation()!;
      let finish!: () => void;
      f.readCard.mockImplementationOnce(async (...args) => {
        const card = await read(...args);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return card;
      });
      const rejected = expect(snapshot.assertCurrent()).rejects.toThrow('MCP_APP_');
      await vi.waitFor(() => expect(finish).toBeDefined());
      f.revoke(kind);
      finish();
      await rejected;
    },
  );

  it('validates a captured value without consuming or replacing a newer App update', async () => {
    const f = fixture();
    const update = await f.open('card');
    expect(await update({ structuredContent: { draft: 'first' } })).toHaveProperty('result');
    const snapshot = await f.host.modelContext('task');
    expect(await update({ structuredContent: { draft: 'second' } })).toHaveProperty('result');
    await expect(snapshot.assertCurrent()).resolves.toBeUndefined();
    expect(JSON.parse(contextJson(snapshot.text))).toEqual([
      contextValue({ structuredContent: { draft: 'first' } }),
    ]);
    snapshot.consume();
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual([
      contextValue({ structuredContent: { draft: 'second' } }),
    ]);
  });

  it.each(['汉', '🧩', '"', '\u0001'])(
    'counts serialized UTF-8 bytes for %j at the per-update boundary',
    async (unit) => {
      const f = fixture();
      const update = await f.open('card');
      const params = sizedContext(128_000, unit);
      expect(Buffer.byteLength(JSON.stringify(params), 'utf8')).toBe(128_000);
      expect(await update(params)).toHaveProperty('result');
      const accepted = await f.host.modelContext('task');
      expect(JSON.parse(contextJson(accepted.text))).toEqual([contextValue(params)]);

      const oversized = { structuredContent: { draft: params.structuredContent.draft + 'x' } };
      expect(await update(oversized)).toHaveProperty(
        'error.message',
        expect.stringContaining('MCP_APP_CONTEXT_TOO_LARGE'),
      );
      expect((await f.host.modelContext('task')).text).toBe(accepted.text);
    },
  );

  it('includes the full context array and preserves valid values after an aggregate overflow', async () => {
    const f = fixture();
    const maximum = sizedContext(128_000, '🧩');
    const previous = [];
    for (let index = 0; index < 3; index++) {
      const update = await f.open(`card-${index}`);
      expect(await update(maximum)).toHaveProperty('result');
      previous.push(contextValue(maximum));
    }
    const update = await f.open('card-3');
    const empty = { structuredContent: { draft: '' } };
    const available =
      512_000 - Buffer.byteLength(JSON.stringify([...previous, contextValue(empty)]), 'utf8');
    const exact = sizedContext(Buffer.byteLength(JSON.stringify(empty), 'utf8') + available);
    const oversized = { structuredContent: { draft: exact.structuredContent.draft + 'x' } };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThan(128_000);
    expect(await update(oversized)).toHaveProperty(
      'error.message',
      expect.stringContaining('MCP_APP_CONTEXT_TOO_LARGE'),
    );
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual(previous);
    expect(await update(exact)).toHaveProperty('result');
    const full = await f.host.modelContext('task');
    expect(Buffer.byteLength(contextJson(full.text), 'utf8')).toBe(512_000);
    expect(JSON.parse(contextJson(full.text))).toEqual([...previous, contextValue(exact)]);

    const otherTask = await f.open('card-0', 'another-task');
    expect(await otherTask(maximum)).toHaveProperty('result');
    expect(JSON.parse(contextJson((await f.host.modelContext('another-task')).text))).toEqual([
      contextValue(maximum),
    ]);
    expect((await f.host.modelContext('task')).text).toBe(full.text);
  });

  it('reclaims the replaced context budget without consuming a later update', async () => {
    const f = fixture();
    const update = await f.open('card');
    const large = sizedContext(128_000);
    for (let index = 0; index < 3; index++) {
      const other = await f.open(`other-${index}`);
      expect(await other(large)).toHaveProperty('result');
    }
    const first = sizedContext(64_000);
    expect(await update(first)).toHaveProperty('result');
    const snapshot = await f.host.modelContext('task');
    const replacement = sizedContext(100_000);
    expect(await update(replacement)).toHaveProperty('result');
    snapshot.consume();
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual([
      contextValue(replacement),
    ]);
    const next = await f.open('next');
    expect(await next(large)).toHaveProperty('result');
  });

  it('keeps context budgets separate across accounts', async () => {
    const f = fixture();
    const maximum = sizedContext(128_000);
    for (let index = 0; index < 3; index++) {
      const update = await f.open(`card-${index}`);
      expect(await update(maximum)).toHaveProperty('result');
    }
    f.changeOwner();
    expect((await f.host.modelContext('task')).text).toBe('');
    const update = await f.open('new-account-card');
    expect(await update(maximum)).toHaveProperty('result');
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual([
      contextValue(maximum),
    ]);
  });
});
