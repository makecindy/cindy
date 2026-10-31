import { describe, expect, it } from 'vitest';

import { INVOKE_TIMEOUT_OVERRIDES_MS, REMOTE_INVOKE_ALLOWLIST } from '../allowlist.js';
import { resolveRemoteInvokeTimeoutMs } from '../invokePolicy.js';
import {
  SETUP_SNAPSHOT_CHANNEL,
  SETUP_SNAPSHOT_LIMITS,
  SETUP_SNAPSHOT_TIMEOUT_MS,
  isPortableGitUrl,
  parseSetupSnapshot,
  parseSetupSnapshotRequest,
  setupSnapshotCapsVersion,
} from '../setupSnapshot.js';

const base = {
  version: 1,
  createdAt: 1_760_000_000_000,
  platform: 'darwin',
  settings: [],
  rendererPrefs: {},
  plugins: [],
  marketSources: [],
  skills: [],
  mcpServers: [],
  providers: [],
  builtinTools: [],
  access: { remoteControlEnabled: true, remoteDesktopEnabled: false, keepAwake: true },
  hints: { builtinKeys: ['brave'], imChannels: ['telegram'], sshHostCount: 3 },
  unavailable: [],
};

describe('setup snapshot protocol', () => {
  it('is a read-only same-account channel with a longer budget than the default 30s', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(SETUP_SNAPSHOT_CHANNEL)).toBe(true);
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[SETUP_SNAPSHOT_CHANNEL]).toBe(SETUP_SNAPSHOT_TIMEOUT_MS);
    expect(resolveRemoteInvokeTimeoutMs(SETUP_SNAPSHOT_CHANNEL, [{ action: 'snapshot' }])).toBe(
      SETUP_SNAPSHOT_TIMEOUT_MS,
    );
    expect(parseSetupSnapshotRequest({ action: 'snapshot', path: '/etc' })).toEqual({ action: 'snapshot' });
    // There is no write action: applying always happens on the computer being set up.
    for (const action of ['apply', 'import', 'write', 'secrets']) {
      expect(() => parseSetupSnapshotRequest({ action })).toThrow('SETUP_SNAPSHOT_INVALID');
    }
  });

  it('reads the caps version and treats anything else as unsupported', () => {
    expect(setupSnapshotCapsVersion({ setupSnapshot: 1 })).toBe(1);
    expect(setupSnapshotCapsVersion({ setupSnapshot: '1' })).toBe(0);
    expect(setupSnapshotCapsVersion(null)).toBe(0);
  });

  it('rejects other protocol versions instead of guessing', () => {
    expect(() => parseSetupSnapshot({ ...base, version: 2 })).toThrow('SETUP_SNAPSHOT_INVALID');
    expect(() => parseSetupSnapshot('snapshot')).toThrow('SETUP_SNAPSHOT_INVALID');
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    const parsed = parseSetupSnapshot({
      ...base,
      plugins: [
        {
          ghostId: 'cindy-github',
          name: 'GitHub',
          version: '1.2.0',
          namespace: null,
          pluginId: 'plg_1',
          source: 'market',
          marketName: null,
          enabled: false,
          setupReady: true,
        },
        // A market plugin must carry its market id to be reinstallable.
        { ghostId: 'broken', namespace: null, pluginId: null, source: 'market', enabled: true },
        // Manual installs never claim a market id.
        { ghostId: 'local', namespace: null, pluginId: 'plg_x', source: 'manual', enabled: true },
        { ghostId: 'local-ok', namespace: 'xd', pluginId: null, source: 'manual', enabled: true },
      ],
      skills: [{ name: 'deploy', version: '1.0.0', catalogScope: 'team', origin: 'installed', enabled: true }, { name: '' }],
      unavailable: ['skills', 'secrets', 'skills'],
    });
    expect(parsed.plugins.map((p) => p.ghostId)).toEqual(['cindy-github', 'local-ok']);
    expect(parsed.plugins[0]).toMatchObject({ enabled: false, setupReady: true, namespace: null });
    expect(parsed.plugins[1]).toMatchObject({ namespace: 'xd', pluginId: null, setupReady: null });
    expect(parsed.skills).toEqual([
      { name: 'deploy', version: '1.0.0', catalogScope: 'team', origin: 'installed', enabled: true },
    ]);
    expect(parsed.unavailable).toEqual(['skills']);
    expect(parsed.hints).toEqual({ builtinKeys: ['brave'], imChannels: ['telegram'], sshHostCount: 3 });
  });

  it('never accepts non-JSON or oversized settings values', () => {
    const big = 'x'.repeat(SETUP_SNAPSHOT_LIMITS.settingsGroupBytes);
    const parsed = parseSetupSnapshot({
      ...base,
      settings: [
        { id: 'collaboration', values: { workerSoftLimit: 3 } },
        { id: 'appearance', values: { uiFamily: big } },
        { id: 'bad', values: { n: Number.NaN } },
        { id: '../escape', values: {} },
      ],
    });
    expect(parsed.settings).toEqual([{ id: 'collaboration', values: { workerSoftLimit: 3 } }]);
  });

  it('keeps renderer preferences as bounded strings and reports an unavailable window as null', () => {
    expect(parseSetupSnapshot({ ...base, rendererPrefs: null }).rendererPrefs).toBeNull();
    expect(
      parseSetupSnapshot({ ...base, rendererPrefs: { theme: 'dark', language: 1, 'bad key': 'x' } }).rendererPrefs,
    ).toEqual({ theme: 'dark' });
  });

  it('exports MCP headers but never a token, and requires an http(s) endpoint', () => {
    const parsed = parseSetupSnapshot({
      ...base,
      mcpServers: [
        { id: 'docs', name: 'Docs', transport: 'http', url: 'https://mcp.example.com', headers: { 'X-Team': 'a' }, hasToken: true, token: 'secret' },
        { id: 'file', name: 'File', transport: 'http', url: 'file:///etc/passwd', headers: {} },
      ],
    });
    expect(parsed.mcpServers).toEqual([
      { id: 'docs', name: 'Docs', transport: 'http', url: 'https://mcp.example.com', headers: { 'X-Team': 'a' }, hasToken: true },
    ]);
  });

  it('requires a provider config to describe the same provider id', () => {
    const parsed = parseSetupSnapshot({
      ...base,
      providers: [
        { id: 'openrouter', name: 'OpenRouter', auth: 'apiKey', config: { id: 'openrouter', name: 'OpenRouter', runtimes: {} } },
        { id: 'other', name: 'Other', auth: 'apiKey', config: { id: 'spoofed', runtimes: {} } },
        { id: 'x', name: 'X', auth: 'password', config: { id: 'x', runtimes: {} } },
      ],
    });
    expect(parsed.providers.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('only treats credential-free Git remotes as portable market sources', () => {
    expect(isPortableGitUrl('https://github.com/acme/market.git')).toBe(true);
    expect(isPortableGitUrl('git@github.com:acme/market.git')).toBe(true);
    expect(isPortableGitUrl('ssh://git@github.com/acme/market.git')).toBe(true);
    expect(isPortableGitUrl('https://ghp_token@github.com/acme/market.git')).toBe(false);
    expect(isPortableGitUrl('https://user:pass@github.com/acme/market.git')).toBe(false);
    expect(isPortableGitUrl('/Users/me/markets/local')).toBe(false);
    expect(
      parseSetupSnapshot({
        ...base,
        marketSources: [
          { name: 'acme', url: 'https://github.com/acme/market.git', ref: 'main', sparsePaths: ['plugins'] },
          { name: 'secret', url: 'https://ghp_token@github.com/acme/market.git' },
        ],
      }).marketSources,
    ).toEqual([{ name: 'acme', url: 'https://github.com/acme/market.git', ref: 'main', sparsePaths: ['plugins'] }]);
  });
});
