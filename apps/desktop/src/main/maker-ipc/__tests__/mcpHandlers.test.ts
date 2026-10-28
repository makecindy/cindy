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
import { refreshCodexMcpEnvironment } from '../codexMcpRefresh.js';
import { DeferredCodexRestartService } from '../deferredCodexRestart.js';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';
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
  it('does not block healthy tasks after an uncommitted new MCP credential fails', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    const control = registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    const waiting = control.waitForStableConfiguration();
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH,
      { saveId: receipt.saveId, committed: false })).rejects.toThrow('credential save failed');
    await expect(waiting).resolves.toBeUndefined();
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.invalidateCodex).not.toHaveBeenCalled();
  });
  it('retains recovery protection when a new config was written before runtime refresh failed', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({ refreshProviders: vi.fn().mockRejectedValueOnce(new Error('fixture registry failure')) });
    const control = registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH,
      { saveId: receipt.saveId, committed: true })).rejects.toThrow('fixture registry failure');
    expect(await listCustomMcpServers()).toMatchObject([validConfig]);
    await expect(control.waitForStableConfiguration()).rejects.toThrow('configuration save failed');
    const retry = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, { saveId: retry.saveId, committed: true });
    await expect(control.waitForStableConfiguration()).resolves.toBeUndefined();
  });
  it('commits duplicate finalization receipts only once, including a lost reply retry', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    const final = { saveId: receipt.saveId, committed: true };
    await Promise.all([harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, final),
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, final)]);
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, final)).resolves.toEqual({ ok: true });
    expect(deps.refreshProviders).toHaveBeenCalledOnce();
    expect(await listCustomMcpServers()).toHaveLength(1);
  });

  it('releases a staged save as failed when its settings window disappears', async () => {
    mountDb();
    await createCustomMcpServer(validConfig);
    const harness = new IpcHarness();
    const deps = makeDeps();
    const control = registerMcpHandlers(harness, deps);
    await harness.invokeFrom(7, MAKER_INVOKE.MCP_CUSTOM_UPDATE, validConfig, { deferRuntimeRefresh: true });
    const waiting = control.waitForStableConfiguration();
    harness.destroySender(7);
    await expect(waiting).rejects.toThrow('configuration save failed');
    expect(control.hasPendingSave()).toBe(false);
    expect(await listCustomMcpServers()).toMatchObject([validConfig]);
    expect(deps.invalidateCodex).not.toHaveBeenCalled();
  });
  it('releases healthy tasks when a window abandons a new MCP before config commit', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    const control = registerMcpHandlers(harness, deps);
    await harness.invokeFrom(7, MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig, { deferRuntimeRefresh: true });
    const waiting = control.waitForStableConfiguration();
    harness.destroySender(7);
    await expect(waiting).resolves.toBeUndefined();
    expect(control.hasPendingSave()).toBe(false);
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.invalidateCodex).not.toHaveBeenCalled();
  });
  it('holds original-task input until configuration and credential commit both finish', async () => {
    mountDb();
    const harness = new IpcHarness();
    const backgroundReload = vi.fn();
    let control!: ReturnType<typeof registerMcpHandlers>;
    const runtimeChanged = vi.fn(() => {
      // Production notifications arrive before finalization releases the barrier.
      void control.waitForStableConfiguration().then(backgroundReload);
    });
    const deps = makeDeps({ runtimeChanged });
    control = registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    const dispatch = vi.fn();
    const waiting = control.waitForStableConfiguration().then(dispatch);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.refreshProviders).not.toHaveBeenCalled();
    expect(await listCustomMcpServers()).toEqual([]);
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, { saveId: receipt.saveId, committed: true });
    await waiting;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(runtimeChanged).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(backgroundReload).toHaveBeenCalledOnce());
    expect(deps.refreshProviders).toHaveBeenCalledOnce();
  });

  it('keeps a failed credential save visible and permits a successful retry', async () => {
    mountDb();
    await createCustomMcpServer(validConfig);
    const harness = new IpcHarness();
    const deps = makeDeps();
    const control = registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH,
      { saveId: receipt.saveId, committed: false })).rejects.toThrow('credential save failed');
    await expect(control.waitForStableConfiguration()).rejects.toThrow('configuration save failed');
    expect(deps.invalidateCodex).not.toHaveBeenCalled();
    expect(await listCustomMcpServers()).toMatchObject([validConfig]);
    const retry = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH, { saveId: retry.saveId, committed: true });
    await expect(control.waitForStableConfiguration()).resolves.toBeUndefined();
  });

  it('rejects overlapping saves before a second writer can change the configuration', async () => {
    mountDb();
    const harness = new IpcHarness();
    const control = registerMcpHandlers(harness, makeDeps());
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, validConfig, { deferRuntimeRefresh: true });
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE,
      { ...validConfig, name: 'overlapping' }, { deferRuntimeRefresh: true })).rejects.toThrow('already being saved');
    expect((await listCustomMcpServers())[0].name).toBe(validConfig.name);
    control.dispose();
  });

  it('rejects an old owner commit without refreshing the new owner', async () => {
    mountDb();
    const harness = new IpcHarness();
    let owner = 'first';
    const deps = makeDeps({ ownerKey: () => owner });
    const control = registerMcpHandlers(harness, deps);
    const receipt = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig,
      { deferRuntimeRefresh: true }) as { saveId: string };
    const waiting = control.waitForStableConfiguration();
    owner = 'second';
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH,
      { saveId: receipt.saveId, committed: true })).rejects.toThrow('inactive owner');
    control.dispose();
    await expect(waiting).rejects.toThrow('owner changed');
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

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
        // Registered custom MCPs now use the Main-owned Apps facade for every harness.
        ...server, available: ['mytools', 'local-http', 'events', 'public-http'].includes(server.id),
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
    expect(result).toEqual({ agentKind, servers: [expect.objectContaining({ id: 'mytools', available: true })] });
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

  // P1 integration: both production write handlers reject the engine-owned id
  // before storing or refreshing it; the config validator is not mocked.
  it('rejects native Apps collisions on create and update before side effects', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    for (const channel of [MAKER_INVOKE.MCP_CUSTOM_CREATE, MAKER_INVOKE.MCP_CUSTOM_UPDATE]) {
      await expect(harness.invoke(channel, { ...validConfig, id: 'codex_apps' })).rejects.toThrow(/reserved/);
    }
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.refreshProviders).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
    expect(deps.invalidateCodex).not.toHaveBeenCalled();
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

  it('retains persisted MCP edits during a control RPC and refreshes the latest config before next start', async () => {
    mountDb();
    let rpcBusy = true;
    let bridgeConfig: CustomMcpConfig[] = [];
    const shutdown = vi.fn(async () => { bridgeConfig = await listCustomMcpServers(); });
    const restart = async (refresh: () => Promise<void>) => {
      if (rpcBusy) throw new CodexCredentialModeSwitchBusyError([]);
      await refresh();
    };
    const deferred = new DeferredCodexRestartService({
      hasBusyLocalCodexSession: () => false,
      listLocalCodexSessionIds: () => [],
      restart: (applyRuntime) => restart(async () => {
        if (await applyRuntime()) await shutdown();
      }),
    });
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({
      invalidateCodex: async () => {
        await refreshCodexMcpEnvironment({
          restartCodex: restart,
          shutdownCodexEnvironment: shutdown,
          onDeferred: () => deferred.schedule('Custom MCP configuration changed'),
        });
      },
    }));
    try {
      await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);
      const updated = { ...validConfig, url: 'https://updated.example.com/mcp' };
      await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, updated);
      expect(await listCustomMcpServers()).toEqual([expect.objectContaining(updated)]);
      await deferred.flushBeforeLocalCodexSessionStart();
      expect(deferred.isPending()).toBe(true);
      expect(shutdown).not.toHaveBeenCalled();
      expect(bridgeConfig).toEqual([]);

      rpcBusy = false;
      await deferred.flushBeforeLocalCodexSessionStart();
      expect(deferred.isPending()).toBe(false);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(bridgeConfig).toEqual([expect.objectContaining(updated)]);
    } finally {
      deferred.clear();
    }
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
