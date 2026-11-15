import { describe, expect, it, vi } from 'vitest';

import { parseSetupSnapshot, serializedSetupSnapshotBytes } from '@cindy/device-link';

import {
  collectSetupSnapshot,
  fitSetupSnapshotBudget,
  projectPlugins,
  type SetupSnapshotSourceDeps,
  type SourceMcpFact,
} from '../snapshot.js';
import { buildSetupPlan } from '../plan.js';
import { installFacts, planInputs, snapshot } from './fixtures.js';

function deps(overrides: Partial<SetupSnapshotSourceDeps> = {}): SetupSnapshotSourceDeps {
  return {
    platform: 'darwin',
    now: () => 42,
    settingsGroups: [
      {
        id: 'collaboration',
        settings: { readCustomized: () => ({ workerSoftLimit: 3 }), applyPatch: vi.fn() },
      },
      { id: 'goal', settings: { readCustomized: () => ({}), applyPatch: vi.fn() } },
      { id: 'menubar', platforms: ['darwin'], settings: { readCustomized: () => ({ enabled: true }), applyPatch: vi.fn() } },
      { id: 'winOnly', platforms: ['win32'], settings: { readCustomized: () => ({ x: 1 }), applyPatch: vi.fn() } },
    ],
    readRendererPrefs: async () => ({ theme: 'dark' }),
    readPlugins: async () => ({ ghosts: [], market: [] }),
    pluginSetupReady: () => null,
    readMarketSources: async () => [],
    readSkills: async () => [],
    readMcpServers: async () => [],
    readProviders: async () => [],
    isUserProvider: () => true,
    readBuiltinToolOverrides: async () => [],
    readAccess: () => ({ remoteControlEnabled: true, remoteDesktopEnabled: false, keepAwake: true }),
    readHints: async () => ({ builtinKeys: ['brave'], imChannels: [], sshHostCount: 1 }),
    readSshHosts: async () => [],
    ...overrides,
  };
}

