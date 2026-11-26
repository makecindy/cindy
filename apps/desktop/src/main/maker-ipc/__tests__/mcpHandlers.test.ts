/**
 * mcp:custom:* IPC handlers —— 内存 db + IpcHarness 直接 invoke handler body。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { safeStorage } from 'electron';
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
import type { CustomMcpInput, CustomMcpRemoteConfig } from '../../../shared/customMcp.js';
import { MAKER_INVOKE } from '../channels.js';
import { createCustomMcpServerForSetup, createCustomMcpServerFromMain, registerMcpHandlers, type McpHandlerDeps } from '../mcpHandlers.js';
import { callCloudManagement, cloudManagementProviderRegistry } from '../../host-settings/managementCalls.js';
import { configureCloudMcpCredentials, listMcpManagement } from '../../host-settings/managementData.js';
import { IpcHarness } from './helpers/ipcHarness.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { CustomMcpProvider } from '../../mcp-integrations/custom-mcp-provider.js';
import { createCustomMcpServer as createFromNativeForm, updateCustomMcpServer as updateFromNativeForm,
  deleteCustomMcpServer as deleteFromNativeForm } from '../../../renderer/lib/customMcpServers.js';

vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));
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
    headers TEXT NOT NULL DEFAULT '{}',
    command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, env TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_custom_mcp_servers_sort_order ON custom_mcp_servers (sort_order);
`;

const validConfig: CustomMcpRemoteConfig = {
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
    removeMcpToken: vi.fn(() => true),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(assertTrustedAppRendererEvent).mockReset();
  resetCustomMcpRegistry();
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('mcp:custom:* CRUD handlers', () => {
  // DB/IPC regression: a bad credential previously hid all settings, including its own delete action.
  it('lists healthy configurations and secret-free unreadable identities, and deletes damaged rows', async () => {
    mountDb();
    await createCustomMcpServer(validConfig);
    await createCustomMcpServer({ ...validConfig, id: 'broken-http', name: 'Broken HTTP' });
    await createCustomMcpServer({ id: 'broken-local', name: 'Broken local', transport: 'stdio', command: 'uvx', args: [], env: {} });
    raw!.prepare('UPDATE custom_mcp_servers SET headers = ? WHERE id = ?').run('safe-storage:v1:invalid-header-secret', 'broken-http');
    raw!.prepare('UPDATE custom_mcp_servers SET env = ? WHERE id = ?').run('invalid-environment-secret', 'broken-local');
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST)).toEqual({
      servers: [validConfig], unreadableServers: [
        { id: 'broken-http', name: 'Broken HTTP', transport: 'http', reason: 'unreadable' },
        { id: 'broken-local', name: 'Broken local', transport: 'stdio', reason: 'unreadable' },
      ],
    });
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, 'broken-http');
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, 'broken-local');
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST)).toEqual({ servers: [validConfig] });
  });

  // #11295, db tier: a mixed local/remote catalog must keep cloud HTTP CRUD working.
  // UI-only and fake domain adapters do not exercise the real, renderer-guarded handlers.
  it('keeps cloud management limited to remote transports in a mixed native catalog', async () => {
    mountDb();
    const local = { id: 'stdio-only', name: 'Private tool', transport: 'stdio' as const,
      command: 'private-command', args: [], env: { LOCAL: 'test-private' } };
    await createCustomMcpServer(local);
    const native = new IpcHarness();
    registerMcpHandlers(cloudManagementProviderRegistry(native), makeDeps());
    vi.mocked(assertTrustedAppRendererEvent).mockImplementation(() => { throw new Error('[PERMISSION_DENIED]'); });
    configureCloudMcpCredentials({ has: () => false, set: vi.fn(), remove: vi.fn() });
    const caller = { key: 'cloud-owner', assertCurrent() {} };
    const exec = { signal: new AbortController().signal, assertCurrent() {}, prompt() {}, onCancel() {} };
    const [create] = await listMcpManagement(caller);
    expect(await callCloudManagement(MAKER_INVOKE.MCP_CUSTOM_LIST, [], exec)).toEqual({ servers: [] });
    const values = { name: 'HTTP Tool', url: 'https://example.invalid/mcp', transport: 'http' };
    await create!.actions[0]!.run(values, exec);
    const entries = await listMcpManagement(caller);
    expect(entries.map(entry => entry.label)).toEqual(['Add MCP', 'HTTP Tool']);
    const edit = entries[1]!.actions.find(action => action.intent === 'edit')!;
    await edit.run({ ...values, name: 'Changed' }, exec);
    const renamed = (await listMcpManagement(caller)).find(entry => entry.label === 'Changed')!;
    await renamed.actions.find(action => action.intent === 'delete')!.run({}, exec);

    const stdioInput = { id: 'new-local', name: 'Local', transport: 'stdio', command: 'uvx',
      args: [], envChanges: { set: {}, remove: [] } };
    for (const [channel, input] of [
      [MAKER_INVOKE.MCP_CUSTOM_CREATE, stdioInput],
      [MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...validConfig, id: local.id }],
      [MAKER_INVOKE.MCP_CUSTOM_DELETE, local.id],
    ] as const) {
      await expect(callCloudManagement(channel, [input], exec)).rejects.toThrow(/PERMISSION_DENIED/);
    }
    expect(await listCustomMcpServers()).toEqual([local]);
  });

  // Security regression (db tier): an HTTP token survived HTTP → stdio → another HTTP URL.
  // Drive native IPC and observe the headers published to a real provider, not renderer call order.
  it('never publishes a previous HTTP bearer after a stdio round trip, including overlapping saves', async () => {
    mountDb();
    await createCustomMcpServer(validConfig);
    let token: string | null = 'fake-token-for-original-http';
    const published: Array<ReturnType<CustomMcpProvider['appServerConfig']>> = [];
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({
      removeMcpToken: () => { token = null; return true; },
      storeMcpToken: (_id, value) => { token = value; return true; },
      refreshProviders: async () => {
        for (const config of await listCustomMcpServers()) published.push(new CustomMcpProvider(config, () => token).appServerConfig());
      },
    }));
    const local: CustomMcpInput = { id: validConfig.id, name: 'Local', transport: 'stdio', command: 'uvx', args: [], envChanges: { set: {}, remove: [] } };
    vi.stubGlobal('window', { electronAPI: { maker: {
      updateCustomMcpServer: (...args: unknown[]) => harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, ...args),
    } } });
    await Promise.all([
      updateFromNativeForm(local, 'fake-previously-hydrated-token', false),
      updateFromNativeForm({ ...validConfig, url: 'https://different.example/mcp' }, '', false),
    ]);
    expect(token).toBeNull();
    expect(published.at(-1)).toMatchObject({ url: 'https://different.example/mcp' });
    expect(JSON.stringify(published)).not.toContain('fake-token-for-original-http');
  });

  it.each(['database', 'encryption'] as const)('preserves the working HTTP credential when conversion to stdio fails in %s', async failure => {
    mountDb();
    await createCustomMcpServer(validConfig);
    let token: string | null = 'fake-working-http-token';
    const harness = new IpcHarness();
    const deps = makeDeps({ removeMcpToken: () => { token = null; return true; } });
    registerMcpHandlers(harness, deps);
    if (failure === 'database') raw!.exec("CREATE TRIGGER reject_mcp_update BEFORE UPDATE ON custom_mcp_servers BEGIN SELECT RAISE(ABORT, 'fake update failure'); END;");
    const encryption = failure === 'encryption'
      ? vi.spyOn(safeStorage, 'encryptString').mockImplementationOnce(() => { throw new Error('fake encryption failure'); }) : undefined;
    try {
      await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { id: validConfig.id, name: 'Local', transport: 'stdio',
        command: 'uvx', args: [], envChanges: { set: { TOKEN: 'fake-env-token' }, remove: [] } }))
        .rejects.toThrow(failure === 'database' ? 'fake update failure' : 'MCP environment encryption failed');
    } finally { encryption?.mockRestore(); }
    expect(new CustomMcpProvider((await listCustomMcpServers())[0]!, () => token).appServerConfig())
      .toMatchObject({ url: validConfig.url, headers: { Authorization: 'Bearer fake-working-http-token' } });
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

  it('does not redirect a queued native save to an account selected while another save is publishing', async () => {
    mountDb();
    await createCustomMcpServer(validConfig);
    let token = 'fake-original-token';
    let publishing!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { publishing = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({
      storeMcpToken: (_id, value) => { token = value; return true; },
      refreshProviders: async () => { publishing(); await gate; },
    }));
    const first = harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...validConfig, name: 'First edit' });
    await entered;
    const queued = harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...validConfig, url: 'https://other.example/mcp' },
      { action: 'set', value: 'fake-wrong-owner-token' });
    setCurrentDbClient(client!, 'different-owner');
    resume();
    await first;
    await expect(queued).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('MCP settings owner changed') });
    expect((await listCustomMcpServers())[0]).toMatchObject({ name: 'First edit', url: validConfig.url });
    expect(token).toBe('fake-original-token');
  });

  it('blocks a new HTTP endpoint when obsolete-token removal fails and never revives it after a failed replacement', async () => {
    mountDb();
    await createCustomMcpServer({ id: validConfig.id, name: 'Local', transport: 'stdio', command: 'uvx', args: [], env: {} });
    let token: string | null = 'fake-leftover-token';
    let removable = false;
    const published: Array<ReturnType<CustomMcpProvider['appServerConfig']>> = [];
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({
      removeMcpToken: () => { if (!removable) return false; token = null; return true; },
      storeMcpToken: () => false,
      refreshProviders: async () => {
        for (const config of await listCustomMcpServers()) published.push(new CustomMcpProvider(config, () => token).appServerConfig());
      },
    }));
    const remote = { ...validConfig, url: 'https://new.example/mcp' };
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, remote, { action: 'set', value: 'fake-new-token' }))
      .rejects.toThrow('Could not clear the previous MCP credential');
    expect((await listCustomMcpServers())[0]!.transport).toBe('stdio');
    expect(published).toEqual([]);
    removable = true;
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, remote, { action: 'set', value: 'fake-new-token' });
    expect(token).toBeNull();
    expect(published).toEqual([{ id: remote.id, name: remote.name, url: remote.url, transport: 'http', headers: undefined }]);
  });

  it('allows stdio without an HTTP credential even when unused bearer cleanup fails', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({ removeMcpToken: () => false }));
    const local: CustomMcpInput = { id: 'local', name: 'Local', transport: 'stdio', command: 'uvx', args: [],
      envChanges: { set: {}, remove: [] } };
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, local)).resolves.toEqual({ ok: true });
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...local, name: 'Renamed' })).resolves.toEqual({ ok: true });
    expect((await listCustomMcpServers())[0]).toMatchObject({ name: 'Renamed', transport: 'stdio', env: {} });
  });

  // DB tier: drive the native form through real Main handlers. Stubbing these handlers
  // concealed token changes when the form stopped writing to generic safeStorage itself.
  it('publishes credentials saved by the native MCP form and revokes them on clear or deletion', async () => {
    mountDb();
    const tokens = new Map([[validConfig.id, 'fake-orphan-token']]);
    const published: Array<string | undefined> = [];
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps({
      removeMcpToken: id => { tokens.delete(id); return true; },
      storeMcpToken: (id, value) => { tokens.set(id, value); return true; },
      refreshProviders: async () => {
        const [config] = await listCustomMcpServers();
        if (!config) return;
        const route = new CustomMcpProvider(config, id => tokens.get(id) ?? null).appServerConfig();
        published.push(route.transport === 'stdio' ? undefined : route.headers?.Authorization);
      },
    }));
    vi.stubGlobal('window', { electronAPI: { maker: {
      createCustomMcpServer: (...args: unknown[]) => harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, ...args),
      updateCustomMcpServer: (...args: unknown[]) => harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, ...args),
      deleteCustomMcpServer: (id: string) => harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, id),
    } } });
    await createFromNativeForm(validConfig, ' fake-new-token ');
    await updateFromNativeForm(validConfig, 'fake-edited-token', false);
    await updateFromNativeForm({ ...validConfig, transport: 'sse' }, '', false);
    await updateFromNativeForm(validConfig, '', true);
    expect(tokens.has(validConfig.id)).toBe(false);
    await updateFromNativeForm(validConfig, 'fake-final-token', false);
    await deleteFromNativeForm(validConfig.id);

    expect(published).toEqual(['Bearer fake-new-token', 'Bearer fake-edited-token', 'Bearer fake-edited-token', undefined, 'Bearer fake-final-token']);
    expect(tokens.has(validConfig.id)).toBe(false);
    expect(await listCustomMcpServers()).toEqual([]);
  });

  // Native stdio setup contract: previously no environment input or redacted output existed.
  // Production IPC → encrypted SQLite → public list; minimum one fake secret. Tier: db.
  it('saves and edits stdio environment values without returning them in lists or receipts', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    const config: CustomMcpInput = { id: 'grafana', name: 'Grafana', transport: 'stdio',
      command: 'uvx', args: ['mcp-grafana'], envChanges: {
        set: { GRAFANA_URL: 'https://example.test', GRAFANA_SERVICE_ACCOUNT_TOKEN: 'invalid-test-only-secret' }, remove: [],
      } };
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, config)).toEqual({ ok: true });
    const listed = await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST);
    expect(listed).toEqual({ servers: [{ id: config.id, name: config.name, transport: 'stdio', command: 'uvx',
      args: ['mcp-grafana'], envKeys: ['GRAFANA_SERVICE_ACCOUNT_TOKEN', 'GRAFANA_URL'] }] });
    expect(JSON.stringify(listed)).not.toContain('invalid-test-only-secret');
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...config, name: 'Renamed',
      envChanges: { set: {}, remove: ['GRAFANA_URL'] } })).toEqual({ ok: true });
    expect((await listCustomMcpServers())[0]).toMatchObject({ name: 'Renamed', env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: 'invalid-test-only-secret' } });
    expect(await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_LIST)).toMatchObject({ servers: [{ envKeys: ['GRAFANA_SERVICE_ACCOUNT_TOKEN'] }] });
  });

  it('rejects untrusted stdio configuration and plaintext readback attempts', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerMcpHandlers(harness, makeDeps());
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, { id: 'local', name: 'Local', transport: 'stdio',
      command: 'uvx', args: [], env: { TOKEN: 'invalid-secret' } })).rejects.toThrow(/INVALID_PARAMS/);
    vi.mocked(assertTrustedAppRendererEvent).mockImplementation(() => { throw new Error('[PERMISSION_DENIED]'); });
    for (const channel of [MAKER_INVOKE.MCP_CUSTOM_CREATE, MAKER_INVOKE.MCP_CUSTOM_UPDATE,
      MAKER_INVOKE.MCP_CUSTOM_LIST, MAKER_INVOKE.MCP_CUSTOM_DELETE, MAKER_INVOKE.MCP_CUSTOM_REFRESH]) {
      await expect(harness.invoke(channel, validConfig)).rejects.toThrow(/PERMISSION_DENIED/);
    }
    expect(await listCustomMcpServers()).toEqual([]);
  });

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
      const configs: CustomMcpRemoteConfig[] = [
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
  });

  // Unit regression: saving a custom MCP used to invoke the shared-host
  // retirement hook, closing even idle task Sessions. Exercise create/edit and
  // token refresh through the production handlers; persistence must not retire them.
  it('saves new and edited configurations without invoking the old session-retirement hook', async () => {
    mountDb();
    const harness = new IpcHarness();
    const retireSessions = vi.fn(async () => {});
    const deps = { ...makeDeps(), invalidateCodex: retireSessions };
    registerMcpHandlers(harness, deps);
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig)).resolves.toEqual({
      ok: true,
    });
    const updated = { ...validConfig, url: 'https://updated.example.com/mcp' };
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, updated)).resolves.toEqual({ ok: true });
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_REFRESH);
    expect(await listCustomMcpServers()).toEqual([expect.objectContaining(updated)]);
    expect(retireSessions).not.toHaveBeenCalled();
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
