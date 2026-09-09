/**
 * custom-mcp-store —— 校验纯函数 + localDb CRUD（in-memory db 注入）+ 账号隔离。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import {
  createCustomMcpServer,
  deleteCustomMcpServer,
  getCustomMcpServer,
  listCustomMcpServers,
  updateCustomMcpServer,
  validateCustomMcpConfig,
} from '../custom-mcp-store.js';
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

  it('keeps accepting ids that only resemble a builtin name', () => {
    expect(validateCustomMcpConfig({ ...valid, id: 'cindy_browser_x' }, ['cindy_browser'])).toEqual({
      ok: true,
    });
  });

  it('skips the reserved-id check when no reserved list is supplied', () => {
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
