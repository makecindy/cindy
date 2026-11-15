import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteRuntime from '../../../localDb/betterSqliteFactory.js';
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
  it('retains only the source directory across the real Desktop Anthropic environment scrub', async () => {
    const full = await put('alternative/settings.json', {
      model: 'f10-startup-model',
      env: { ANTHROPIC_API_KEY: 'FAKE-SAVED-KEY' },
    });
    const { stripSensitiveAnthropicEnv } = await import('@cindy/maker-core');
    const { stripAnthropicEnvPreservingImportDirectory } = await import('../sourceEnvironment.js');
    const { localSourceContext } = await import('../sources.js');
    const startupEnv = {
      CLAUDE_CONFIG_DIR: dirname(full),
      ANTHROPIC_API_KEY: 'NEVER-INHERIT-KEY',
      ANTHROPIC_AUTH_TOKEN: 'NEVER-INHERIT-TOKEN',
      ANTHROPIC_BASE_URL: 'https://never-inherit.test',
      KEEP_UNRELATED: 'kept',
    };
    try {
      stripAnthropicEnvPreservingImportDirectory(stripSensitiveAnthropicEnv, startupEnv);
      expect(startupEnv).toEqual({ KEEP_UNRELATED: 'kept' });
      // Use the production context builder after scrubbing, not an injected directory.
      const retained = localSourceContext().env;
      expect(retained.CLAUDE_CONFIG_DIR).toBe(dirname(full));
      expect(retained).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(retained).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      const result = await readLocalProviderSource('claude-code', { ...context, env: retained });
      expect(result.entries[0].endpoints[0]).toMatchObject({
        apiKey: 'FAKE-SAVED-KEY',
        models: [{ id: 'f10-startup-model' }],
      });
      expect(JSON.stringify(result)).not.toContain('NEVER-INHERIT');
    } finally {
      stripAnthropicEnvPreservingImportDirectory(stripSensitiveAnthropicEnv, {});
    }
  });
  // Settings model names are wire IDs; Claude CLI aliases are resolved only
  // when this same saved file supplies an explicit family mapping.
  it.each([
    [{ model: 'f10-custom-model' }, ['f10-custom-model']],
    [{ model: 'ignored', env: { ANTHROPIC_MODEL: 'env-model' } }, ['env-model']],
    [
      { model: 'sonnet', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet' } },
      ['relay-sonnet'],
    ],
    [
      { model: 'sonnet[1m]', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet' } },
      ['relay-sonnet'],
    ],
    [
      {
        model: 'opusplan',
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'relay-opus',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet',
        },
      },
      ['relay-opus', 'relay-sonnet'],
    ],
    [{ model: 'sonnet' }, []],
    [{ model: 'default' }, []],
  ])(
    'imports static Claude model settings without sending CLI modes as wire IDs: %j',
    async (config, expected) => {
      await put('.claude/settings.json', {
        ...config,
        env: { ANTHROPIC_API_KEY: 'FAKE-F10-KEY', ...('env' in config ? config.env : {}) },
      });
      const result = await readLocalProviderSource('claude-code', context);
      expect(result.entries[0].endpoints[0].models.map((m) => m.id)).toEqual(expected);
    },
  );
  it.each([{}, { ANTHROPIC_BASE_URL: 'https://relay.test' }])(
    'explains helper-only authentication without running it or reading shell/project settings: %j',
    async (env) => {
      await put('.claude/settings.json', { apiKeyHelper: 'NEVER_EXECUTE_F10', env });
      await put('project/.claude/settings.local.json', {
        env: { ANTHROPIC_API_KEY: 'NEVER-PROJECT' },
      });
      const result = await readLocalProviderSource('claude-code', {
        ...context,
        env: { ANTHROPIC_API_KEY: 'NEVER-SHELL' },
      });
      expect(result).toEqual({ source: 'claude-code', entries: [], issue: 'unsupported' });
    },
  );
  it('imports saved authentication headers even when a helper is also configured', async () => {
    await put('.claude/settings.json', {
      apiKeyHelper: 'NEVER_EXECUTE_F10',
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.test',
        ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: FAKE-HEADER-KEY',
      },
    });
    const result = await readLocalProviderSource('claude-code', context);
    expect(result.issue).toBeUndefined();
    expect(result.entries[0].endpoints[0].headers).toEqual({ 'x-api-key': 'FAKE-HEADER-KEY' });
  });
  it('reads Codex providers/profile models and API key only for its selected provider', async () => {
    await put(
      '.codex/config.toml',
      'model_provider="one"\nmodel="alpha"\n[model_providers.one]\nbase_url="https://relay.test/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[model_providers.two]\nbase_url="https://other.test/v1"\nwire_api="chat"\n[profiles.work]\nmodel_provider="one"\nmodel="beta"',
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
  // Auth sources are independent in Codex. A relay must not adopt an official
  // key simply because both are saved locally (credentials-and-local-storage).
  // Existing env_key coverage had no OPENAI_API_KEY, so it missed this leak.
  // Unit fixtures exercise both adapters without resolving env or executing auth.
  it.each(
    (['codex', 'cc-switch'] as const).flatMap((source) =>
      [
        '',
        'requires_openai_auth=false',
        'env_key="RELAY_KEY"',
        'requires_openai_auth=true\nenv_key="RELAY_KEY"',
        'auth={command="NEVER_EXECUTE"}',
        'requires_openai_auth=true\nauth={command="NEVER_EXECUTE"}',
      ].map((auth) => ({ source, auth })),
    ),
  )('never assigns the official key to independent $source auth: $auth', async ({ source, auth }) => {
    const config =
      'model_provider="relay"\n[model_providers.relay]\nbase_url="https://relay.test/v1"\n' + auth;
    if (source === 'codex') {
      await put('.codex/config.toml', config);
      await put('.codex/auth.json', { OPENAI_API_KEY: 'FAKE-OFFICIAL-ONLY' });
    } else {
      await put('.cc-switch/config.json', {
        codex: {
          providers: {
            relay: {
              name: 'Relay',
              settingsConfig: { config, auth: { OPENAI_API_KEY: 'FAKE-OFFICIAL-ONLY' } },
            },
          },
        },
      });
    }
    const result = await readLocalProviderSource(source, context);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].endpoints[0].apiKey).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('FAKE-OFFICIAL-ONLY');
  });
  it.each(
    (['codex', 'cc-switch'] as const).flatMap((source) =>
      [undefined, 'openai'].map((selected) => ({ source, selected })),
    ),
  )(
    'still includes the official OpenAI API configuration with unused custom providers ($source, $selected)',
    async ({ source, selected }) => {
      const config =
        (selected ? `model_provider="${selected}"\n` : '') +
        'model="official-model"\n[model_providers.unused]\nbase_url="https://relay.test/v1"';
      if (source === 'codex') {
        await put('.codex/config.toml', config);
        await put('.codex/auth.json', { OPENAI_API_KEY: 'FAKE-OFFICIAL-ONLY' });
      } else {
        await put('.cc-switch/config.json', {
          codex: {
            providers: {
              official: {
                name: 'Official',
                settingsConfig: { config, auth: { OPENAI_API_KEY: 'FAKE-OFFICIAL-ONLY' } },
              },
            },
          },
        });
      }
      const result = await readLocalProviderSource(source, context);
      const prefix = source === 'codex' ? '' : 'codex/official/';
      expect(result.entries).toHaveLength(2);
      expect(result.entries.find((e) => e.ref === prefix + 'openai')?.endpoints[0]).toMatchObject({
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai-responses',
        apiKey: 'FAKE-OFFICIAL-ONLY',
        models: [{ id: 'official-model' }],
      });
      expect(result.entries.find((e) => e.ref === prefix + 'unused')?.endpoints[0].apiKey).toBeUndefined();
    },
  );
  // Protocol selection is user-visible in the import editor. An absent Codex
  // wire uses its default, but an unknown explicit wire must require user input.
  // Existing cases only exercise an explicit Responses configuration (unit tier).
  it.each([
    [undefined, 'openai-responses'],
    ['chat', 'openai-chat'],
    ['unknown-wire', undefined],
  ])('preserves Codex protocol intent for wire_api=%s', async (wire, expected) => {
    await put(
      '.codex/config.toml',
      '[model_providers.custom]\nbase_url="https://relay.test/v1"\n' +
        (wire === undefined ? '' : `wire_api="${wire}"\n`),
    );
    const result = await readLocalProviderSource('codex', context);
    expect(result.issue).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].endpoints[0].protocol).toBe(expected);
  });
  it('requires protocol selection for an explicit unknown OpenCode SDK, including known providers', async () => {
    await put('.local/share/opencode/auth.json', { openai: { type: 'api', key: 'FAKE-KEY' } });
    await put('.config/opencode/opencode.json', {
      provider: { openai: { npm: 'unknown-sdk', options: { baseURL: 'https://relay.test/v1' } } },
    });
    const result = await readLocalProviderSource('opencode', context);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].endpoints[0].protocol).toBeUndefined();
    expect(result.entries[0].endpoints[0].baseUrl).toBe('https://relay.test/v1');
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
    expect(result.entries[1].endpoints[0].headers).toBeUndefined();
    // Regression: Electron must use its selected native binding, not silently
    // fall back to the Node ABI module. Ordinary Node-only fixtures missed this.
    // A missing explicit binding must fail the source instead of reading via the
    // default binding (unit tier; real Electron ABI smoke is in acceptance evidence).
    const binding = vi
      .spyOn(sqliteRuntime, 'resolveBetterSqliteNativeBinding')
      .mockReturnValue(join(home, 'missing-native-binding.node'));
    try {
      expect(await readLocalProviderSource('alma', context)).toEqual({
        source: 'alma',
        entries: [],
        issue: 'invalid',
      });
    } finally {
      binding.mockRestore();
    }
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
