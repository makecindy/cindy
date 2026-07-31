/**
 * mcp:custom:* IPC handlers —— 内存 db + IpcHarness 直接 invoke handler body。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { listCustomMcpServers } from '../../maker-host/custom-mcp-store.js';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerMcpHandlers, type McpHandlerDeps } from '../mcpHandlers.js';
import { IpcHarness } from './helpers/ipcHarness.js';

const CREATE_SQL = `
  CREATE TABLE custom_mcp_servers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}', command TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
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
    refreshProviders: vi.fn(async () => {}),
    broadcastChanged: vi.fn(() => {}),
    invalidateCodex: vi.fn(async () => {}),
    assertTrustedSender: vi.fn(() => {}),
    readCustomMcpEnvForMutation: vi.fn(() => null),
    writeCustomMcpEnvForMutation: vi.fn(() => true),
    removeCustomMcpEnvForMutation: vi.fn(() => ({ success: true })),
    ...over,
  };
}

afterEach(() => {
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('mcp:custom:* CRUD handlers', () => {
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

  it('does not persist a stdio config when encrypted env storage is unavailable', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({ writeCustomMcpEnvForMutation: vi.fn(() => false) });
    registerMcpHandlers(harness, deps);
    const stdio: CustomMcpConfig = {
      id: 'local-tools',
      name: 'Local tools',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '',
    };

    await expect(
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, stdio, { API_KEY: 'secret' }),
    ).rejects.toThrow(/INTERNAL/);
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.refreshProviders).not.toHaveBeenCalled();
  });

  it('preserves an existing stdio env when update omits an unresolved snapshot', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    const stdio: CustomMcpConfig = {
      id: 'local-tools',
      name: 'Local tools',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '',
    };
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, stdio, { API_KEY: 'secret' });
    vi.mocked(deps.readCustomMcpEnvForMutation).mockClear();
    vi.mocked(deps.writeCustomMcpEnvForMutation).mockClear();
    vi.mocked(deps.removeCustomMcpEnvForMutation).mockClear();

    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_UPDATE, { ...stdio, name: 'Renamed' });

    expect(deps.readCustomMcpEnvForMutation).not.toHaveBeenCalled();
    expect(deps.writeCustomMcpEnvForMutation).not.toHaveBeenCalled();
    expect(deps.removeCustomMcpEnvForMutation).not.toHaveBeenCalled();
    expect((await listCustomMcpServers())[0]?.name).toBe('Renamed');
  });

  it('rejects an invalid stdio env before touching config or safeStorage', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerMcpHandlers(harness, deps);
    const stdio: CustomMcpConfig = {
      id: 'local-tools',
      name: 'Local tools',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: '',
    };

    await expect(
      harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, stdio, { 'BAD-NAME': 'secret' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.readCustomMcpEnvForMutation).not.toHaveBeenCalled();
  });

  it('requires a trusted renderer before mutating MCP configuration', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({
      assertTrustedSender: vi.fn(() => {
        throw new Error('untrusted sender');
      }),
    });
    registerMcpHandlers(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig)).rejects.toThrow(
      'untrusted sender',
    );
    expect(await listCustomMcpServers()).toEqual([]);
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
    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig)).rejects.toThrow(
      /ALREADY_EXISTS/,
    );
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

  it('deletes the config when env cleanup is unavailable', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps({
      readCustomMcpEnvForMutation: vi.fn(() => {
        throw new Error('safeStorage unavailable');
      }),
      removeCustomMcpEnvForMutation: vi.fn(() => ({ success: false, error: 'remove_failed' })),
    });
    registerMcpHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.MCP_CUSTOM_CREATE, validConfig);

    await expect(harness.invoke(MAKER_INVOKE.MCP_CUSTOM_DELETE, validConfig.id)).resolves.toEqual({
      ok: true,
    });
    expect(await listCustomMcpServers()).toEqual([]);
    expect(deps.readCustomMcpEnvForMutation).not.toHaveBeenCalled();
    expect(deps.removeCustomMcpEnvForMutation).toHaveBeenCalledWith(validConfig.id);
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
