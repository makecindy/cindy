/**
 * custom-provider-store —— 校验纯函数 + localDb CRUD（per-runtime，in-memory db 注入）+ 账号隔离。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProvider,
  listCustomProviders,
  updateCustomProvider,
  validateCustomProviderConfig,
} from '../custom-provider-store.js';
import type { CustomProviderConfig } from '@cindy/model-providers';

const CREATE_SQL = `
  CREATE TABLE custom_providers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    runtimes TEXT NOT NULL DEFAULT '{}',
    auth TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_custom_providers_sort_order ON custom_providers (sort_order);
`;

const valid: CustomProviderConfig = {
  id: 'openrouter',
  name: 'OpenRouter',
  runtimes: {
    codex: { baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'meta/llama-4', name: 'Llama 4' }] },
  },
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

describe('validateCustomProviderConfig (per-runtime)', () => {
  it('accepts a valid single-runtime config', () => {
    expect(validateCustomProviderConfig(valid)).toEqual({ ok: true });
  });

  it('accepts two runtimes with independent baseUrl/models', () => {
    expect(
      validateCustomProviderConfig({
        id: 'vendor',
        name: 'Vendor',
        runtimes: {
          'claude-code': { baseUrl: 'https://v.ai/anthropic', models: [{ id: 'c', name: 'C' }] },
          codex: { baseUrl: 'https://v.ai/openai/v1', models: [{ id: 'g', name: 'G' }] },
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects bad / reserved ids', () => {
    expect(validateCustomProviderConfig({ ...valid, id: 'Bad Id' }).ok).toBe(false);
    expect(validateCustomProviderConfig({ ...valid, id: 'xd' }).ok).toBe(false);
  });

  it('rejects empty runtimes / invalid runtime key', () => {
    expect(validateCustomProviderConfig({ ...valid, runtimes: {} }).ok).toBe(false);
    expect(
      validateCustomProviderConfig({ ...valid, runtimes: { bogus: valid.runtimes.codex } }).ok,
    ).toBe(false);
  });

  it('rejects runtime with bad baseUrl / missing model fields', () => {
    expect(
      validateCustomProviderConfig({ ...valid, runtimes: { codex: { baseUrl: 'ftp://x', models: [] } } }).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...valid,
        runtimes: {
          codex: {
            baseUrl: 'https://user:secret@x/v1',
            models: [{ id: 'm', name: 'M' }],
          },
        },
      }),
    ).toEqual({
      ok: false,
      code: 'INVALID_PARAMS',
      message: "runtime 'codex' baseUrl must not contain embedded credentials",
    });
    expect(
      validateCustomProviderConfig({
        ...valid,
        runtimes: { codex: { baseUrl: 'https://x/v1', models: [{ id: '', name: 'y' }] } },
      }).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...valid,
        runtimes: {
          codex: {
            baseUrl: 'https://x/v1',
            models: [{ id: 'm', name: 'M', defaultEnabled: 'false' }],
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...valid,
        runtimes: {
          codex: {
            baseUrl: 'https://x/v1',
            models: [{ id: 'm', name: 'M', contextWindow: 0 }],
          },
        },
      }).ok,
    ).toBe(false);
  });
});

describe('custom-provider-store CRUD (per-runtime)', () => {
  it('creates, lists, gets, updates, deletes', async () => {
    mountDb();
    expect(await listCustomProviders()).toEqual([]);

    await createCustomProvider(valid);
    const list = await listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0].runtimes.codex?.baseUrl).toBe('https://openrouter.ai/api/v1');

    const got = await getCustomProvider('openrouter');
    expect(got?.name).toBe('OpenRouter');

    // 编辑：加上 claude-code runtime（独立 baseUrl/models）。
    const updated = await updateCustomProvider('openrouter', {
      ...valid,
      name: 'OR v2',
      runtimes: {
        ...valid.runtimes,
        'claude-code': { baseUrl: 'https://openrouter.ai/anthropic', models: [{ id: 'x/y', name: 'XY' }] },
      },
    });
    expect(updated?.name).toBe('OR v2');
    const after = await getCustomProvider('openrouter');
    expect(Object.keys(after?.runtimes ?? {}).sort()).toEqual(['claude-code', 'codex']);
    expect(after?.runtimes['claude-code']?.baseUrl).toBe('https://openrouter.ai/anthropic');

    await deleteCustomProvider('openrouter');
    expect(await listCustomProviders()).toEqual([]);
    expect(await getCustomProvider('openrouter')).toBeNull();
  });

  it('round-trips headers + dedupes models on normalize', async () => {
    mountDb();
    await createCustomProvider({
      ...valid,
      runtimes: {
        codex: {
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [
            { id: 'a', name: 'A', contextWindow: 1_000_000 },
            { id: 'a', name: 'A dup' },
            { id: 'hidden', name: 'Hidden', defaultEnabled: false },
          ],
          headers: { 'X-Org': 'acme' },
        },
      },
    });
    const got = await getCustomProvider('openrouter');
    expect(got?.runtimes.codex?.models).toEqual([
      { id: 'a', name: 'A', contextWindow: 1_000_000 },
      { id: 'hidden', name: 'Hidden', defaultEnabled: false },
    ]);
    expect(got?.runtimes.codex?.headers).toEqual({ 'X-Org': 'acme' });
  });

  it('round-trips an explicit Chat Completions protocol', async () => {
    mountDb();
    await createCustomProvider({
      ...valid,
      runtimes: {
        codex: {
          ...valid.runtimes.codex!,
          wireProtocol: 'openai-chat',
        },
      },
    });
    expect((await getCustomProvider('openrouter'))?.runtimes.codex?.wireProtocol).toBe('openai-chat');
  });

  it('round-trips a validated exact inference request path', async () => {
    mountDb();
    await createCustomProvider({
      ...valid,
      runtimes: {
        codex: {
          ...valid.runtimes.codex!,
          requestPath: '/tenant/acme/v2/infer?stream=1',
        },
      },
    });
    expect((await getCustomProvider('openrouter'))?.runtimes.codex?.requestPath)
      .toBe('/tenant/acme/v2/infer?stream=1');
  });

  it.each([
    '//evil.example/infer',
    '/infer#fragment',
    '/infer\r\nx: y',
    '/my path',
    '/infer\tmode',
    '/infer\u0000mode',
    '/模型',
    'responses',
  ])(
    'rejects unsafe or non-path requestPath %s',
    (requestPath) => {
      expect(validateCustomProviderConfig({
        ...valid,
        runtimes: {
          codex: { ...valid.runtimes.codex!, requestPath },
        },
      }).ok).toBe(false);
    },
  );

  it('rejects unsupported protocol/runtime combinations', () => {
    expect(validateCustomProviderConfig({
      ...valid,
      runtimes: {
        'claude-code': {
          baseUrl: 'https://v.ai/chat',
          wireProtocol: 'openai-chat',
          models: [{ id: 'm', name: 'M' }],
        },
      },
    }).ok).toBe(false);
  });

  it('update returns null when row absent', async () => {
    mountDb();
    expect(await updateCustomProvider('ghost', valid)).toBeNull();
  });

  it('isolates data per db file (account switch = new db)', async () => {
    mountDb();
    await createCustomProvider(valid);
    expect(await listCustomProviders()).toHaveLength(1);
    if (client) clearCurrentDbClient(client);
    raw?.close();
    mountDb();
    expect(await listCustomProviders()).toEqual([]);
  });
});