describe('collectSetupSnapshot', () => {
  it('exports changed settings for this platform and parses on the other side', async () => {
    const result = await collectSetupSnapshot(deps());
    expect(result.settings).toEqual([
      { id: 'collaboration', values: { workerSoftLimit: 3 } },
      { id: 'menubar', values: { enabled: true } },
    ]);
    expect(parseSetupSnapshot(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('marks a failing section unavailable without failing the snapshot', async () => {
    const result = await collectSetupSnapshot(
      deps({
        readSkills: async () => {
          throw new Error('scan failed');
        },
        readRendererPrefs: async () => null,
      }),
    );
    expect(result.skills).toEqual([]);
    expect(result.unavailable.sort()).toEqual(['rendererPrefs', 'skills']);
    expect(result.access.remoteControlEnabled).toBe(true);
  });

  it('never exports provider runtime headers, organization providers or tokens', async () => {
    const result = await collectSetupSnapshot(
      deps({
        readProviders: async () => [
          {
            id: 'openrouter',
            name: 'OpenRouter',
            runtimes: { codex: { baseUrl: 'https://openrouter.ai/api/v1', headers: { Authorization: 'Bearer secret' }, headersState: 'configured', models: [] } },
          },
          { id: 'byok_org', name: 'Org', runtimes: {} },
        ],
        isUserProvider: (id) => id !== 'byok_org',
        readMcpServers: async (): Promise<SourceMcpFact[]> => [
          { id: 'docs', name: 'Docs', transport: 'http', url: 'https://mcp.example.com', headers: {}, hasToken: true },
          { id: 'keyed', name: 'Keyed', transport: 'http', url: 'https://mcp.example.com/k', headers: { Authorization: 'Bearer secret' }, hasToken: false },
          { id: 'userinfo', name: 'U', transport: 'sse', url: 'https://me:secret@mcp.example.com/sse?api_key=secret#secret', headers: {}, hasToken: false },
          { id: 'plain', name: 'Plain', transport: 'http', url: 'https://mcp.example.com/p', headers: {}, hasToken: false },
        ],
      }),
    );
    expect(result.providers).toEqual([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        auth: 'apiKey',
        config: { id: 'openrouter', name: 'OpenRouter', runtimes: { codex: { baseUrl: 'https://openrouter.ai/api/v1', models: [] } } },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.mcpServers[0]).not.toHaveProperty('token');
    // Credentials in headers or the URL are dropped and listed to be entered again.
    expect(result.mcpServers.map(({ id, url, headers, hasToken }) => ({ id, url, headers, hasToken }))).toEqual([
      { id: 'docs', url: 'https://mcp.example.com', headers: {}, hasToken: true },
      { id: 'keyed', url: 'https://mcp.example.com/k', headers: {}, hasToken: true },
      { id: 'userinfo', url: 'https://mcp.example.com/sse', headers: {}, hasToken: true },
      { id: 'plain', url: 'https://mcp.example.com/p', headers: {}, hasToken: false },
    ]);
  });

  it('drops credentials carried in custom provider addresses and marks them to be entered again', async () => {
    // Review repro (PR #6473): a query-string key in modelsUrl survived collect → JSON → parse.
    const key = 'TEST_ONLY_NOT_A_REAL_KEY_6473';
    const result = await collectSetupSnapshot(
      deps({
        readProviders: async () => [
          {
            id: 'review6473',
            name: 'Review fixture',
            auth: { method: 'apiKey' },
            runtimes: {
              codex: {
                baseUrl: `https://me:${key}@api.example.com/v1`,
                wireProtocol: 'openai-responses',
                modelsUrl: `https://api.example.com/v1/models?api_key=${key}`,
                requestPath: `/responses?key=${key}`,
                models: [{ id: 'm', name: 'M', route: { baseUrl: `https://alt.example.com/v1#${key}`, wireProtocol: 'openai-chat' } }],
              },
            },
          },
          { id: 'clean', name: 'Clean', runtimes: { codex: { baseUrl: 'https://api.example.com/v1', models: [] } } },
        ],
      }),
    );
    const received = parseSetupSnapshot(JSON.parse(JSON.stringify(result)))!;
    expect(JSON.stringify(received)).not.toContain(key);
    expect(received.providers.map((provider) => [provider.id, provider.urlSecretsRemoved ?? false])).toEqual([
      ['review6473', true],
      ['clean', false],
    ]);
    expect(received.providers[0]!.config).toMatchObject({
      runtimes: {
        codex: {
          baseUrl: 'https://api.example.com/v1',
          modelsUrl: 'https://api.example.com/v1/models',
          requestPath: '/responses',
          models: [{ id: 'm', route: { baseUrl: 'https://alt.example.com/v1' } }],
        },
      },
    });
  });

  it('exports only credential-free Git marketplaces', async () => {
    const result = await collectSetupSnapshot(
      deps({
        readMarketSources: async () => [
          { name: 'acme', source: { type: 'git', url: 'https://github.com/acme/m.git', sparsePaths: [] } },
          { name: 'token', source: { type: 'git', url: 'https://ghp_x@github.com/acme/m.git', sparsePaths: [] } },
          { name: 'folder', source: { type: 'local', path: '/Users/me/market' } },
        ],
      }),
    );
    expect(result.marketSources.map((source) => source.name)).toEqual(['acme']);
  });
});

describe('projectPlugins', () => {
  it('names each install by how it can be rebuilt elsewhere', () => {
    const ghost = (ghostId: string, extra: Partial<{ namespace: string | null | undefined; builtin: boolean; enabled: boolean }> = {}) => ({
      ghostId,
      name: ghostId,
      version: '1.0.0',
      namespace: null as string | null | undefined,
      instanceKey: `_root__${ghostId}`,
      enabled: true,
      builtin: false,
      ...extra,
    });
    const result = projectPlugins(
      {
        ghosts: [
          ghost('market-one'),
          ghost('default-one'),
          ghost('custom-one'),
          ghost('folder-one'),
          ghost('manual-one', { enabled: false }),
          ghost('cindy-github', { builtin: true }),
          ghost('org-one', { namespace: 'xd' }),
        ],
        market: [
          { pluginId: 'p1', ghostId: 'market-one', namespace: null, installed: true, sourceType: 'server', sourceMarketName: null, defaultInstall: false },
          { pluginId: 'p2', ghostId: 'default-one', namespace: null, installed: true, sourceType: 'server', sourceMarketName: null, defaultInstall: true },
          { pluginId: 'custom:acme/custom-one', ghostId: 'custom-one', installed: true, sourceType: 'git-market', sourceMarketName: 'acme', defaultInstall: false },
          { pluginId: 'custom:local/folder-one', ghostId: 'folder-one', installed: true, sourceType: 'local-market', sourceMarketName: 'local', defaultInstall: false },
          { pluginId: 'p-org', ghostId: 'org-one', namespace: 'xd', installed: true, sourceType: 'server', sourceMarketName: null, defaultInstall: false },
          // A root install of the same id must not claim the organization instance.
          { pluginId: 'p-root', ghostId: 'org-one', namespace: null, installed: true, sourceType: 'server', sourceMarketName: null, defaultInstall: false },
        ],
      },
      (key) => key === '_root__market-one',
      (key) => key === '_root__custom-one',
    );
    expect(result.map((p) => [p.ghostId, p.source, p.pluginId, p.setupReady])).toEqual([
      ['market-one', 'market', 'p1', true],
      ['default-one', 'default-install', 'p2', false],
      ['custom-one', 'custom-market', 'custom:acme/custom-one', false],
      ['folder-one', 'manual', null, false],
      ['manual-one', 'manual', null, false],
      ['cindy-github', 'builtin', null, false],
      ['org-one', 'market', 'p-org', false],
    ]);
    expect(result.find((p) => p.ghostId === 'manual-one')?.enabled).toBe(false);
    expect(result.filter((p) => p.hasUserSecrets).map((p) => p.ghostId)).toEqual(['custom-one']);
  });
});

describe('plugins when the official catalog was not read', () => {
  // unit：服务端缺新接口时 snapshot 只剩自定义市场项，官方市场插件曾被误标为「只在那台电脑上，手动搬」。
  it('keeps official installs from the install record, leaves real manual installs local-only and reports partial', async () => {
    const ghost = (ghostId: string) => ({
      ghostId, name: ghostId, version: '1.0.0', namespace: null, instanceKey: `_root__${ghostId}`, enabled: true, builtin: false,
    });
    const result = await collectSetupSnapshot(
      deps({
        readPlugins: async () => ({
          // A same-id `local` development copy sits beside the official install.
          ghosts: [ghost('google-gmail'), { ...ghost('google-gmail'), namespace: 'local', instanceKey: 'local__google-gmail' },
            ghost('hand-made')],
          market: [],
          catalogUnavailable: true,
          // A pre-namespace install record carries no namespace.
          installedServerRecords: [{ pluginId: 'plg_gmail', ghostId: 'google-gmail' }],
        }),
      }),
    );
    expect(result.unavailable).toEqual(['plugins']);
    expect(result.plugins.map((p) => [p.ghostId, p.namespace, p.source, p.pluginId])).toEqual([
      ['google-gmail', null, 'market', 'plg_gmail'],
      ['google-gmail', 'local', 'manual', null],
      ['hand-made', null, 'manual', null],
    ]);
    const plan = buildSetupPlan(planInputs({
      snapshot: result,
      catalog: new Map([['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r1', version: '1.0.0', consent: installFacts('google-gmail') }]]),
    }));
    expect(plan.plugins.map((item) => [item.ghostId, item.state, item.reason ?? null])).toEqual([
      ['google-gmail', 'ready', null],
      ['google-gmail', 'unavailable', 'local-only'],
      ['hand-made', 'unavailable', 'local-only'],
    ]);
    expect(plan.unavailable).toEqual(['plugins']);
  });

  it('ignores install records when the catalog was read', async () => {
    const result = await collectSetupSnapshot(deps({
      readPlugins: async () => ({
        ghosts: [{ ghostId: 'x', name: 'x', version: '1', namespace: null, instanceKey: '_root__x', enabled: true, builtin: false }],
        market: [],
        installedServerRecords: [{ pluginId: 'plg_x', ghostId: 'x', namespace: null }],
      }),
    }));
    expect(result.unavailable).toEqual([]);
    expect(result.plugins[0]).toMatchObject({ source: 'manual', pluginId: null });
  });
});

describe('fitSetupSnapshotBudget', () => {
  it('drops optional sections, largest-risk first, until the reply fits one frame', () => {
    const big = snapshot({
      rendererPrefs: { theme: 'x'.repeat(400) },
      providers: [{ id: 'p', name: 'p', auth: 'apiKey', config: { id: 'p', blob: 'y'.repeat(400) } }],
    });
    const unavailable = new Set<'rendererPrefs' | 'providers'>();
    const limit = serializedSetupSnapshotBytes(big) - 300;
    const fitted = fitSetupSnapshotBudget(big, unavailable as Set<never>, limit);
    expect(fitted.rendererPrefs).toBeNull();
    expect(fitted.providers).toHaveLength(1);
    expect(fitted.unavailable).toEqual(['rendererPrefs']);
    expect(() => fitSetupSnapshotBudget(big, new Set(), 10)).toThrow('SETUP_SNAPSHOT_TOO_LARGE');
  });
});


describe('MCP credential kind projection', () => {
  it('keeps the legacy bit while projecting only non-secret kind facts', async () => {
    const facts: SourceMcpFact[] = [
      { id: 'bearer', name: 'Bearer', transport: 'http', url: 'https://example.test/mcp', headers: {}, hasToken: true },
      { id: 'headers', name: 'Headers', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'fake-secret' }, hasToken: false },
      { id: 'url', name: 'URL', transport: 'http', url: 'https://example.test/mcp?key=fake-secret', headers: {}, hasToken: false },
      { id: 'both', name: 'Both', transport: 'http', url: 'https://example.test/mcp', headers: { 'X-Key': 'fake-secret' }, hasToken: true },
    ];
    const result = await collectSetupSnapshot(deps({ readMcpServers: async () => facts }));
    expect(result.mcpServers.map((server) => [server.id, server.hasToken, server.credentialKinds])).toEqual([
      ['bearer', true, { bearer: true, headers: false, url: false }],
      ['headers', true, { bearer: false, headers: true, url: false }],
      ['url', true, { bearer: false, headers: false, url: true }],
      ['both', true, { bearer: true, headers: true, url: false }],
    ]);
    expect(JSON.stringify(result.mcpServers)).not.toContain('fake-secret');
    expect(parseSetupSnapshot(JSON.parse(JSON.stringify(result))).mcpServers).toEqual(result.mcpServers);
  });
});
