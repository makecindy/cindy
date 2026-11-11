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
import { createCustomMcpServer, listCustomMcpServers, listCustomMcpRuntimeGenerations } from '../../maker-host/custom-mcp-store.desktop.js';
import { buildBotMcpCatalog } from '../../maker-host/botMcpCatalog.js';
import {
  getBuiltinMcpServerNames,
  refreshCustomMcpProviders,
  registerCustomMcpArrays,
  resetCustomMcpRegistry,
} from '../../mcp-integrations/custom-mcp-registry.desktop.js';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';
import { MAKER_INVOKE } from '../channels.js';
import { createCustomMcpServerForSetup, createCustomMcpServerFromMain, registerMcpHandlers, type McpHandlerDeps } from '../mcpHandlers.js';
import { refreshCodexMcpEnvironment } from '../codexMcpRefresh.js';
import { DeferredCodexRestartService } from '../deferredCodexRestart.js';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';
import { IpcHarness } from './helpers/ipcHarness.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';

vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));

// This suite uses isolated SQLite fixtures; OS encryption is covered by the store suite.
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  return { ...actual, safeStorage: {
    ...actual.safeStorage,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  } };
});

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
  vi.mocked(assertTrustedAppRendererEvent).mockReset();
  resetCustomMcpRegistry();
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('mcp:custom:* CRUD handlers', () => {
  // PR #9055: unit IPC boundary; valid payload from an untrusted sender must neither
  // disclose connections nor persist a choice. The shared guard has its own frame tests.
  it('rejects untrusted duplicate reads and writes before accessing preferences', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ listDuplicates: vi.fn(), chooseDuplicate: vi.fn() });
    registerMcpHandlers(harness, deps);
    vi.mocked(assertTrustedAppRendererEvent).mockImplementation(() => { throw new Error('[PERMISSION_DENIED]'); });
    await expect(harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_LIST)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_CHOOSE, { id: 'a'.repeat(64), choice: 'claude' })).rejects.toThrow(/PERMISSION_DENIED/);
    expect(deps.listDuplicates).not.toHaveBeenCalled();
    expect(deps.chooseDuplicate).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });
  // #8902, unit: the production IPC validates choices, detects stale candidates,
  // and broadcasts only after persistence; existing CRUD tests have no such path.
  it('validates duplicate choices and reports configuration drift without broadcasting success', async () => {
    const harness = new IpcHarness();
    const chooseDuplicate = vi.fn(async () => true);
    const deps = makeDeps({ chooseDuplicate, listDuplicates: async () => ({ connections: [], complete: true }) });
    registerMcpHandlers(harness, deps);
    expect(await harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_LIST)).toEqual({ connections: [], complete: true });
    await expect(harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_CHOOSE, { id: '../config', choice: 'cindy' })).rejects.toThrow(/INVALID_PARAMS/);
    expect(chooseDuplicate).not.toHaveBeenCalled();
    const input = { id: 'a'.repeat(64), choice: 'claude' };
    expect(await harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_CHOOSE, input)).toEqual({ ok: true });
    expect(chooseDuplicate).toHaveBeenCalledWith(input.id, 'claude');
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
    chooseDuplicate.mockResolvedValue(false);
    await expect(harness.invoke(MAKER_INVOKE.MCP_DUPLICATES_CHOOSE, input)).rejects.toThrow(/NOT_FOUND/);
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
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

// #6473 B2: Main setup must distinguish saved configuration from token/refresh failure.
// Existing public CRUD tests miss the Main-only receipt; unit tier, in-memory SQLite.
// Minimal input: one valid row and a failing injected writer/refresher. Not run in edit window.
describe('MCP setup creation receipt', () => {
  it.each([
    ['false', 'ok', 'failed', null],
    ['throw', 'ok', 'failed', null],
    ['saved', 'known', 'saved', 'PERMISSION_DENIED'],
    ['saved', 'unknown', 'saved', 'INTERNAL'],
    ['false', 'known', 'failed', 'PERMISSION_DENIED'],
    ['none', 'ok', 'not-requested', null],
  ] as const)('separates token %s and refresh %s without disclosing exceptions', async (tokenMode, refreshMode, tokenResult, refreshError) => {
    mountDb();
    const writer = vi.fn(() => {
      if (tokenMode === 'throw') throw new Error('fake-secret writer exception');
      return tokenMode === 'saved';
    });
    const deps = makeDeps({
      storeMcpToken: writer,
      refreshProviders: vi.fn(async () => {
        if (refreshMode === 'known') throw Object.assign(new Error('fake-secret refresh'), { code: 'PERMISSION_DENIED' });
        if (refreshMode === 'unknown') throw new Error('fake-secret unknown refresh');
      }),
    });
    registerMcpHandlers(new IpcHarness(), deps);
    const receipt = await createCustomMcpServerForSetup(validConfig, tokenMode === 'none' ? null : 'fake-token');
    expect(receipt).toEqual({ configurationSaved: true, token: tokenResult, refreshError });
    expect(JSON.stringify(receipt)).not.toContain('fake-secret');
    expect(await listCustomMcpServers()).toHaveLength(1);
    expect(writer).toHaveBeenCalledTimes(tokenMode === 'none' ? 0 : 1);
    expect(deps.refreshProviders).toHaveBeenCalledOnce();
  });

  it('rejects configuration failures before writing a token or reporting saved', async () => {
    mountDb();
    const deps = makeDeps({ storeMcpToken: vi.fn(() => true) });
    registerMcpHandlers(new IpcHarness(), deps);
    await expect(createCustomMcpServerForSetup({ ...validConfig, url: 'ftp://invalid' }, 'fake-token')).rejects.toThrow(/INVALID_PARAMS/);
    raw!.exec("CREATE TRIGGER reject_mcp_insert BEFORE INSERT ON custom_mcp_servers BEGIN SELECT RAISE(ABORT, 'fake insert failure'); END;");
    await expect(createCustomMcpServerForSetup(validConfig, 'fake-token')).rejects.toThrow('fake insert failure');
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.storeMcpToken).not.toHaveBeenCalled();
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

  it('keeps the legacy Main void and public IPC ok contracts and public refresh rejection', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    await expect(createCustomMcpServerFromMain(validConfig, null)).resolves.toBeUndefined();
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, { ...validConfig, id: 'public-copy' })).resolves.toEqual({ ok: true });
    vi.mocked(deps.refreshProviders).mockRejectedValueOnce(new Error('fake public refresh failure'));
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, { ...validConfig, id: 'public-failure' })).rejects.toThrow('fake public refresh failure');
    expect(await listCustomMcpServers()).toHaveLength(3);
  });
});
