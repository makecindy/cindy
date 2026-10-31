import { describe, expect, it } from 'vitest';

import { buildSetupPlan, isLocalProvider, splitSettingsValues } from '../plan.js';
import { installFacts, planInputs, plugin, snapshot } from './fixtures.js';

describe('buildSetupPlan', () => {
  it('installs market plugins this computer offers and asks for their permissions once', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          plugins: [
            plugin({ ghostId: 'gmail', setupReady: true }),
            plugin({ ghostId: 'gone' }),
            plugin({ ghostId: 'local-tool', pluginId: null, source: 'manual' }),
            plugin({ ghostId: 'cindy-github', pluginId: null, source: 'builtin', enabled: true }),
          ],
        }),
        ghosts: [{ ghostId: 'cindy-github', namespace: null, instanceKey: '_root__cindy-github', enabled: true, builtin: true }],
        catalog: new Map([
          ['plg_gmail', { pluginId: 'plg_gmail', releaseId: 'r2', version: '2.0.0', consent: installFacts('gmail') }],
        ]),
      }),
    );
    expect(plan.plugins.map((item) => [item.ghostId, item.state, item.reason ?? null])).toEqual([
      ['gmail', 'ready', null],
      ['gone', 'unavailable', 'not-in-catalog'],
      ['local-tool', 'unavailable', 'local-only'],
      ['cindy-github', 'present', null],
    ]);
    const gmail = plan.plugins[0];
    expect(gmail.consent?.ghostId).toBe('gmail');
    // The version this computer will install, not the source's.
    expect(gmail.version).toBe('2.0.0');
    expect(plan.checklist.map((item) => item.kind)).toContain('plugin-manual');
  });

  it('copies an on/off difference for a plugin that is already installed here', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({ plugins: [plugin({ ghostId: 'x', enabled: false })] }),
        ghosts: [{ ghostId: 'x', namespace: null, instanceKey: '_root__x', enabled: true, builtin: false }],
      }),
    );
    expect(plan.plugins[0]).toMatchObject({ state: 'ready', consent: null, enabledOnSource: false });
  });

  it('keeps root and organization installs with the same id apart', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({ plugins: [plugin({ ghostId: 'mivo', namespace: 'xd', pluginId: 'plg_org' })] }),
        ghosts: [{ ghostId: 'mivo', namespace: null, instanceKey: '_root__mivo', enabled: true, builtin: false }],
        catalog: new Map([['plg_org', { pluginId: 'plg_org', releaseId: 'r', version: '1.0.0', consent: installFacts('mivo') }]]),
      }),
    );
    expect(plan.plugins[0]).toMatchObject({ key: 'plugin:xd:mivo', state: 'ready' });
  });

  it('compares on/off with the copy in the source namespace when this computer has several', () => {
    // Root and organization copies of one plugin can coexist (#6878). The copy in the source
    // namespace is the same plugin: copy its on/off state, never install yet another copy.
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({ plugins: [plugin({ ghostId: 'mivo', namespace: 'xd', enabled: false })] }),
        ghosts: [
          { ghostId: 'mivo', namespace: null, instanceKey: '_root__mivo', enabled: false, builtin: false },
          { ghostId: 'mivo', namespace: 'xd', instanceKey: 'xd__mivo', enabled: true, builtin: false },
        ],
      }),
    );
    expect(plan.plugins[0]).toMatchObject({ key: 'plugin:xd:mivo', state: 'ready', consent: null, enabledOnSource: false });
  });

  it('installs custom-market plugins only when their marketplace is portable or already here', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          plugins: [
            plugin({ ghostId: 'a', source: 'custom-market', marketName: 'acme', pluginId: 'custom:acme/a' }),
            plugin({ ghostId: 'b', source: 'custom-market', marketName: 'private', pluginId: 'custom:private/b' }),
          ],
          marketSources: [{ name: 'acme', url: 'https://github.com/acme/market.git', ref: null, sparsePaths: [] }],
        }),
      }),
    );
    expect(plan.plugins.map((item) => [item.ghostId, item.state, item.consent])).toEqual([
      ['a', 'ready', null],
      ['b', 'unavailable', null],
    ]);
    expect(plan.checklist.find((item) => item.kind === 'market-source')?.label).toBe('private');
  });

  it('never overwrites settings the user already changed on this computer', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          settings: [
            { id: 'collaboration', values: { workerSoftLimit: 3, workerHardLimit: 6 } },
            { id: 'gitSafety', values: { mode: 'all-projects' } },
            { id: 'menubar', values: { enabled: true } },
            { id: 'unknownToThisVersion', values: { x: 1 } },
          ],
        }),
        platform: 'win32',
        settings: [
          { id: 'collaboration', customized: { workerSoftLimit: 4 } },
          { id: 'gitSafety', customized: { mode: 'all-projects' } },
          { id: 'menubar', platforms: ['darwin'], customized: {} },
        ],
      }),
    );
    expect(plan.settings).toEqual([
      { key: 'settings:collaboration', id: 'collaboration', changeCount: 1, keptCount: 1, state: 'ready' },
      { key: 'settings:gitSafety', id: 'gitSafety', changeCount: 0, keptCount: 0, state: 'present' },
    ]);
  });

  it('copies providers and MCP without credentials and lists what must be entered again', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          providers: [
            { id: 'openrouter', name: 'OpenRouter', auth: 'apiKey', config: { id: 'openrouter', runtimes: { codex: { baseUrl: 'https://openrouter.ai/api/v1' } } } },
            { id: 'ollama', name: 'My Ollama', auth: 'none', config: { id: 'ollama', runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1' } } } },
            { id: 'existing', name: 'Existing', auth: 'oauth', config: { id: 'existing', runtimes: {} } },
            // The source dropped a query-string key from its address; the address is entered again.
            { id: 'gateway', name: 'Gateway', auth: 'none', urlSecretsRemoved: true, config: { id: 'gateway', runtimes: { codex: { baseUrl: 'https://gw.example.com/v1' } } } },
          ],
          mcpServers: [
            { id: 'docs', name: 'Docs', transport: 'http', url: 'https://mcp.example.com', headers: {}, hasToken: true },
          ],
        }),
        providerIds: new Set(['existing']),
      }),
    );
    expect(plan.providers.map((item) => [item.provider.id, item.state, item.reason ?? null])).toEqual([
      ['openrouter', 'ready', null],
      ['ollama', 'unavailable', 'local-only'],
      ['existing', 'present', null],
      ['gateway', 'ready', null],
    ]);
    expect(plan.checklist.map((item) => item.id)).toEqual(
      expect.arrayContaining(['provider-key:openrouter', 'local-model:ollama', 'mcp-token:docs', 'provider-connection:gateway']),
    );
    expect(plan.checklist.some((item) => item.id.includes('existing'))).toBe(false);
  });

  it('turns OS-permission tools into checklist items instead of switching them on', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          builtinTools: [
            { id: 'computer', enabled: true },
            { id: 'browser', enabled: false },
            { id: 'docs', enabled: true },
          ],
        }),
        builtinTools: new Map([
          ['browser', { enabled: true, userSet: false }],
          ['docs', { enabled: false, userSet: true }],
        ]),
      }),
    );
    expect(plan.builtinTools.map((item) => [item.id, item.state])).toEqual([
      ['browser', 'ready'],
      ['docs', 'kept'],
    ]);
    expect(plan.checklist.find((item) => item.kind === 'computer-use')).toBeDefined();
  });

  it('only offers to turn access switches on, never off', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({
          access: { remoteControlEnabled: true, remoteDesktopEnabled: true, keepAwake: false },
          hints: { builtinKeys: ['brave'], imChannels: ['telegram'], sshHostCount: 2 },
        }),
        access: { remoteControlEnabled: false, keepAwake: true },
      }),
    );
    expect(plan.access).toEqual([{ key: 'access:remote-control', id: 'remote-control', state: 'ready' }]);
    expect(plan.checklist.map((item) => item.id)).toEqual(
      expect.arrayContaining(['remote-desktop', 'builtin-key:brave', 'im-channel:telegram', 'ssh']),
    );
  });

  it('offers SSH servers only from computers that can authorize a new key, and never twice', () => {
    const hosts = [
      { id: 'web', displayName: 'Web', hostname: 'web.example.com', port: 22, user: 'deploy', hostKey: null },
      { id: 'db', displayName: 'DB', hostname: 'db.example.com', port: 2222, user: 'root', hostKey: null },
    ];
    const current = buildSetupPlan(
      planInputs({ snapshot: snapshot({ transfer: 1, sshHosts: hosts }), sshHostIds: new Set(['db']) }),
    );
    expect(current.sshHosts.map((item) => [item.key, item.state])).toEqual([
      ['ssh:web', 'ready'],
      ['ssh:db', 'present'],
    ]);
    expect(current.checklist.some((item) => item.kind === 'ssh')).toBe(false);
    // An older computer only reports a count: the servers stay a checklist item.
    const older = buildSetupPlan(
      planInputs({ snapshot: snapshot({ sshHosts: hosts, hints: { builtinKeys: [], imChannels: [], sshHostCount: 2 } }) }),
    );
    expect(older.sshHosts).toEqual([]);
    expect(older.secrets).toBeNull();
    expect(older.checklist.map((item) => item.id)).toContain('ssh');
  });

  it('drops interface preferences outside the portable whitelist', () => {
    const plan = buildSetupPlan(
      planInputs({
        snapshot: snapshot({ rendererPrefs: { theme: 'dark', 'sidebar-collapsed': 'true', 'experimental.x': '1' } }),
      }),
    );
    expect(plan.rendererPrefs).toEqual({
      key: 'renderer-prefs',
      state: 'ready',
      values: { theme: 'dark', 'experimental.x': '1' },
    });
  });
});

describe('splitSettingsValues', () => {
  it('compares nested values without caring about key order', () => {
    expect(
      splitSettingsValues({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 2, x: 1 } }),
    ).toEqual({ apply: { b: 1 }, kept: [] });
  });
});

describe('isLocalProvider', () => {
  it('treats any loopback runtime as local to that computer', () => {
    expect(
      isLocalProvider({ id: 'x', name: 'x', auth: 'none', config: { runtimes: { codex: { baseUrl: 'http://localhost:1234/v1' } } } }),
    ).toBe(true);
    expect(
      isLocalProvider({ id: 'x', name: 'x', auth: 'apiKey', config: { runtimes: { codex: { baseUrl: 'https://api.example.com' } } } }),
    ).toBe(false);
  });
});
