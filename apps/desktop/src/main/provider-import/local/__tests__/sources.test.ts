import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { readLocalProviderSource, staticJson, type LocalSourceContext } from '../sources.js';

let home: string;
let context: LocalSourceContext;
async function put(path: string, data: string | object) {
  const full = join(home, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, typeof data === 'string' ? data : JSON.stringify(data));
  return full;
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cindy-local-api-fixture-'));
  context = { home, platform: 'linux', env: {} };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('saved API sources (isolated fake credentials only)', () => {
  it('keeps strings intact in JSONC and rejects truncated comments', () => {
    expect(staticJson('{"url":"https://relay.test/a,}", /* x */ "a":[1, /* y */],}')).toEqual({
      url: 'https://relay.test/a,}',
      a: [1],
    });
    expect(() => staticJson('{"a":1 /*')).toThrow();
  });
  it('reads Claude bearer settings without confusing them with x-api-key or running helpers', async () => {
    await put('.claude/settings.json', {
      apiKeyHelper: 'NEVER_EXECUTE',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.xiaobaige.xyz/path',
        ANTHROPIC_AUTH_TOKEN: 'FAKE-BEARER',
        ANTHROPIC_API_KEY: 'IGNORED',
        ANTHROPIC_MODEL: 'model-one',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: FAKE-TENANT',
      },
    });
    const result = await readLocalProviderSource('claude-code', context);
    expect(result.entries[0].endpoints).toEqual([
      {
        agent: 'claude-code',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.xiaobaige.xyz/path',
        headers: { Authorization: 'Bearer FAKE-BEARER', 'X-Tenant': 'FAKE-TENANT' },
        models: [{ id: 'model-one', name: 'model-one' }],
      },
    ]);
  });
  it('honors explicit source home overrides without reading real HOME', async () => {
    const full = await put('alternative/settings.json', { env: { ANTHROPIC_API_KEY: 'FAKE-KEY' } });
    const result = await readLocalProviderSource('claude-code', {
      ...context,
      env: { CLAUDE_CONFIG_DIR: dirname(full) },
    });
    expect(result.entries[0].endpoints[0].apiKey).toBe('FAKE-KEY');
  });
  it('reads Codex providers/profile models and API key only for its selected provider', async () => {
    await put(
      '.codex/config.toml',
      'model_provider="one"\nmodel="alpha"\n[model_providers.one]\nbase_url="https://relay.test/v1"\nwire_api="responses"\n[model_providers.two]\nbase_url="https://other.test/v1"\nwire_api="chat"\n[profiles.work]\nmodel_provider="one"\nmodel="beta"',
    );
    await put('.codex/auth.json', {
      OPENAI_API_KEY: 'FAKE-API',
      tokens: { access_token: 'NEVER-IMPORT-OAUTH' },
    });
    const result = await readLocalProviderSource('codex', context);
    expect(result.entries[0].endpoints[0]).toMatchObject({
      apiKey: 'FAKE-API',
      protocol: 'openai-responses',
      models: [{ id: 'alpha' }, { id: 'beta' }],
    });
    expect(result.entries[1].endpoints[0].apiKey).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('NEVER-IMPORT-OAUTH');
  });
  it('does not resolve env_key or import subscription credentials', async () => {
    await put(
      '.codex/config.toml',
      '[model_providers.custom]\nbase_url="https://relay.test/v1"\nenv_key="SECRET_VAR"',
    );
    await put('.codex/auth.json', { tokens: { access_token: 'NEVER-OAUTH' } });
    const result = await readLocalProviderSource('codex', {
      ...context,
      env: { SECRET_VAR: 'DO-NOT-RESOLVE' },
    });
    expect(result.entries[0].endpoints[0].apiKey).toBeUndefined();
  });
  it('reads bounded external Codex model catalogs without changing upstream IDs', async () => {
    await put(
      '.codex/config.toml',
      'model_provider="one"\nmodel_catalog_json="models.json"\n[model_providers.one]\nbase_url="https://relay.test/v1"\nexperimental_bearer_token="FAKE-KEY"',
    );
    await put('.codex/models.json', { models: [{ slug: 'vendor/model', contextWindow: 12345 }] });
    const result = await readLocalProviderSource('codex', context);
    expect(result.entries[0].endpoints[0].models).toEqual([
      { id: 'vendor/model', name: 'vendor/model', contextWindow: 12345 },
    ]);
  });
  it('OpenCode only retains API records and resolves custom endpoints from static config', async () => {
    await put('.local/share/opencode/auth.json', {
      custom: { type: 'api', key: 'FAKE-KEY' },
      sub: { type: 'oauth', access: 'NEVER-OAUTH', refresh: 'NEVER-REFRESH' },
    });
    await put(
      '.config/opencode/opencode.jsonc',
      '{"provider":{"custom":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://relay.test/custom"},"models":{"vendor/m":{"name":"M","limit":{"context":9000}}}}},}',
    );
    const result = await readLocalProviderSource('opencode', context);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].endpoints[0]).toMatchObject({
      protocol: 'openai-chat',
      baseUrl: 'https://relay.test/custom',
      models: [{ id: 'vendor/m', name: 'M', contextWindow: 9000 }],
    });
    expect(JSON.stringify(result)).not.toContain('NEVER');
  });
  it('does not guess an unknown OpenCode provider endpoint or execute env substitutions', async () => {
    await put('.local/share/opencode/auth.json', { unknown: { type: 'api', key: 'FAKE' } });
    await put('.config/opencode/opencode.json', {
      provider: {
        second: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://relay.test', apiKey: '{env:SECRET}' },
        },
      },
    });
    const result = await readLocalProviderSource('opencode', context);
    expect(result.entries[0].endpoints[0].baseUrl).toBe('');
    expect(result.entries[1].endpoints[0].apiKey).toBeUndefined();
  });
  it('reads CC Switch legacy configs without folding different accounts together', async () => {
    await put('.cc-switch/config.json', {
      claude: {
        providers: {
          a: {
            name: 'A',
            settingsConfig: {
              env: { ANTHROPIC_BASE_URL: 'https://relay.test', ANTHROPIC_API_KEY: 'FAKE-A' },
            },
          },
          b: {
            name: 'B',
            settingsConfig: {
              env: { ANTHROPIC_BASE_URL: 'https://relay.test', ANTHROPIC_API_KEY: 'FAKE-B' },
            },
          },
        },
      },
    });
    const result = await readLocalProviderSource('cc-switch', context);
    expect(result.entries.map((e) => e.ref)).toEqual(['claude/a', 'claude/b']);
    expect(result.entries.map((e) => e.endpoints[0].apiKey)).toEqual(['FAKE-A', 'FAKE-B']);
  });
  it('CC Switch reads committed WAL rows while the writer remains open', async () => {
    const path = await put('.cc-switch/cc-switch.db', '');
    const db = new Database(path);
    try {
      db.pragma('journal_mode=WAL');
      db.exec('CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT)');
      db.prepare('INSERT INTO providers VALUES (?,?,?,?)').run(
        'one',
        'claude',
        'Relay',
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'FAKE-WAL' } }),
      );
      const result = await readLocalProviderSource('cc-switch', context);
      expect(result.entries[0].endpoints[0].apiKey).toBe('FAKE-WAL');
      expect(db.prepare('SELECT count(*) AS n FROM providers').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
  it('keeps Gemini relay prefixes and adds the CLI API version exactly once', async () => {
    await put('.cc-switch/config.json', {
      gemini: {
        providers: {
          root: {
            name: 'Root',
            settingsConfig: {
              env: {
                GOOGLE_GEMINI_BASE_URL: 'https://relay.test/google/',
                GEMINI_API_KEY: 'FAKE-GEMINI',
              },
            },
          },
          version: {
            name: 'Version',
            settingsConfig: {
              env: {
                GOOGLE_GEMINI_BASE_URL: 'https://relay.test/google/v1beta',
                GEMINI_API_KEY: 'FAKE-GEMINI',
              },
            },
          },
        },
      },
    });
    const result = await readLocalProviderSource('cc-switch', context);
    expect(result.entries.map((e) => e.endpoints[0].baseUrl)).toEqual([
      'https://relay.test/google/v1beta',
      'https://relay.test/google/v1beta',
    ]);
  });
  it('reads Alma Chat/Responses distinction and custom headers from its database', async () => {
    const path = await put('.config/alma/chat_threads.db', '');
    const db = new Database(path);
    db.exec(
      'CREATE TABLE providers(id TEXT,name TEXT,type TEXT,api_key TEXT,models TEXT,base_url TEXT,enabled INTEGER,api_format TEXT,is_response_api INTEGER,custom_headers TEXT)',
    );
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'one',
      'Alma relay',
      'openai',
      'FAKE-ALMA',
      '["upstream/model"]',
      'https://relay.test/v1',
      1,
      '',
      0,
      '{"X-Tenant":"FAKE-TENANT"}',
    );
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'two',
      'Alma Responses',
      'openai',
      'FAKE-SECOND',
      '[]',
      'https://relay.test/responses',
      0,
      'openai',
      1,
      '{}',
    );
    db.close();
    const result = await readLocalProviderSource('alma', context);
    expect(result.entries[0].endpoints[0]).toMatchObject({
      protocol: 'openai-chat',
      headers: { 'X-Tenant': 'FAKE-TENANT' },
    });
    expect(result.entries[1]).toMatchObject({
      disabled: true,
      endpoints: [{ protocol: 'openai-responses' }],
    });
  });
  it('distinguishes missing, corrupted and oversized sources with no parser content leakage', async () => {
    expect((await readLocalProviderSource('claude-code', context)).issue).toBe('missing');
    await put('.claude/settings.json', []);
    expect((await readLocalProviderSource('claude-code', context)).issue).toBe('invalid');
    await put('.claude/settings.json', '{"FAKE-SECRET":');
    expect(await readLocalProviderSource('claude-code', context)).toEqual({
      source: 'claude-code',
      entries: [],
      issue: 'invalid',
    });
    await put('.claude/settings.json', ' '.repeat(4 * 1024 * 1024 + 1));
    expect((await readLocalProviderSource('claude-code', context)).issue).toBe('limit');
  });
});
