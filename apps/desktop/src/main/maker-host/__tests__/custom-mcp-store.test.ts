/**
 * custom-mcp-store —— 校验纯函数 + localDb CRUD（in-memory db 注入）+ 账号隔离。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage } from 'electron';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const setupDialog = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  return { ...actual, dialog: { ...actual.dialog, showMessageBox: setupDialog.showMessageBox }, safeStorage: { ...actual.safeStorage, getSelectedStorageBackend: () => 'gnome_libsecret' } };
});

// Exercise the real store with authenticated encryption; no OS keychain or user profile.
const cipherKey = randomBytes(32);
beforeEach(() => {
  vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true);
  vi.spyOn(safeStorage, 'encryptString').mockImplementation((value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  });
  vi.spyOn(safeStorage, 'decryptString').mockImplementation((value) => {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setupDialog.showMessageBox.mockReset(); });

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import {
  createCustomMcpServer,
  deleteCustomMcpServer,
  getCustomMcpServer,
  listCustomMcpServers,
  listCustomMcpNamesForSetup,
  updateCustomMcpServer,
  validateCustomMcpConfig,
} from '../custom-mcp-store.js';
import { confirmSetupTransfer } from '../../setup-migration/transferPrompt.js';
import { createSetupTransferSource, SetupTransferBox } from '../../setup-migration/transfer.js';
import { parseSetupSecretBundle, type SetupSecretBundle } from '@cindy/device-link';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';

const CREATE_SQL = `
  CREATE TABLE custom_mcp_servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_custom_mcp_servers_sort_order ON custom_mcp_servers (sort_order);
`;

const valid: CustomMcpConfig = {
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
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      dbHandle.prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      dbHandle.prepare(sql).get(...params) as T | undefined,
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

afterEach(() => {
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('validateCustomMcpConfig', () => {
  it('accepts a valid http config', () => {
    expect(validateCustomMcpConfig(valid)).toEqual({ ok: true });
  });

  it('accepts sse + headers', () => {
    expect(
      validateCustomMcpConfig({ ...valid, transport: 'sse', headers: { 'X-Foo': 'bar' } }),
    ).toEqual({ ok: true });
  });

  it('rejects bad id slug', () => {
    expect(validateCustomMcpConfig({ ...valid, id: 'Bad Id' }).ok).toBe(false);
  });

  it('rejects empty name', () => {
    expect(validateCustomMcpConfig({ ...valid, name: '  ' }).ok).toBe(false);
  });

  it('rejects invalid transport', () => {
    expect(validateCustomMcpConfig({ ...valid, transport: 'stdio' }).ok).toBe(false);
  });

  it('rejects non-http(s) / malformed url', () => {
    expect(validateCustomMcpConfig({ ...valid, url: 'ftp://x' }).ok).toBe(false);
    expect(validateCustomMcpConfig({ ...valid, url: 'not a url' }).ok).toBe(false);
  });

  it('rejects non-string headers', () => {
    expect(validateCustomMcpConfig({ ...valid, headers: { X: 1 } }).ok).toBe(false);
  });

  it('rejects invalid HTTP header names', () => {
    for (const name of ['X Name', '中文', 'X\nName']) {
      const result = validateCustomMcpConfig({ ...valid, headers: { [name]: 'value' } });
      expect(result.ok, `${JSON.stringify(name)} should be rejected`).toBe(false);
      expect(result.ok === false && result.message).toContain('valid HTTP tokens');
    }
  });

  it('accepts HTTP token header names after trimming', () => {
    expect(
      validateCustomMcpConfig({
        ...valid,
        headers: { ' X-API_Key ': 'value', "X-Trace.Id!#$%&'*+-.^_`|~": 'value' },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects non-printable ASCII header values', () => {
    for (const value of ['中文', '😀', 'line\nfeed', 'tab\tvalue']) {
      const result = validateCustomMcpConfig({ ...valid, headers: { 'X-Name': value } });
      expect(result.ok, `${JSON.stringify(value)} should be rejected`).toBe(false);
      expect(result.ok === false && result.message).toContain('printable ASCII');
    }
  });

  it('accepts printable ASCII header values', () => {
    expect(
      validateCustomMcpConfig({
        ...valid,
        headers: { 'X-Name': 'alice', Authorization: 'Bearer token-123/+_=' },
      }),
    ).toEqual({ ok: true });
  });

  // 撞名的自定义 MCP 会在装配层顶替同名内置 server，并继承 MCP 审批策略里对该
  // server 名的信任（策略只看 serverName），所以 id 必须在 CRUD 阶段就拒收。
  it('rejects ids reserved by builtin MCP servers', () => {
    const result = validateCustomMcpConfig({ ...valid, id: 'cindy_browser' }, [
      'cindy_browser',
      'cindy_helper',
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('reserved');
  });

  // Native names are reserved even before any transport provider is registered.
  it('rejects the native Apps id without rejecting a distinct custom id', () => {
    expect(validateCustomMcpConfig({ ...valid, id: 'codex_apps' })).toMatchObject({
      ok: false, code: 'INVALID_PARAMS', message: expect.stringContaining('reserved'),
    });
    expect(validateCustomMcpConfig({ ...valid, id: 'codex_apps_custom' })).toEqual({ ok: true });
  });

  it('keeps accepting ids that only resemble a builtin name', () => {
    expect(validateCustomMcpConfig({ ...valid, id: 'cindy_browser_x' }, ['cindy_browser'])).toEqual({
      ok: true,
    });
  });

  it('does not infer dynamic builtin names when no reserved list is supplied', () => {
    expect(validateCustomMcpConfig({ ...valid, id: 'cindy_browser' })).toEqual({ ok: true });
  });

  // slug 正则允许下划线，`__proto__` 因此是合法 id，而 server 名会被当作对象 key 用。
  it('rejects ids that are unsafe as object keys', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(validateCustomMcpConfig({ ...valid, id }).ok, `${id} should be rejected`).toBe(false);
    }
  });
});

describe('custom-mcp-store CRUD', () => {
  it('creates, lists, gets, updates, deletes', async () => {
    mountDb();
    expect(await listCustomMcpServers()).toEqual([]);

    await createCustomMcpServer(valid);
    const list = await listCustomMcpServers();
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe('https://example.com/mcp');

    const got = await getCustomMcpServer('mytools');
    expect(got?.name).toBe('My Tools');
    expect(got?.transport).toBe('http');

    const updated = await updateCustomMcpServer('mytools', {
      ...valid,
      name: 'My Tools v2',
      transport: 'sse',
      headers: { 'X-Org': 'acme' },
    });
    expect(updated?.name).toBe('My Tools v2');
    const after = await getCustomMcpServer('mytools');
    expect(after?.transport).toBe('sse');
    expect(after?.headers).toEqual({ 'X-Org': 'acme' });

    await deleteCustomMcpServer('mytools');
    expect(await listCustomMcpServers()).toEqual([]);
    expect(await getCustomMcpServer('mytools')).toBeNull();
  });

  it('update returns null when row absent', async () => {
    mountDb();
    expect(await updateCustomMcpServer('ghost', valid)).toBeNull();
  });

  it('isolates data per db file (account switch = new db)', async () => {
    mountDb();
    await createCustomMcpServer(valid);
    expect(await listCustomMcpServers()).toHaveLength(1);
    if (client) clearCurrentDbClient(client);
    raw?.close();
    mountDb();
    expect(await listCustomMcpServers()).toEqual([]);
  });
});

// Regression: PR #6473 two-device test found fake Authorization values in SQLite/WAL.
// Existing CRUD tests only checked round-trips. Minimum failure: one nonempty header.
// Tier: existing in-memory DB store suite; validates persistence, upgrade and failure semantics.
describe('encrypted MCP headers', () => {
  const headers = { Authorization: 'Bearer invalid-test-only-secret' };
  const stored = () => (raw!.prepare('SELECT headers FROM custom_mcp_servers WHERE id = ?').get(valid.id) as { headers: string }).headers;

  it('never stores new or updated header values as plaintext and still resolves them', async () => {
    mountDb();
    await createCustomMcpServer({ ...valid, headers });
    expect(stored()).not.toContain(headers.Authorization);
    expect((await getCustomMcpServer(valid.id))?.headers).toEqual(headers);
    await updateCustomMcpServer(valid.id, { ...valid, headers: { 'X-Key': 'invalid-replacement' } });
    expect(stored()).not.toContain('invalid-replacement');
    expect((await listCustomMcpServers())[0].headers).toEqual({ 'X-Key': 'invalid-replacement' });
  });

  it('upgrades legacy headers before returning them without changing the runtime generation', async () => {
    mountDb();
    await createCustomMcpServer(valid, 100);
    raw!.prepare('UPDATE custom_mcp_servers SET headers = ?').run(JSON.stringify(headers));
    expect((await listCustomMcpServers())[0].headers).toEqual(headers);
    expect(stored()).not.toContain(headers.Authorization);
    expect(raw!.prepare('SELECT updated_at FROM custom_mcp_servers').get()).toEqual({ updated_at: 100 });
  });

  it('preserves the entire existing row when encryption is unavailable', async () => {
    mountDb();
    await createCustomMcpServer({ ...valid, headers });
    const before = stored();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(updateCustomMcpServer(valid.id, { ...valid, name: 'changed', headers })).rejects.toThrow();
    expect(stored()).toBe(before);
    expect(raw!.prepare('SELECT name FROM custom_mcp_servers').get()).toEqual({ name: valid.name });
  });

  it('retains old credentials when a database write fails after encryption', async () => {
    mountDb();
    await createCustomMcpServer({ ...valid, headers });
    const before = stored();
    raw!.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON custom_mcp_servers BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    await expect(updateCustomMcpServer(valid.id, { ...valid, headers: { Authorization: 'invalid-new' } })).rejects.toThrow('test write failure');
    expect(stored()).toBe(before);
    expect((await getCustomMcpServer(valid.id))?.headers).toEqual(headers);
  });

  it('keeps legacy data on failed conversion and does not return it as a successful read', async () => {
    mountDb();
    await createCustomMcpServer(valid);
    raw!.prepare('UPDATE custom_mcp_servers SET headers = ?').run(JSON.stringify(headers));
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(listCustomMcpServers()).rejects.toThrow();
    expect(stored()).toBe(JSON.stringify(headers));
  });

  it('reports corrupt ciphertext without replacing it with an empty header map', async () => {
    mountDb();
    await createCustomMcpServer({ ...valid, headers });
    const before = stored();
    vi.mocked(safeStorage.decryptString).mockImplementation(() => { throw new Error('decrypt failed'); });
    await expect(getCustomMcpServer(valid.id)).rejects.toThrow();
    expect(stored()).toBe(before);
  });
});

// Regression #6473: preparing source consent used listCustomMcpServers, decrypting/upgrading
// headers before the user answered. Existing round-trip tests did not cover prompt preparation.
// Tier: existing in-memory store suite. Minimum input: selected legacy row + unselected bad ciphertext.
// Timing: not run in the edit-only window; measure with the next authorized targeted run.
describe('setup consent MCP metadata', () => {
  async function rows() {
    mountDb();
    await createCustomMcpServer(valid, 100);
    await createCustomMcpServer({ ...valid, id: 'other', name: 'Other' }, 101);
    raw!.prepare('UPDATE custom_mcp_servers SET headers = ? WHERE id = ?')
      .run('{"Authorization":"invalid-legacy-test-only"}', valid.id);
    raw!.prepare('UPDATE custom_mcp_servers SET headers = ? WHERE id = ?')
      .run('safe-storage:v1:not-valid-ciphertext', 'other');
    raw!.exec("CREATE TRIGGER no_consent_update BEFORE UPDATE ON custom_mcp_servers BEGIN SELECT RAISE(ABORT, 'unexpected consent write'); END");
    vi.mocked(safeStorage.decryptString).mockClear();
    vi.mocked(safeStorage.encryptString).mockClear();
  }

  it('selects only requested names without touching legacy or corrupt headers', async () => {
    await rows();
    const before = raw!.prepare('SELECT * FROM custom_mcp_servers ORDER BY id').all();
    expect(await listCustomMcpNamesForSetup([valid.id, valid.id, 'missing']))
      .toEqual([{ id: valid.id, name: valid.name }]);
    expect(await listCustomMcpNamesForSetup([])).toEqual([]);
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(raw!.prepare('SELECT * FROM custom_mcp_servers ORDER BY id').all()).toEqual(before);
  });

  it.each([false, true])('reads secrets only after consent allowed=%s', async (allowed) => {
    await rows();
    // Use the corrupt selected row: denial must never try to open it; approval must report
    // its real read error instead of silently converting it to an empty credential bundle.
    const collect = vi.fn(async (): Promise<SetupSecretBundle> => {
      await getCustomMcpServer('other');
      return { providers: [], mcpServers: [], builtinKeys: [], plugins: [] };
    });
    const authorize = vi.fn(async () => []);
    const seal = vi.spyOn(SetupTransferBox.prototype, 'seal');
    const confirm = vi.fn(async () => {
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      expect(seal).not.toHaveBeenCalled();
      return allowed;
    });
    const handle = createSetupTransferSource({
      ownerKey: () => 'owner-test', requesterName: async () => 'New computer',
      describeSecrets: async (request) => (await listCustomMcpNamesForSetup(request.mcpServers)).map((row) => row.name),
      describeSshHosts: async () => ['test-host'], sshKeyFingerprint: () => 'SHA256:test',
      confirm, collectSecrets: collect, authorizeSsh: authorize,
    });
    await expect(handle({
      action: 'transfer', requestId: 'request-test-001', publicKey: new SetupTransferBox().publicKey,
      secrets: { providers: [], mcpServers: ['other'], builtinKeys: [], plugins: [] },
      ssh: { publicKey: `ssh-ed25519 ${'A'.repeat(68)} test`, hosts: ['test-host'] },
    }, 'requester-test')).rejects.toThrow(allowed ? 'MCP header credentials are unreadable' : 'SETUP_TRANSFER_DECLINED');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(seal).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(raw!.prepare('SELECT headers FROM custom_mcp_servers WHERE id = ?').get(valid.id))
      .toEqual({ headers: '{"Authorization":"invalid-legacy-test-only"}' });
  });

  it('times out the native consent prompt without opening credentials or authorizing SSH', async () => {
    await rows();
    vi.useFakeTimers();
    let shown!: () => void;
    const dialogShown = new Promise<void>((resolve) => { shown = resolve; });
    setupDialog.showMessageBox.mockImplementation((options: { signal: AbortSignal }) => {
      shown();
      return new Promise<{ response: number }>((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ response: 0 }), { once: true });
      });
    });
    const collect = vi.fn(async (): Promise<SetupSecretBundle> => {
      await listCustomMcpServers();
      return { providers: [], mcpServers: [], builtinKeys: [], plugins: [] };
    });
    const authorize = vi.fn(async () => []);
    const seal = vi.spyOn(SetupTransferBox.prototype, 'seal');
    const handle = createSetupTransferSource({
      ownerKey: () => 'owner-test', requesterName: async () => 'New computer',
      describeSecrets: async (request) => (await listCustomMcpNamesForSetup(request.mcpServers)).map((row) => row.name),
      describeSshHosts: async () => ['test-host'], sshKeyFingerprint: () => 'SHA256:test',
      confirm: (prompt, timeout) => confirmSetupTransfer(prompt, timeout, null),
      collectSecrets: collect, authorizeSsh: authorize,
    });
    const result = handle({
      action: 'transfer', requestId: 'request-test-001', publicKey: new SetupTransferBox().publicKey,
      secrets: { providers: [], mcpServers: [valid.id], builtinKeys: [], plugins: [] },
      ssh: { publicKey: `ssh-ed25519 ${'A'.repeat(68)} test`, hosts: ['test-host'] },
    }, 'requester-test');
    const rejected = expect(result).rejects.toThrow('SETUP_TRANSFER_DECLINED');
    await dialogShown;
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(raw!.prepare('SELECT headers FROM custom_mcp_servers WHERE id = ?').get(valid.id))
      .toEqual({ headers: '{"Authorization":"invalid-legacy-test-only"}' });
  });

  it('propagates metadata errors rather than returning an empty consent list', async () => {
    mountDb();
    raw!.exec('DROP TABLE custom_mcp_servers');
    await expect(listCustomMcpNamesForSetup([valid.id])).rejects.toThrow();
  });
});


describe('stored MCP credentials versus transfer bounds', () => {
  it.each([
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-${i}`, 'fake-value'])),
    { 'X-Key': 'x'.repeat(4097) },
  ])('does not report a filtered stored credential as a complete copied MCP', async (headers) => {
    mountDb();
    const config = { ...valid, headers };
    expect(validateCustomMcpConfig(config)).toEqual({ ok: true });
    await createCustomMcpServer(config);
    const saved = (await listCustomMcpServers())[0];
    expect(saved.headers).toEqual(headers);
    const parsed = parseSetupSecretBundle({ mcpServers: [{ id: saved.id, url: saved.url, headers: saved.headers, token: null }], builtinKeys: [{ id: 'brave', value: 'fake-brave' }] });
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.builtinKeys).toEqual([{ id: 'brave', value: 'fake-brave' }]);
  });
});
