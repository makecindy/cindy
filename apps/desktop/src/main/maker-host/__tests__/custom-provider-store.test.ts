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
  updateCustomProviderIfUnchanged,
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
    expect(validateCustomProviderConfig({ ...valid, id: 'xai' }).ok).toBe(false);
    expect(validateCustomProviderConfig({ ...valid, id: 'xai' }, { allowLegacyXai: true }).ok).toBe(
      true,
    );
    // 'cindy' 撞 pi 网关 provider id,必须保留
    expect(validateCustomProviderConfig({ ...valid, id: 'cindy' }).ok).toBe(false);
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
          pi: {
            baseUrl: 'https://x/v1',
            models: [{ id: 'm', name: 'M', supportsImageInput: 'yes' }],
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

  it('accepts a pi runtime (BYOM) with any of pi wire protocols', () => {
    for (const wp of ['anthropic-messages', 'openai-responses', 'openai-chat']) {
      expect(
        validateCustomProviderConfig({
          id: 'localpi',
          name: 'Local pi',
          auth: { method: 'none' },
          runtimes: {
            pi: { baseUrl: 'http://127.0.0.1:11434/v1', wireProtocol: wp, models: [{ id: 'm', name: 'M' }] },
          },
        }).ok,
      ).toBe(true);
    }
  });

  it('accepts only explicit, non-empty, valid Pi reasoning effort capabilities', () => {
    const config = (model: Record<string, unknown>, agent: 'pi' | 'codex' = 'pi') => ({
      id: 'reasoning-provider',
      name: 'Reasoning provider',
      runtimes: {
        [agent]: {
          baseUrl: 'https://example.com/v1',
          models: [{ id: 'reasoner', name: 'Reasoner', ...model }],
        },
      },
    });

    expect(
      validateCustomProviderConfig(
        config({
          reasoning: true,
          reasoningEfforts: ['low', 'high', 'xhigh'],
          reasoningDefaultEffort: 'high',
        }),
      ),
    ).toEqual({ ok: true });
    expect(validateCustomProviderConfig(config({ reasoning: true })).ok).toBe(false);
    expect(
      validateCustomProviderConfig(
        config({
          reasoning: true,
          reasoningEfforts: ['high', 'high'],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig(
        config({
          reasoning: true,
          reasoningEfforts: ['ultra'],
        }),
      ).ok,
    ).toBe(false);
    expect(validateCustomProviderConfig(config({ reasoningEfforts: ['high'] })).ok).toBe(false);
    expect(validateCustomProviderConfig(config({
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      reasoningDefaultEffort: 'max',
    })).ok).toBe(false);
    expect(
      validateCustomProviderConfig(
        config(
          {
            reasoning: true,
            reasoningEfforts: ['high'],
          },
          'codex',
        ),
      ).ok,
    ).toBe(false);
  });

  it('rejects an invalid wireProtocol on a pi runtime', () => {
    expect(
      validateCustomProviderConfig({
        id: 'localpi',
        name: 'Local pi',
        auth: { method: 'none' },
        runtimes: {
          pi: { baseUrl: 'http://127.0.0.1:11434/v1', wireProtocol: 'bogus-proto', models: [{ id: 'm', name: 'M' }] },
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

  it('applies discovered models only while the saved provider still matches its snapshot', async () => {
    mountDb();
    await createCustomProvider(valid, 1_000);
    const snapshot = await getCustomProvider('openrouter');
    expect(snapshot).not.toBeNull();
    const discovered = {
      ...snapshot!,
      runtimes: {
        ...snapshot!.runtimes,
        codex: {
          ...snapshot!.runtimes.codex!,
          models: [
            ...snapshot!.runtimes.codex!.models,
            { id: 'new-model', name: 'New model' },
          ],
        },
      },
    };

    expect(
      await updateCustomProviderIfUnchanged('openrouter', snapshot!, discovered, 1_000),
    ).toBe(true);
    expect((await getCustomProvider('openrouter'))?.runtimes.codex?.models).toHaveLength(2);

    await updateCustomProvider('openrouter', {
      ...valid,
      name: 'Edited in another window',
    }, 1_000);
    expect(
      await updateCustomProviderIfUnchanged('openrouter', discovered, {
        ...discovered,
        name: 'Stale discovery write',
      }, 1_000),
    ).toBe(false);
    expect((await getCustomProvider('openrouter'))?.name).toBe('Edited in another window');
  });

  it('never persists headers and still dedupes models on normalize', async () => {
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
    expect(got?.runtimes.codex?.headers).toBeUndefined();
  });

  it('round-trips only an explicitly enabled Pi image-input capability', async () => {
    mountDb();
    await createCustomProvider({
      id: 'visual-pi',
      name: 'Visual Pi',
      auth: { method: 'none' },
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            { id: 'vision', name: 'Vision', supportsImageInput: true },
            { id: 'legacy', name: 'Legacy' },
            { id: 'explicit-text', name: 'Explicit text', supportsImageInput: false },
          ],
        },
      },
    });
    expect((await getCustomProvider('visual-pi'))?.runtimes.pi?.models).toEqual([
      { id: 'vision', name: 'Vision', supportsImageInput: true },
      { id: 'legacy', name: 'Legacy' },
      { id: 'explicit-text', name: 'Explicit text' },
    ]);
  });

  it('round-trips the Pi official catalog provider id without adding it to other runtimes', async () => {
    mountDb();
    await createCustomProvider({
      id: 'official-pi',
      name: 'Official Pi',
      runtimes: {
        pi: {
          baseUrl: 'https://api.deepseek.com',
          piCatalogProviderId: 'deepseek',
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
        },
      },
    });
    expect((await getCustomProvider('official-pi'))?.runtimes.pi?.piCatalogProviderId).toBe('deepseek');
    expect(validateCustomProviderConfig({
      id: 'bad-catalog-runtime',
      name: 'Bad',
      runtimes: {
        codex: {
          baseUrl: 'https://api.example/v1',
          piCatalogProviderId: 'deepseek',
          models: [{ id: 'm', name: 'M' }],
        },
      },
    }).ok).toBe(false);
  });

  it('clears the Pi catalog marker when any write path changes saved model metadata', async () => {
    mountDb();
    const original = await createCustomProvider({
      id: 'official-pi-edited',
      name: 'Official Pi',
      runtimes: {
        pi: {
          baseUrl: 'https://api.deepseek.com',
          wireProtocol: 'openai-chat',
          piCatalogProviderId: 'deepseek',
          models: [{
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            contextWindow: 1_000_000,
            reasoning: true,
            reasoningEfforts: ['high', 'max'],
            reasoningDefaultEffort: 'high',
          }],
        },
      },
    });
    const edited: CustomProviderConfig = {
      ...original,
      runtimes: {
        ...original.runtimes,
        pi: {
          ...original.runtimes.pi!,
          models: [{
            ...original.runtimes.pi!.models[0]!,
            name: 'My DeepSeek',
            contextWindow: 64_000,
            supportsImageInput: true,
            reasoningEfforts: ['low'],
            reasoningDefaultEffort: 'low',
          }],
        },
      },
    };
    expect((await updateCustomProvider('official-pi-edited', {
      ...original,
      name: 'Renamed provider only',
    }))?.runtimes.pi?.piCatalogProviderId).toBe('deepseek');
    const defaultProtocolRoundTrip: CustomProviderConfig = {
      ...original,
      runtimes: {
        ...original.runtimes,
        pi: { ...original.runtimes.pi!, wireProtocol: undefined },
      },
    };
    expect((await updateCustomProvider('official-pi-edited', defaultProtocolRoundTrip))
      ?.runtimes.pi?.piCatalogProviderId).toBe('deepseek');
    expect((await updateCustomProvider('official-pi-edited', {
      ...defaultProtocolRoundTrip,
      runtimes: {
        ...defaultProtocolRoundTrip.runtimes,
        pi: {
          ...defaultProtocolRoundTrip.runtimes.pi!,
          wireProtocol: 'anthropic-messages',
        },
      },
    }))?.runtimes.pi).not.toHaveProperty('piCatalogProviderId');

    await updateCustomProvider('official-pi-edited', original);
    expect((await updateCustomProvider('official-pi-edited', edited))?.runtimes.pi)
      .not.toHaveProperty('piCatalogProviderId');

    const second = await createCustomProvider({
      ...original,
      id: 'official-pi-discovered',
    });
    expect(await updateCustomProviderIfUnchanged(
      second.id,
      second,
      {
        ...second,
        runtimes: {
          ...second.runtimes,
          pi: {
            ...second.runtimes.pi!,
            models: [
              ...second.runtimes.pi!.models,
              { id: 'new-from-models-url', name: 'New model' },
            ],
          },
        },
      },
    )).toBe(true);
    expect((await getCustomProvider(second.id))?.runtimes.pi?.piCatalogProviderId)
      .toBe('deepseek');

    const replaced = await createCustomProvider({
      ...original,
      id: 'official-pi-replaced',
    });
    expect((await updateCustomProvider(replaced.id, {
      ...replaced,
      runtimes: {
        ...replaced.runtimes,
        pi: {
          ...replaced.runtimes.pi!,
          models: [{
            id: 'deepseek-v4-flash',
            name: 'My Flash Model',
            contextWindow: 64_000,
            supportsImageInput: true,
            reasoning: true,
            reasoningEfforts: ['low'],
            reasoningDefaultEffort: 'low',
          }],
        },
      },
    }))?.runtimes.pi).not.toHaveProperty('piCatalogProviderId');
    expect((await getCustomProvider(replaced.id))?.runtimes.pi).toMatchObject({
      models: [{
        id: 'deepseek-v4-flash',
        name: 'My Flash Model',
        contextWindow: 64_000,
        supportsImageInput: true,
        reasoning: true,
        reasoningEfforts: ['low'],
        reasoningDefaultEffort: 'low',
      }],
    });

    const deleted = await createCustomProvider({
      ...original,
      id: 'official-pi-deleted',
    });
    expect((await updateCustomProvider(deleted.id, {
      ...deleted,
      runtimes: {
        ...deleted.runtimes,
        pi: { ...deleted.runtimes.pi!, models: [] },
      },
    }))?.runtimes.pi).not.toHaveProperty('piCatalogProviderId');
    const deletedSnapshot = await getCustomProvider(deleted.id);
    expect((await updateCustomProvider(deleted.id, {
      ...deletedSnapshot!,
      runtimes: {
        ...deletedSnapshot!.runtimes,
        pi: {
          ...deletedSnapshot!.runtimes.pi!,
          models: deleted.runtimes.pi!.models,
        },
      },
    }))?.runtimes.pi).not.toHaveProperty('piCatalogProviderId');

    const duplicate = await createCustomProvider({
      ...original,
      id: 'official-pi-duplicate',
    });
    expect((await updateCustomProvider(duplicate.id, {
      ...duplicate,
      runtimes: {
        ...duplicate.runtimes,
        pi: {
          ...duplicate.runtimes.pi!,
          models: [
            { ...duplicate.runtimes.pi!.models[0]!, name: 'Edited first duplicate' },
            duplicate.runtimes.pi!.models[0]!,
          ],
        },
      },
    }))?.runtimes.pi).not.toHaveProperty('piCatalogProviderId');
  });

  it('round-trips only an explicitly enabled Pi reasoning capability', async () => {
    mountDb();
    await createCustomProvider({
      id: 'reasoning-pi',
      name: 'Reasoning Pi',
      auth: { method: 'none' },
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            {
              id: 'reasoner',
              name: 'Reasoner',
              reasoning: true,
              reasoningEfforts: ['low', 'high', 'xhigh'],
              reasoningDefaultEffort: 'xhigh',
            },
            { id: 'legacy', name: 'Legacy' },
            { id: 'explicit-off', name: 'Explicit off', reasoning: false },
          ],
        },
      },
    });
    expect((await getCustomProvider('reasoning-pi'))?.runtimes.pi?.models).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['low', 'high', 'xhigh'],
        reasoningDefaultEffort: 'xhigh',
      },
      { id: 'legacy', name: 'Legacy' },
      { id: 'explicit-off', name: 'Explicit off' },
    ]);
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

  it('round-trips an explicit Anthropic Messages protocol for Codex', async () => {
    mountDb();
    await createCustomProvider({
      ...valid,
      runtimes: {
        codex: {
          ...valid.runtimes.codex!,
          baseUrl: 'https://api.anthropic.com',
          wireProtocol: 'anthropic-messages',
        },
      },
    });
    expect((await getCustomProvider('openrouter'))?.runtimes.codex?.wireProtocol).toBe('anthropic-messages');
  });

  it('preserves legacy remote auth:none records for repair without deleting them', async () => {
    mountDb();
    raw!.prepare(
      `INSERT INTO custom_providers
        (id, name, runtimes, auth, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, 1)`,
    ).run(
      'legacy-no-auth',
      'Legacy no auth',
      JSON.stringify({
        codex: {
          baseUrl: 'https://remote.example/v1',
          models: [{ id: 'm', name: 'M' }],
        },
      }),
      JSON.stringify({ method: 'none' }),
    );

    const [loaded] = await listCustomProviders();
    expect(loaded.id).toBe('legacy-no-auth');
    expect(loaded.auth).toEqual({ method: 'none' });
    expect(loaded.runtimes.codex?.baseUrl).toBe('https://remote.example/v1');
    expect(raw!.prepare('SELECT auth FROM custom_providers WHERE id = ?').get('legacy-no-auth'))
      .toEqual({ auth: JSON.stringify({ method: 'none' }) });
  });

  it('keeps legacy loopback auth:none records enabled when loading', async () => {
    mountDb();
    raw!.prepare(
      `INSERT INTO custom_providers
        (id, name, runtimes, auth, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, 1)`,
    ).run(
      'legacy-loopback',
      'Legacy loopback',
      JSON.stringify({
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          models: [{ id: 'm', name: 'M' }],
        },
      }),
      JSON.stringify({ method: 'none' }),
    );

    expect((await getCustomProvider('legacy-loopback'))?.auth).toEqual({ method: 'none' });
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

  it('strips requestPath from Pi native runtime records', async () => {
    mountDb();
    await createCustomProvider({
      ...valid,
      runtimes: {
        pi: {
          ...valid.runtimes.codex!,
          requestPath: '/ignored-by-pi',
        },
      },
    });

    expect((await getCustomProvider('openrouter'))?.runtimes.pi?.requestPath).toBeUndefined();
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
