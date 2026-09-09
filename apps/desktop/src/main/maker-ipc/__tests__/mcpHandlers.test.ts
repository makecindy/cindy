/**
 * mcp:custom:* IPC handlers —— 内存 db + IpcHarness 直接 invoke handler body。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { McpProvider } from '@cindy/maker-core';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { createCustomMcpServer, listCustomMcpServers, listCustomMcpRuntimeGenerations } from '../../maker-host/custom-mcp-store.js';
import { buildBotMcpCatalog } from '../../maker-host/botMcpCatalog.js';
import {
  getBuiltinMcpServerNames,
  refreshCustomMcpProviders,
  registerCustomMcpArrays,
  resetCustomMcpRegistry,
} from '../../mcp-integrations/custom-mcp-registry.js';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerMcpHandlers, type McpHandlerDeps } from '../mcpHandlers.js';
import { IpcHarness } from './helpers/ipcHarness.js';

vi.mock('../../secrets/providerSecretStore.js', () => ({ readCustomMcpToken: () => null }));

const CREATE_SQL = `
  CREATE TABLE custom_mcp_servers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_custom_mcp_servers_sort_order ON custom_mcp_servers (sort_order);
`;

const validConfig: CustomMcpConfig = {
  id: 'mytools',
  name: 'My Tools',
  transport: 'http',
  url: 'https://example.com/mcp',
  headers: {},
};

let raw: Database.Database | null = null;
let client: DbClient | null = null;

function mountDb(): void {
  const dbHandle = new Database(':memory:');
  dbHandle.exec(CREATE_SQL);
  raw = dbHandle;
  client = {
    query: async () => [],
    queryOne: async () => undefined,
    exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
    tx: async () => {
      throw new Error('tx not used');
    },
    drizzle: drizzle(dbHandle, { schema }),
    vecAvailable: false,
    dispose: async () => {},
  };
  setCurrentDbClient(client, 'test-user');
}

function makeDeps(over: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
  return {
    listMcpServers: vi.fn(async () => []),
    resolveBotContext: vi.fn(async () => ({ agentKind: 'claude-code' as const })),
    refreshProviders: vi.fn(async () => {}),
    broadcastChanged: vi.fn(() => {}),
    invalidateCodex: vi.fn(async () => {}),
    ...over,
  };
}

afterEach(() => {
  resetCustomMcpRegistry();
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('mcp:custom:* CRUD handlers', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)(
    'projects registered MCP availability for %s while preserving the configuration list',
    async (agentKind) => {
      mountDb();
      const configs: CustomMcpConfig[] = [
        validConfig,
        { ...validConfig, id: 'events', transport: 'sse' },
        { ...validConfig, id: 'public-http', url: 'http://example.test/mcp' },
        { ...validConfig, id: 'local-http', url: 'http://localhost:4321/mcp' },
        { ...validConfig, id: 'cindy_memory' },
        { ...validConfig, id: '__proto__' },
        { ...validConfig, id: 'bad-headers', headers: { 'X-Test': 'line\nbreak' } },
      ];
      // Legacy rows bypass CRUD validation, as they would in an upgraded database.
      for (const config of configs) {
        raw!.prepare(`INSERT INTO custom_mcp_servers
          (id, name, transport, url, headers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)`)
          .run(config.id, config.name, config.transport, config.url, JSON.stringify(config.headers));
      }
      const providers: McpProvider[] = [{ name: 'cindy_memory' }];
      registerCustomMcpArrays(providers);
      await refreshCustomMcpProviders();
      const deps = makeDeps({
        listMcpServers: vi.fn(async (context) => buildBotMcpCatalog({
          ...context, providers, builtinNames: getBuiltinMcpServerNames(),
          customServers: await listCustomMcpRuntimeGenerations(),
        })),
      });
      const harness = new IpcHarness();
      registerMcpHandlers(harness, deps);
      const rawList = await listCustomMcpServers();
      expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST)).toEqual({ servers: rawList });
      expect(deps.listMcpServers).not.toHaveBeenCalled();

      const result = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST, { agentKind });
      expect(deps.listMcpServers).toHaveBeenCalledWith({ agentKind });
      expect(result).toEqual({ agentKind, servers: rawList.map((server) => ({
        ...server, available: ['mytools', 'local-http'].includes(server.id)
          || (server.id === 'events' && agentKind === 'claude-code')
          || (server.id === 'public-http' && agentKind !== 'pi'),
      })) });
    },
  );

  it('uses the canonical next-turn route instead of the renderer hint', async () => {
    mountDb();
    const harness = new IpcHarness();
    const chain = [{ harness: 'claude' as const, model: 'claude-x', providerId: null, effort: '', fastMode: false }];
    const deps = makeDeps({ resolveBotContext: vi.fn(async () => ({ agentKind: 'codex' as const })) });
    registerMcpHandlers(harness, deps);
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST, {
      agentKind: 'claude-code', botSessionId: 'canonical', modelChain: chain,
    })).toEqual({ agentKind: 'codex', servers: [] });
    expect(deps.resolveBotContext).toHaveBeenCalledWith('canonical', chain);
    expect(deps.listMcpServers).toHaveBeenCalledWith({ agentKind: 'codex' });
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

  it('does not fall back to a renderer hint for a missing canonical task', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({ resolveBotContext: vi.fn(async () => null) });
    registerMcpHandlers(harness, deps);
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST, {
      agentKind: 'claude-code', botSessionId: 'other-task',
    })).rejects.toThrow(/NOT_FOUND/);
    expect(deps.listMcpServers).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('evaluates the trusted SSH target for %s capability settings', async (agentKind) => {
    mountDb();
    await createCustomMcpServer(validConfig);
    const providers: McpProvider[] = [];
    registerCustomMcpArrays(providers);
    await refreshCustomMcpProviders();
    const deps = makeDeps({
      resolveBotContext: vi.fn(async () => ({ agentKind, remoteHostId: 'ssh-host' })),
      listMcpServers: vi.fn(async (context) => buildBotMcpCatalog({
        ...context, providers, builtinNames: getBuiltinMcpServerNames(),
        customServers: await listCustomMcpRuntimeGenerations(),
      })),
    });
    const harness = new IpcHarness();
    registerMcpHandlers(harness, deps);
    const result = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST, {
      agentKind: 'claude-code', botSessionId: 'canonical',
    });
    expect(deps.listMcpServers).toHaveBeenCalledWith({ agentKind, remoteHostId: 'ssh-host' });
    expect(result).toEqual({ agentKind, servers: [expect.objectContaining({ id: 'mytools', available: agentKind !== 'codex' })] });
  });

  it.each([null, {}, { agentKind: 'unknown' },
    { agentKind: 'codex', modelChain: [] },
    { agentKind: 'codex', botSessionId: 'canonical', modelChain: [{ harness: 'unknown', model: 'x' }] },
  ])('rejects an invalid catalog context: %j', async (context) => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST, context)).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.listMcpServers).not.toHaveBeenCalled();
  });

  it('lists empty initially', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    const res = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST);
    expect(res).toEqual({ servers: [] });
  });

  it('creates a valid server, persists it, refreshes + broadcasts', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);

    const res = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);
    expect(res).toEqual({ ok: true });
    expect(await listCustomMcpServers()).toHaveLength(1);
    expect(deps.refreshProviders).toHaveBeenCalledOnce();
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
    // Codex 侧失效:让新 codex 会话按新 MCP 配置重 spawn。
    expect(deps.invalidateCodex).toHaveBeenCalledOnce();
  });

  it('a failing invalidateCodex does not fail the CRUD (best-effort)', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({
      invalidateCodex: vi.fn(async () => {
        throw new Error('busy codex session');
      }),
    });
    registerMcpHandlers(harness, deps);
    // CRUD 已落库,Codex 失效抛错被吞,仍返回 ok。
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig)).resolves.toEqual({
      ok: true,
    });
    expect(await listCustomMcpServers()).toHaveLength(1);
    expect(deps.invalidateCodex).toHaveBeenCalledOnce();
  });

  it('rejects invalid config (bad url) with INVALID_PARAMS and does not write', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, { ...validConfig, url: 'ftp://x' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

  it('rejects duplicate id with ALREADY_EXISTS', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);
    await expect(
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig),
    ).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it('update on missing row rejects NOT_FOUND', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    await expect(
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...validConfig, id: 'ghost' }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('delete is idempotent and broadcasts', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);
    const res = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, 'mytools');
    expect(res).toEqual({ ok: true });
    expect(await listCustomMcpServers()).toEqual([]);
    // 再删一次(不存在)仍 ok。
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, 'mytools')).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects empty mcpId on delete', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, '')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });
});
